#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));
const OUTPUT = fileURLToPath(new URL('../dist/', import.meta.url));
const MARKER = '.cottagecode-demo-build';
const SIGNATURE = 'CottageCode public sample build v1\n';
const PUBLIC_ASSETS = new Set(['.mjs', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.wav', '.ogg', '.mp3']);
const SERVER_MODULES = new Set(['feed.mjs', 'hub.mjs', 'messages.mjs', 'transcripts.mjs', 'activity.mjs', 'github.mjs', 'towns.mjs']);
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
const DESCRIPTION = 'A playable sample village for CottageCode. Walk between pixel cottages, meet fictional agents, and explore tasks, journals, and pull request progress.';
const htmlEscape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const within = (root, path) => path === root || path.startsWith(root + sep);
const slash = path => path.split(sep).join('/');

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export function normalizeBase(value = '/cottagecode/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\?#%\s]/.test(value))
    throw new Error('Base must be a plain absolute URL path, such as /cottagecode/ or /.');
  const parts = value.split('/').filter(Boolean);
  if (parts.some(part => !/^[a-zA-Z0-9_-]+$/.test(part)))
    throw new Error('Base path segments may contain letters, numbers, underscores, and hyphens only.');
  return parts.length ? '/' + parts.join('/') + '/' : '/';
}

// A small lexer keeps import-looking comments, strings, templates, and regexes
// out of the dependency graph. Template expressions are scanned as normal code.
function tokensOf(source) {
  const tokens = [];
  let i = 0;
  const push = (kind, value, start, end = i) => tokens.push({ kind, value, start, end });
  const canEndExpression = token => token && (token.kind === 'string' || token.kind === 'literal' ||
    token.kind === 'word' && !new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']).has(token.value) ||
    [')', ']', '}'].includes(token.value));
  function code(untilBrace = false) {
    let depth = 0;
    while (i < source.length) {
      const char = source[i], next = source[i + 1], start = i;
      if (/\s/.test(char)) { i++; continue; }
      if (char === '/' && next === '/') { i = source.indexOf('\n', i + 2); if (i < 0) i = source.length; continue; }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        if (end < 0) throw new Error('Unclosed JavaScript comment.');
        i = end + 2; continue;
      }
      if (char === '"' || char === "'") {
        i++;
        while (i < source.length && source[i] !== char) { if (source[i] === '\\') i++; i++; }
        if (i >= source.length) throw new Error('Unclosed JavaScript string.');
        i++; push('string', source.slice(start + 1, i - 1), start); continue;
      }
      if (char === '`') {
        i++;
        while (i < source.length && source[i] !== '`') {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '$' && source[i + 1] === '{') {
            i += 2; push('punct', '{', i - 1); code(true);
          } else i++;
        }
        if (i >= source.length) throw new Error('Unclosed JavaScript template.');
        i++; push('literal', 'template', start); continue;
      }
      if (char === '/' && !canEndExpression(tokens.at(-1))) {
        let bracket = false;
        i++;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') bracket = true;
          if (source[i] === ']') bracket = false;
          if (source[i] === '/' && !bracket) break;
          i++;
        }
        if (i >= source.length) throw new Error('Unclosed JavaScript regular expression.');
        i++;
        while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
        push('literal', 'regex', start); continue;
      }
      if (/[a-zA-Z_$]/.test(char)) {
        i++;
        while (/[a-zA-Z0-9_$]/.test(source[i] || '') && i < source.length) i++;
        push('word', source.slice(start, i), start); continue;
      }
      if (/[0-9]/.test(char)) {
        i++;
        while (/[a-zA-Z0-9_.]/.test(source[i] || '') && i < source.length) i++;
        push('literal', 'number', start); continue;
      }
      i++;
      push('punct', char, start);
      if (char === '{') depth++;
      if (char === '}') {
        if (untilBrace && depth === 0) return;
        depth--;
      }
    }
    if (untilBrace) throw new Error('Unclosed JavaScript template expression.');
  }
  code();
  return tokens;
}

function moduleReferences(source) {
  const tokens = tokensOf(source), references = [];
  const add = (token, kind) => {
    if (!token || token.kind !== 'string' || token.value.includes('\\'))
      throw new Error('Public module imports and import.meta.url assets must use literal paths without escapes.');
    references.push({ ...token, kind });
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1];
    if (token.kind !== 'word') continue;
    if (token.value === 'import' && tokens[i - 1]?.value !== '.') {
      if (next?.value === '.') continue; // import.meta
      if (next?.kind === 'string') { add(next, 'module'); continue; }
      if (next?.value === '(') {
        add(tokens[i + 2], 'module');
        if (![',', ')'].includes(tokens[i + 3]?.value))
          throw new Error('Dynamic public imports must use a single literal module path.');
        continue;
      }
      let j = i + 1;
      while (j < tokens.length && tokens[j].value !== ';' && tokens[j].value !== 'from') j++;
      if (tokens[j]?.value !== 'from') throw new Error('Unsupported public import declaration.');
      add(tokens[j + 1], 'module');
    }
    if (token.value === 'export' && ['*', '{'].includes(next?.value)) {
      let j = i + 1;
      if (tokens[j].value === '{') {
        while (j < tokens.length && tokens[j].value !== '}') j++;
        j++;
      } else {
        while (j < tokens.length && tokens[j].value !== ';' && tokens[j].value !== 'from') j++;
      }
      if (tokens[j]?.value === 'from') add(tokens[j + 1], 'module');
    }
    if (token.value === 'new' && next?.value === 'URL' && tokens[i + 2]?.value === '(') {
      let j = i + 3;
      while (j < tokens.length && ![',', ')'].includes(tokens[j].value)) j++;
      if (tokens.slice(j, j + 7).map(t => t.value).join('') === ',import.meta.url)') {
        if (j !== i + 4) throw new Error('Public import.meta.url assets must use a single literal path.');
        add(tokens[i + 3], 'asset');
      }
    }
  }
  return references;
}

function replaceRanges(source, changes) {
  for (const change of changes.sort((a, b) => b.start - a.start))
    source = source.slice(0, change.start) + change.value + source.slice(change.end);
  return source;
}

function attribute(tag, name) {
  return tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'))?.slice(1).find(value => value !== undefined);
}

function setAttribute(tag, name, value) {
  const pattern = new RegExp('\\b' + name + '\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i');
  const attr = name + '="' + htmlEscape(value) + '"';
  return pattern.test(tag) ? tag.replace(pattern, attr) : tag.replace(/\s*\/?>$/, end => ' ' + attr + end);
}

async function browserGraph(sourceDir) {
  const sourceRoot = await realpath(sourceDir), files = new Map(), pending = new Set();
  const publicPath = path => './modules/' + path;
  async function resolveAsset(raw, importer, kind) {
    if (!raw || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(raw))
      throw new Error(`Only local browser ${kind}s can be bundled: ${raw}`);
    if (kind === 'module' && !raw.startsWith('.') && !raw.startsWith('/modules/'))
      throw new Error(`Bare or backend module imports cannot be bundled: ${raw}`);
    const split = raw.search(/[?#]/), path = split < 0 ? raw : raw.slice(0, split), suffix = split < 0 ? '' : raw.slice(split);
    if (!/^[a-zA-Z0-9_./-]+$/.test(path)) throw new Error(`Unsupported public asset path: ${raw}`);
    const candidate = path.startsWith('/modules/') ? resolve(sourceRoot, path.slice(9)) :
      path.startsWith('/') ? resolve(sourceRoot, path.slice(1)) : resolve(sourceRoot, dirname(importer), path);
    if (!within(sourceRoot, candidate)) throw new Error(`Public asset leaves the source directory: ${raw}`);
    const resolved = await realpath(candidate);
    if (!within(sourceRoot, resolved)) throw new Error(`Public asset symlink leaves the source directory: ${raw}`);
    const relativePath = slash(relative(sourceRoot, candidate));
    for (const path of [relativePath, slash(relative(sourceRoot, resolved))]) {
      if (path.split('/').some(part => part.startsWith('.')) ||
          /(^|\/)(?:data|snapshots?|transcripts?|private|secrets?)(\/|$)/i.test(path) ||
          SERVER_MODULES.has(posix.basename(path)) || !PUBLIC_ASSETS.has(extname(path)))
        throw new Error(`Backend or data file is not a public asset: ${path}`);
    }
    if (kind === 'module' && !['.mjs', '.js'].includes(extname(relativePath)))
      throw new Error(`Browser module import must point to JavaScript: ${raw}`);
    await visit(relativePath);
    return { path: relativePath, suffix };
  }
  const localReference = (target, importer) => {
    const path = posix.relative(posix.dirname(importer), target.path);
    return (path.startsWith('.') ? path : './' + path) + target.suffix;
  };
  async function cssSource(source, importer, html = false) {
    const changes = [], pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
    for (const match of source.matchAll(pattern)) {
      const raw = match.slice(1).find(value => value !== undefined);
      if (raw.startsWith('#') || /^data:(?:image|font)\//i.test(raw)) continue;
      if (/^https:\/\//i.test(raw) && FONT_HOSTS.has(new URL(raw).hostname)) continue;
      const target = await resolveAsset(raw, importer, 'asset');
      const value = html ? publicPath(target.path) + target.suffix : localReference(target, importer);
      changes.push({ start: match.index, end: match.index + match[0].length,
        value: match[0].startsWith('@') ? '@import "' + value + '"' : 'url("' + value + '")' });
    }
    return replaceRanges(source, changes);
  }
  async function visit(path) {
    if (files.has(path) || pending.has(path)) return;
    pending.add(path);
    let contents = await readFile(join(sourceRoot, path));
    if (['.mjs', '.js'].includes(extname(path))) {
      const source = contents.toString('utf8'), changes = [];
      for (const reference of moduleReferences(source)) {
        const target = await resolveAsset(reference.value, path, reference.kind);
        changes.push({ start: reference.start, end: reference.end, value: JSON.stringify(localReference(target, path)) });
      }
      contents = replaceRanges(source, changes);
    } else if (extname(path) === '.css') contents = await cssSource(contents.toString('utf8'), path);
    files.set(path, contents);
    pending.delete(path);
  }

  let html = await readFile(join(sourceRoot, 'town.html'), 'utf8');
  const changes = [];
  for (const match of html.matchAll(/<(script|link|img|source|video|audio|track|input)\b[^>]*>/gi)) {
    let tag = match[0];
    if (attribute(tag, 'srcset')) throw new Error('Public assets using srcset need an explicit build mapping.');
    for (const name of match[1].toLowerCase() === 'link' ? ['href'] : ['src', 'poster']) {
      const raw = attribute(tag, name);
      if (!raw) continue;
      if (/^https:\/\//i.test(raw) && match[1].toLowerCase() === 'link' && FONT_HOSTS.has(new URL(raw).hostname)) continue;
      if (/^data:image\//i.test(raw) && match[1].toLowerCase() !== 'script') continue;
      const kind = match[1].toLowerCase() === 'script' ? 'module' : 'asset';
      const target = await resolveAsset(raw, 'town.html', kind);
      tag = setAttribute(tag, name, publicPath(target.path) + target.suffix);
    }
    changes.push({ start: match.index, end: match.index + match[0].length, value: tag });
  }
  html = await cssSource(replaceRanges(html, changes), 'town.html', true);
  if (!files.has('town.mjs') || !files.has('runtime.mjs')) throw new Error('The public entry must load town.mjs and its runtime guard.');
  return { files, html };
}

function publicHtml(html, base) {
  const metadata = `<base href="${htmlEscape(base)}">\n<meta name="cottagecode-mode" content="public-demo">\n<meta http-equiv="Content-Security-Policy" content="${htmlEscape(CSP)}">\n<meta name="description" content="${DESCRIPTION}">\n<meta name="theme-color" content="#20272e">\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="CottageCode">\n<meta property="og:title" content="CottageCode — Sample Village">\n<meta property="og:description" content="${DESCRIPTION}">\n<meta name="twitter:card" content="summary">\n`;
  html = html.replace(/<html\b[^>]*>/i, tag => setAttribute(tag, 'data-cottagecode-mode', 'public-demo'));
  html = html.replace(/<title>[^<]*<\/title>/i, '<title>CottageCode — Sample Village</title>');
  html = html.replace(/<meta\s+charset=[^>]*>/i, tag => tag + '\n' + metadata);
  html = html.replace(/<div\s+class="app">/i, tag => tag + '\n  <aside class="sample-village" aria-label="Sample village" style="border:1px solid #6b815d;border-radius:3px;background:#2b382e;padding:10px 12px;color:#dcebd4;font-size:13px"><strong>Sample village</strong> · Fictional agents and activity. Walk around, visit cottages, and explore how CottageCode works.</aside>');
  html = html.replace(/<div\s+class="feed">/i, '<div class="feed" hidden aria-hidden="true">');
  html = html.replace(/<(?:input|button)\b[^>]*\bid="(?:endpoint|connect)"[^>]*>/gi, tag => setAttribute(tag.replace(/>$/, ' disabled>'), 'tabindex', '-1'));
  html = html.replace(/(<p\s+id="note"[^>]*>)[\s\S]*?(<\/p>)/i, '$1Sample village · fictional agents and activity.$2');
  if (!html.includes('class="sample-village"') || !html.includes('class="feed" hidden') || !html.includes('name="cottagecode-mode"'))
    throw new Error('Public HTML landmarks changed; refusing to publish an unlocked or unmarked build.');
  return html;
}

function notFoundHtml(base) {
  return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${htmlEscape(CSP)}"><title>CottageCode · Not found</title><style>body{background:#171d23;color:#e4e9ef;font:16px/1.6 system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:24px}a{color:#b6d9aa}h1{font-size:24px}</style></head><body><h1>This path is outside the sample village.</h1><p>The public village contains fictional cottages. Live agent feeds and server files are not available here.</p><a href="${htmlEscape(base)}">Return to the sample village</a></body></html>\n`;
}

export async function buildDemo({ base = '/cottagecode/', outDir = OUTPUT, sourceDir = SOURCE } = {}) {
  base = normalizeBase(base);
  const sourceRoot = await realpath(sourceDir), outputRoot = resolve(outDir);
  const actualOutput = await canonicalPath(outputRoot);
  if (within(actualOutput, sourceRoot) || within(sourceRoot, actualOutput))
    throw new Error('Build output must be outside the source directory and cannot contain it.');
  try {
    const entry = await lstat(outputRoot);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Build output must be a real directory.');
    const existing = await readdir(outputRoot);
    if (existing.length && (await readFile(join(outputRoot, MARKER), 'utf8').catch(() => '')) !== SIGNATURE)
      throw new Error('Refusing to replace an unrecognized output directory. Choose a new --out directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  // Resolve and validate everything before writing or replacing a previous build.
  const { files, html } = await browserGraph(sourceRoot);
  const indexHtml = publicHtml(html, base);
  await mkdir(dirname(outputRoot), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputRoot), '.cottagecode-demo-'));
  const pageRoot = join(staging, base.slice(1));
  try {
    await mkdir(pageRoot, { recursive: true });
    await writeFile(join(pageRoot, 'index.html'), indexHtml);
    for (const [path, contents] of files) {
      const output = join(pageRoot, 'modules', path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, contents);
    }
    await writeFile(join(staging, '404.html'), notFoundHtml(base));
    await writeFile(join(staging, '_headers'), `/*\n  Content-Security-Policy: ${CSP}; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Cache-Control: public, max-age=0, must-revalidate\n`);
    await writeFile(join(staging, MARKER), SIGNATURE);
    await rm(outputRoot, { recursive: true, force: true });
    await rename(staging, outputRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { base, outDir: outputRoot, indexPath: join(outputRoot, base.slice(1), 'index.html'), files: [...files.keys()].sort() };
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      process.stdout.write('Usage: node scripts/build-demo.mjs [--base /cottagecode/] [--out dist]\nBuild a static sample village with live connections disabled.\n');
      return;
    }
    if (!['--base', '--out'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('Expected --base /path/ or --out directory. Use --help for usage.');
    options[args[i] === '--base' ? 'base' : 'outDir'] = args[++i];
  }
  const result = await buildDemo(options);
  process.stdout.write(`Built sample village at ${result.indexPath} (${result.files.length} browser files, base ${result.base}).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Public demo build failed: ${error.message}\n`); process.exitCode = 1; });

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildDemo, normalizeBase } from '../scripts/build-demo.mjs';
import { isPublicDemoDocument, PUBLIC_DEMO } from '../src/runtime.mjs';
import { isPracticeDemo } from '../src/observatory.mjs';

const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));
const TOWN = await readFile(new URL('../src/town.mjs', import.meta.url), 'utf8');
const FIXTURE_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>CottageCode</title></head><body><div class="app"><div class="feed"><input id="endpoint"><button id="connect">Connect</button><p id="note">Feed</p></div></div><script type="module" src="/modules/town.mjs"></script></body></html>';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cottagecode-public-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(dir, path)); else files.push(path);
  }
  return files.sort();
}
async function fixture(t, entry = '', extra = {}) {
  const root = await temporary(t), sourceDir = join(root, 'src'), outDir = join(root, 'public');
  for (const [path, contents] of Object.entries({
    'town.html': FIXTURE_HTML, 'town.mjs': 'import "./runtime.mjs";\n' + entry,
    'runtime.mjs': 'export const PUBLIC_DEMO = true;', ...extra,
  })) await write(join(sourceDir, path), contents);
  return { root, sourceDir, outDir };
}

test('public flag is declared by the document, not a query string or absent browser globals', () => {
  assert.equal(PUBLIC_DEMO, false);
  assert.equal(isPublicDemoDocument(null), false);
  assert.equal(isPublicDemoDocument({ location: { search: '?demo=1&public-demo=true' } }), false);
  const fromMeta = { querySelector: selector => selector === 'meta[name="cottagecode-mode"]' ? { content: 'public-demo' } : null };
  assert.equal(isPublicDemoDocument(fromMeta), true);
  assert.equal(isPublicDemoDocument({ documentElement: { dataset: { cottagecodeMode: 'public-demo' } } }), true);
  assert.equal(isPublicDemoDocument({ documentElement: { dataset: { cottagecodeMode: 'live' } } }), false);
});

test('default build contains the complete browser graph and no backend or local data', async t => {
  const outDir = join(await temporary(t), 'public');
  const result = await buildDemo({ outDir });
  assert.equal(result.base, '/cottagecode/');
  const html = await readFile(result.indexPath, 'utf8');
  assert.match(html, /<base href="\/cottagecode\/">/);
  assert.match(html, /data-cottagecode-mode="public-demo"/);
  assert.match(html, /name="cottagecode-mode" content="public-demo"/);
  assert.match(html, /<title>CottageCode — Sample Village<\/title>/);
  assert.match(html, /property="og:description"/);
  assert.match(html, /class="sample-village"[^>]*>[\s\S]*?Fictional agents and activity/);
  assert.match(html, /class="feed" hidden aria-hidden="true"/);
  for (const id of ['endpoint', 'connect']) assert.match(html, new RegExp('<[^>]+id="' + id + '"[^>]+disabled[^>]*>'));
  assert.match(html, /src="\.\/modules\/town\.mjs"/);
  assert.doesNotMatch(html, /(?:src|href)="\/modules\//);
  for (const name of ['town', 'runtime', 'observatory', 'interiors', 'world', 'pr', 'history', 'sound', 'occupancy', 'feed-client'])
    assert.ok(result.files.includes(name + '.mjs'), name + ' should be included');
  const all = await listFiles(outDir), bundled = new Set(result.files);
  assert.deepEqual(all.filter(path => path.includes('/modules/')).map(path => path.slice('cottagecode/modules/'.length)).sort(), result.files);
  assert.doesNotMatch(all.join('\n'), /(?:^|\/)(?:feed|hub|messages|transcripts|activity|github|towns)\.mjs|\.jsonl?$|\.sqlite$|\.env|snapshot|secret/i);
  for (const path of result.files) {
    const content = await readFile(join(outDir, 'cottagecode/modules', path), 'utf8');
    assert.doesNotMatch(content, /(?:from\s*|import\s*)["']node:|\/Users\//);
    // Every actual source module currently uses these static ESM forms.
    for (const match of content.matchAll(/\b(?:import|export)\s+(?:[\w$\s{},*]+?\s+from\s*)?["']([^"']+)["']/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      assert.ok(bundled.has(target), path + ' is missing its dependency ' + target);
    }
  }
  assert.deepEqual(all.filter(path => !path.includes('/modules/')), ['.cottagecode-demo-build', '404.html', '_headers', 'cottagecode/index.html']);
});

test('headers deny live connections and 404 is a standalone response, not a town fallback', async t => {
  const outDir = join(await temporary(t), 'public');
  const result = await buildDemo({ outDir, base: '/' });
  const [html, headers, notFound] = await Promise.all([
    readFile(result.indexPath, 'utf8'), readFile(join(outDir, '_headers'), 'utf8'), readFile(join(outDir, '404.html'), 'utf8'),
  ]);
  assert.equal(result.indexPath, join(outDir, 'index.html'));
  assert.match(html, /<base href="\/">/);
  assert.match(html, /src="\.\/modules\/town\.mjs"/);
  assert.match(headers, /^\/\*\n/);
  for (const directive of ["connect-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "form-action 'none'"])
    assert.ok(headers.includes(directive));
  assert.match(headers, /https:\/\/fonts.googleapis.com/);
  assert.match(headers, /https:\/\/fonts.gstatic.com/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(html, /http-equiv="Content-Security-Policy"[^>]*connect-src &#39;none&#39;/);
  assert.match(notFound, /Not found/);
  assert.match(notFound, /href="\/"/);
  assert.doesNotMatch(notFound, /town\.mjs|id="town"|<script/i);
});

test('nested prefixes, transitive modules, literal lazy imports, and static assets remain relative', async t => {
  const paths = await fixture(t, 'import "./views/cottage.mjs";', {
    'views/cottage.mjs': `export { lamp } from './lamp.mjs';
      export const image = new URL('../art/lamp.svg', import.meta.url);
      export const lazy = () => import('/modules/lazy.mjs');
      const fake = "import './feed.mjs'";
      const text = \`import './messages.mjs'\`;
      const regex = /import[\\s]+['"]node:fs['"]/;
      // import './hub.mjs';
      /* export * from './transcripts.mjs'; */`,
    'views/lamp.mjs': 'export const lamp = true;', 'lazy.mjs': 'export const lazy = true;',
    'art/lamp.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>',
    'unused.mjs': 'import "node:fs";', '.env': 'DO_NOT_COPY=private', 'snapshot.json': '{"private":true}',
  });
  const result = await buildDemo({ ...paths, base: '/preview/cottagecode/' });
  assert.deepEqual(result.files, ['art/lamp.svg', 'lazy.mjs', 'runtime.mjs', 'town.mjs', 'views/cottage.mjs', 'views/lamp.mjs']);
  const module = await readFile(join(paths.outDir, 'preview/cottagecode/modules/views/cottage.mjs'), 'utf8');
  assert.match(module, /import\("\.\.\/lazy\.mjs"\)/);
  assert.match(module, /new URL\("\.\.\/art\/lamp\.svg", import.meta.url\)/);
  assert.match(await readFile(result.indexPath, 'utf8'), /<base href="\/preview\/cottagecode\/">/);
});

test('CSS and HTML assets follow the same graph, including CSS imports and URL images', async t => {
  const paths = await fixture(t, '', {
    'town.html': FIXTURE_HTML.replace('</head>', '<link rel="stylesheet" href="/styles/main.css"></head>').replace('</body>', '<img src="art/lamp.svg" alt="Lamp"></body>'),
    'styles/main.css': '@import "./palette.css"; body{background-image:url("../art/lamp.svg")}',
    'styles/palette.css': ':root{--ink:#fff}', 'art/lamp.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  const result = await buildDemo(paths);
  assert.ok(result.files.includes('styles/main.css'));
  assert.ok(result.files.includes('styles/palette.css'));
  const html = await readFile(result.indexPath, 'utf8');
  assert.match(html, /href="\.\/modules\/styles\/main\.css"/);
  assert.match(html, /src="\.\/modules\/art\/lamp\.svg"/);
  assert.match(await readFile(join(paths.outDir, 'cottagecode/modules/styles/main.css'), 'utf8'), /url\("\.\.\/art\/lamp\.svg"\)/);
});

test('backend, private, outside, remote, and computed dependencies fail before publishing', async t => {
  for (const [name, entry, extra] of [
    ['node', 'import "node:fs";', {}],
    ['bare', 'import "some-package";', {}],
    ['backend', 'import "./feed.mjs";', { 'feed.mjs': 'export const privateData = 1;' }],
    ['data', 'import "./snapshot.json";', { 'snapshot.json': '{}' }],
    ['private-directory', 'import "./private/code.mjs";', { 'private/code.mjs': 'export const secret = true;' }],
    ['outside', 'import "../outside.mjs";', { '../outside.mjs': 'export const privateData = 1;' }],
    ['remote', 'import "https://example.com/code.mjs";', {}],
    ['computed', 'export const load = name => import(name);', {}],
    ['computed-literal', 'export const load = name => import("./" + name);', {}],
    ['computed-asset', 'const url = new URL("./image.svg" + name, import.meta.url);', { 'image.svg': '<svg/>' }],
  ]) {
    await t.test(name, async t => {
      const paths = await fixture(t, entry, extra);
      await assert.rejects(buildDemo(paths), /(?:public|backend|module|source|literal)/i);
      await assert.rejects(readdir(paths.outDir), { code: 'ENOENT' });
    });
  }
});

test('symlinks cannot smuggle outside files or a backend under an innocent filename', async t => {
  for (const outside of [true, false]) {
    const paths = await fixture(t, 'import "./innocent.mjs";');
    const target = outside ? join(paths.root, 'outside.mjs') : join(paths.sourceDir, 'activity.mjs');
    await write(target, 'export const privateData = true;');
    await symlink(target, join(paths.sourceDir, 'innocent.mjs'));
    await assert.rejects(buildDemo(paths), /(?:symlink|Backend or data)/);
    await assert.rejects(readdir(paths.outDir), { code: 'ENOENT' });
  }
});

test('rebuilding removes obsolete public files but never replaces an unrelated directory', async t => {
  const paths = await fixture(t, 'import "./removed.mjs";', { 'removed.mjs': 'export const unused = true;' });
  await buildDemo(paths);
  await write(join(paths.sourceDir, 'town.mjs'), 'import "./runtime.mjs";');
  const result = await buildDemo(paths);
  assert.equal(result.files.includes('removed.mjs'), false);
  assert.equal((await listFiles(paths.outDir)).some(path => path.endsWith('/removed.mjs')), false);
  const unrelated = join(paths.root, 'unrelated');
  await write(join(unrelated, 'keep.txt'), 'Keep this file.');
  await assert.rejects(buildDemo({ ...paths, outDir: unrelated }), /unrecognized output directory/);
  assert.equal(await readFile(join(unrelated, 'keep.txt'), 'utf8'), 'Keep this file.');
  await assert.rejects(buildDemo({ ...paths, outDir: paths.root }), /cannot contain/);
  await assert.rejects(buildDemo({ ...paths, outDir: join(paths.sourceDir, 'dist') }), /outside the source/);
});

test('base path cannot contain a host, traversal, HTML, query, or ambiguous escapes', () => {
  for (const base of ['https://example.com/', '//example.com/', '/..', '/one/../two/', '/a?b/', '/a#b/', '/a%2Fb/', '/a\\b/', '/a"b/', 'relative/'])
    assert.throws(() => normalizeBase(base), /Base/);
  assert.equal(normalizeBase('/'), '/');
  assert.equal(normalizeBase('/preview/v2'), '/preview/v2/');
});

function controllerHarness({ publicDemo = true, search = '', endpoint = 'https://live.example/agents', feedResponse } = {}) {
  const feed = { hidden: false }, listeners = new Map();
  const box = { value: endpoint, disabled: false, closest: () => feed, addEventListener: (name, fn) => listeners.set(name, fn) };
  const connect = { disabled: false, onclick: null, click() { this.onclick(); } };
  const snapshot = [{ id: 'sample-resident' }], notes = [], requests = [], refreshes = [], resets = [];
  const context = vm.createContext({
    PUBLIC_DEMO: publicDemo, ENDPOINT: endpoint, LIVE: true, feedStale: true, builtInDemo: false,
    FEED_META: {}, DEMO_META: { source: 'demo' }, SIM: { snapshot: () => snapshot },
    document: { getElementById: id => id === 'endpoint' ? box : connect },
    location: { origin: 'https://sample.example', href: 'https://sample.example/cottagecode/' + search, protocol: 'https:', search },
    URL, URLSearchParams, AbortSignal, AbortController, activeFeedAbort: null, feedRevision: 0,
    readCurrentFeed: async (...args) => { requests.push(args); return feedResponse || { kind: 'error', error: new Error('No live source should be reached.') }; },
    feedNote: (...args) => notes.push(args), refresh: () => refreshes.push('refresh'),
    isAllowedFeedUrl: value => /^https?:\/\//.test(value), stableLayout: { reset: () => resets.push('reset') },
    snapshotForEndpoint: ({ snapshot, endpoint: observed }, requested) => observed === requested ? snapshot : null,
    lastSnapshot: null, lastEndpoint: null, layoutSignature: 'preserved', agents: [],
  });
  context.clearFeedState = () => {
    context.lastSnapshot = null;
    context.lastEndpoint = null;
    context.FEED_META = { source: 'none', relationships: [], handoffs: [] };
  };
  const fetchStart = TOWN.indexOf('async function fetchAgents(){'), fetchEnd = TOWN.indexOf('/* ---- mock world ---- */', fetchStart);
  assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, 'Fetch section should be testable');
  vm.runInContext(TOWN.slice(fetchStart, fetchEnd), context);
  const connectStart = TOWN.indexOf('document.getElementById("connect").onclick'), connectEnd = TOWN.indexOf('document.getElementById("settled").onclick', connectStart);
  assert.ok(connectStart >= 0 && connectEnd > connectStart, 'Connect section should be testable');
  vm.runInContext(TOWN.slice(connectStart, connectEnd), context);
  const bootStart = TOWN.indexOf('(function boot(){'), bootEnd = TOWN.indexOf('\nrefresh();', bootStart);
  assert.ok(bootStart >= 0 && bootEnd > bootStart, 'Boot section should be testable');
  return { context, feed, box, connect, snapshot, notes, requests, refreshes, resets, listeners,
    boot() { vm.runInContext(TOWN.slice(bootStart, bootEnd), context); } };
}

test('public boot, connection controls, and fetch are locked to sample data despite query parameters', async () => {
  for (const search of ['', '?endpoint=https://live.example/agents', '?feed=http://127.0.0.1:8787/agents', '?demo=0&endpoint=https://live.example', '?mode=live&public-demo=false']) {
    const h = controllerHarness({ search });
    h.boot();
    assert.equal(h.context.ENDPOINT, null, search);
    assert.equal(h.box.value, '');
    assert.equal(h.box.disabled, true);
    assert.equal(h.connect.disabled, true);
    assert.equal(h.feed.hidden, true);
    // Even an invoked handler or an accidentally assigned endpoint cannot fetch.
    h.box.value = 'https://live.example/agents';
    h.connect.onclick();
    h.box.value = 'http://127.0.0.1:8787/agents';
    h.listeners.get('keydown')({ key: 'Enter' });
    h.context.ENDPOINT = 'https://live.example/agents';
    assert.equal(await h.context.fetchAgents(), h.snapshot);
    assert.equal(h.context.ENDPOINT, null);
    assert.equal(h.context.LIVE, false);
    assert.equal(h.context.feedStale, false);
    assert.equal(h.context.FEED_META.source, 'demo');
    assert.equal(h.requests.length, 0);
    assert.equal(h.refreshes.length, 0);
    assert.equal(h.resets.length, 0);
  }
});

test('local builds retain explicit connect, query prefill, and their default local feed', async () => {
  const normal = controllerHarness({ publicDemo: false });
  normal.boot();
  assert.equal(normal.context.ENDPOINT, 'https://sample.example/agents');
  assert.equal(normal.box.disabled, false);
  assert.equal(normal.feed.hidden, false);
  await normal.context.fetchAgents();
  assert.equal(normal.requests.length, 1);
  const prefilled = controllerHarness({ publicDemo: false, search: '?endpoint=https://custom.example/agents' });
  prefilled.boot();
  assert.equal(prefilled.context.ENDPOINT, null);
  assert.equal(prefilled.box.value, 'https://custom.example/agents');
  assert.equal(prefilled.requests.length, 0);
  prefilled.connect.onclick();
  assert.equal(prefilled.context.ENDPOINT, 'https://custom.example/agents');
  assert.equal(prefilled.refreshes.length, 1);
  const demo = controllerHarness({ publicDemo: false, search: '?demo=1' });
  demo.boot();
  assert.equal(demo.context.ENDPOINT, null);
  assert.equal(await demo.context.fetchAgents(), demo.snapshot);
});

test('an empty bundled local feed keeps its endpoint while enabling demo conversations', async () => {
  const snapshot = [{ id: 'practice-resident', source: 'demo', inputRequest: { id: 'scope', prompt: 'Choose a scope.' } }];
  const local = controllerHarness({
    publicDemo: false,
    endpoint: 'https://sample.example/agents',
    feedResponse: { kind: 'data', data: { stale: false, source: 'none', agents: [] } },
  });
  local.snapshot.splice(0, 1, ...snapshot);

  assert.equal(await local.context.fetchAgents(), local.snapshot);
  assert.equal(local.context.ENDPOINT, 'https://sample.example/agents');
  assert.equal(local.context.builtInDemo, true);
  assert.equal(isPracticeDemo(local.snapshot[0], local.context.builtInDemo), true);
});

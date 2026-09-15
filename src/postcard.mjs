import { createInterior, renderInterior, renderResident, INTERIOR_WIDTH, INTERIOR_HEIGHT } from './interiors.mjs';
import { villageTime, paintRoomAtmosphere } from './atmosphere.mjs';

export const POSTCARD_WIDTH = 400;
export const POSTCARD_HEIGHT = 280;
const PAPER = '#f8edcf';
const INK = '#354d43';
const MUTED = '#746d56';
const GREEN = '#6d9485';
const CORAL = '#bc7965';
const PHASES = new Set(['morning', 'day', 'dusk', 'night']);
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const graphemes = value => segmenter ? Array.from(segmenter.segment(value), part => part.segment) : Array.from(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function text(value, limit = 240) {
  if (typeof value !== 'string') return '';
  let clean = value.slice(0, 8192);
  clean = typeof clean.toWellFormed === 'function' ? clean.toWellFormed() : Array.from(clean, char => /^[\uD800-\uDFFF]$/.test(char) ? '\uFFFD' : char).join('');
  clean = clean.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/gu, ' ').trim().normalize('NFC');
  const parts = graphemes(clean);
  return parts.length > limit ? parts.slice(0, limit - 1).join('') + '…' : clean;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = value instanceof Date ? value.getTime() : typeof value === 'number' ? value :
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T| |$)/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 253402300799999 ? number : null;
}

function calendar(value) {
  const ms = timestamp(value);
  if (ms === null) return { timestamp: null, iso: 'undated', label: 'Date not supplied' };
  const date = new Date(ms), month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][date.getUTCMonth()];
  return { timestamp: ms, iso: date.toISOString().slice(0, 10), label: `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}` };
}

function slug(value, fallback, length) {
  return text(value, 100).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, length).replace(/^-+|-+$/g, '') || fallback;
}

/** Portable basename only; source paths, IDs and task text never enter filenames. */
export function postcardFilename({ agent = {}, now = Date.now() } = {}) {
  const source = object(agent);
  return `cottagecode-${slug(source.town || source.role, 'town', 30)}-${slug(source.name, 'resident', 40)}-${calendar(now).iso}.png`;
}

function artifactLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // A printed link is a location, not a transport for signed query strings.
    url.search = ''; url.hash = '';
    return { url: url.href, label: text(url.host + url.pathname.replace(/\/$/, ''), 160) };
  } catch { return null; }
}

/** Plain text, safe for canvas. HTML previews must use textContent or escape it. */
export function buildPostcardModel({ agent = {}, milestone = null, now = Date.now(), timeState = null } = {}) {
  const source = object(agent), date = calendar(now), selected = object(milestone);
  const milestoneText = text(selected.text, 240), recorded = calendar(selected.timestamp);
  const link = milestoneText ? artifactLink(selected.url) : null;
  const phase = typeof timeState === 'string' && PHASES.has(timeState) ? timeState :
    Number.isFinite(timeState?.hour) ? timeState.hour :
      PHASES.has(timeState?.phase) ? timeState.phase : date.timestamp === null ? 'day' : new Date(date.timestamp);
  return {
    brand: 'CottageCode', resident: text(source.name, 48) || 'A village resident',
    town: text(source.town || source.role, 48) || 'The village',
    capturedAt: date.timestamp, dateISO: date.iso, dateLabel: date.label,
    filename: postcardFilename({ agent: source, now }),
    timeState: { ...villageTime(phase) },
    // Deliberately never infer a milestone from agent.status, result, or events.
    milestone: milestoneText ? { text: milestoneText, timestamp: recorded.timestamp,
      dateLabel: recorded.label, url: link?.url || '', linkLabel: link?.label || '' } : null,
  };
}

/** Bounded wrapping keeps emoji clusters intact and never paints outside a column. */
export function wrapPostcardText(value, measure, width, maxLines = 1) {
  if (typeof measure !== 'function' || !Number.isFinite(width) || width <= 0 || !Number.isFinite(maxLines) || maxLines < 1) return [];
  const cap = Math.min(12, Math.floor(maxLines));
  let remaining = graphemes(text(value, 1000));
  const lines = [], fits = line => { const size = measure(line); return Number.isFinite(size) && size <= width; };
  const ellipsis = value => {
    const parts = graphemes(value.trimEnd());
    while (parts.length && !fits(parts.join('') + '…')) parts.pop();
    return fits(parts.join('') + '…') ? parts.join('') + '…' : '';
  };
  while (remaining.length && lines.length < cap) {
    let count = 0;
    while (count < remaining.length && fits(remaining.slice(0, count + 1).join(''))) count++;
    if (count === remaining.length) { lines.push(remaining.join('').trimEnd()); break; }
    if (!count) { const end = ellipsis(''); if (end) lines.push(end); break; }
    let end = count;
    if (lines.length < cap - 1 && !/\s/u.test(remaining[count])) {
      for (let i = count - 1; i > 0; i--) {
        if (/\s/u.test(remaining[i])) { end = i; break; }
        if (remaining[i] === '/') { end = i + 1; break; }
      }
    }
    const line = remaining.slice(0, end).join('').trimEnd();
    remaining = remaining.slice(end);
    while (remaining.length && /\s/u.test(remaining[0])) remaining.shift();
    lines.push(lines.length === cap - 1 && remaining.length ? ellipsis(line) : line);
  }
  return lines.filter(Boolean);
}

function rect(ctx, x, y, width, height, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

function words(ctx, value, x, y, width, { size = 7, lines = 1, lineHeight = size + 3, color = INK } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${size}px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const wrapped = wrapPostcardText(value, line => ctx.measureText(line).width, width, lines);
  wrapped.forEach((line, index) => ctx.fillText(line, Math.round(x), Math.round(y + index * lineHeight)));
}

function stamp(ctx, phase) {
  const x = 320, y = 24, w = 60, h = 69;
  const lettering = phase === 'night' ? '#f8edcf' : INK;
  rect(ctx, x + 2, y + 2, w, h, '#cbbd97');
  rect(ctx, x, y, w, h, '#fff8e4');
  for (let dx = 3; dx < w; dx += 7) for (const yy of [y, y + h - 2]) rect(ctx, x + dx, yy, 2, 2, PAPER);
  for (let dy = 3; dy < h; dy += 7) for (const xx of [x, x + w - 2]) rect(ctx, xx, y + dy, 2, 2, PAPER);
  rect(ctx, x + 5, y + 5, w - 10, h - 10, GREEN);
  rect(ctx, x + 7, y + 7, w - 14, h - 14, phase === 'night' ? '#465967' : '#bed3c0');
  words(ctx, 'VILLAGE POST', x + 10, y + 11, w - 20, { size: 4.5, color: lettering });
  rect(ctx, x + 10, y + 43, 40, 7, '#8aadae');
  rect(ctx, x + 14, y + 39, 32, 15, '#9bbcbc');
  rect(ctx, x + 17, y + 46, 26, 1, '#d6e3cf');
  // One postal duck, assembled from pixels rather than an external image.
  rect(ctx, x + 16, y + 32, 4, 5, '#fff4d0');
  rect(ctx, x + 19, y + 35, 25, 8, '#fff4d0');
  rect(ctx, x + 23, y + 41, 17, 3, '#e1d4ae');
  rect(ctx, x + 33, y + 25, 10, 14, '#fff4d0');
  rect(ctx, x + 32, y + 28, 12, 7, '#fff4d0');
  rect(ctx, x + 42, y + 30, 7, 3, '#c99551');
  rect(ctx, x + 39, y + 28, 2, 2, '#334739');
  rect(ctx, x + 24, y + 37, 11, 3, '#e1d4ae');
  words(ctx, 'ONE SMALL HELLO', x + 10, y + 56, w - 20, { size: 4, color: lettering });
}

function drawCard(ctx, scene, room, model) {
  ctx.save();
  try {
    ctx.imageSmoothingEnabled = false;
    rect(ctx, 0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT, '#e0d0ac');
    rect(ctx, 4, 4, POSTCARD_WIDTH - 8, POSTCARD_HEIGHT - 8, INK);
    rect(ctx, 6, 6, POSTCARD_WIDTH - 12, POSTCARD_HEIGHT - 12, PAPER);
    for (let x = 12; x < POSTCARD_WIDTH - 14; x += 14) {
      rect(ctx, x, 9, 7, 2, x % 28 < 14 ? GREEN : CORAL);
      rect(ctx, x, POSTCARD_HEIGHT - 11, 7, 2, x % 28 < 14 ? CORAL : GREEN);
    }
    for (let y = 18; y < POSTCARD_HEIGHT - 15; y += 14) {
      rect(ctx, 9, y, 2, 6, GREEN); rect(ctx, POSTCARD_WIDTH - 11, y, 2, 6, CORAL);
    }
    words(ctx, model.brand, 21, 22, 236, { size: 17 });
    words(ctx, 'A LITTLE HOME IN THE VILLAGE', 22, 43, 232, { size: 5.5, color: MUTED });
    rect(ctx, 17, 55, 246, 182, '#d6c6a0');
    rect(ctx, 15, 52, 246, 182, INK);
    rect(ctx, 16, 53, 244, 180, '#fff8e1');
    ctx.drawImage(scene, 18, 55);
    words(ctx, model.town, 22, 241, 237, { size: 10 });
    words(ctx, model.dateLabel + (model.capturedAt === null ? '' : ' · UTC'), 22, 257, 237, { size: 6, color: MUTED });
    for (let y = 20; y < 260; y += 6) rect(ctx, 269, y, 1, 2, '#c6b893');
    // The portrait is the very same generated resident as the furnished room.
    rect(ctx, 278, 28, 32, 62, '#d6c6a0');
    rect(ctx, 276, 26, 32, 62, INK);
    rect(ctx, 277, 27, 30, 60, '#e2d9b9');
    rect(ctx, 279, 69, 26, 13, '#c7c79e');
    renderResident(ctx, 292, 75, room.resident, { scale: 2, reduce: true });
    words(ctx, 'RESIDENT', 280, 80, 26, { size: 4 });
    stamp(ctx, model.timeState.phase);
    words(ctx, 'FROM', 280, 101, 98, { size: 6, color: MUTED });
    words(ctx, model.resident, 280, 113, 98, { size: 9, lines: 2, lineHeight: 11 });
    rect(ctx, 280, 140, 98, 1, '#d1c19a');
    if (model.milestone) {
      words(ctx, 'RECORDED MOMENT', 280, 149, 98, { size: 5.5, color: MUTED });
      words(ctx, model.milestone.text, 280, 161, 98, { size: 7, lines: 5, lineHeight: 9 });
      words(ctx, model.milestone.dateLabel + (model.milestone.timestamp === null ? '' : ' UTC'), 280, 213, 98, { size: 5.5, color: MUTED });
      if (model.milestone.linkLabel) words(ctx, model.milestone.linkLabel, 280, 227, 98, { size: 5.5, lines: 2, lineHeight: 8, color: GREEN });
    } else {
      words(ctx, text(room.themeLabel, 80), 280, 150, 98, { size: 8, lines: 3, lineHeight: 11 });
      words(ctx, 'A small hello from this corner of the village.', 280, 192, 98, { size: 7, lines: 4, lineHeight: 10, color: MUTED });
    }
    rect(ctx, 280, 252, 3, 3, CORAL);
    words(ctx, text(model.timeState.label, 40), 289, 251, 89, { size: 5.5, color: MUTED });
  } finally { ctx.restore(); }
}

function domCanvas() {
  if (!globalThis.document?.createElement) throw new Error('Postcards need a browser canvas.');
  return document.createElement('canvas');
}

function pngBlob(canvas, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') { reject(new Error('This browser cannot save a postcard PNG.')); return; }
    const timer = setTimeout(() => reject(new Error('The postcard PNG took too long to encode. Try again.')), timeoutMs);
    try {
      canvas.toBlob(blob => {
        clearTimeout(timer);
        if (!blob || blob.type !== 'image/png' || !Number.isFinite(blob.size) || blob.size <= 0) reject(new Error('The browser could not create the postcard PNG. Try again.'));
        else resolve(blob);
      }, 'image/png');
    } catch {
      clearTimeout(timer);
      reject(new Error('The browser could not export the postcard canvas. Try again.'));
    }
  });
}

/**
 * Detached canvases only: no DOM capture, network, upload or automatic download.
 * At most 1600×1120 output pixels; the two small drawing surfaces are released.
 * Pass exactly one deliberately chosen recorded milestone, or leave it null.
 */
export async function createPostcard(options = {}, { createCanvas = domCanvas, toBlobTimeoutMs = 8000 } = {}) {
  const { agent = {}, milestone = null, now = Date.now(), timeState = null } = options;
  const model = buildPostcardModel({ agent, milestone, now, timeState });
  const scale = Number.isFinite(options.scale) ? Math.max(1, Math.min(4, Math.round(options.scale))) : 3;
  const width = POSTCARD_WIDTH * scale, height = POSTCARD_HEIGHT * scale;
  const supplied = options.room;
  const room = supplied?.width === INTERIOR_WIDTH && supplied?.height === INTERIOR_HEIGHT ? supplied : createInterior(object(agent));
  const canvases = [];
  function surface(w, h) {
    const canvas = createCanvas();
    if (!canvas) throw new Error('A postcard canvas could not be created.');
    canvases.push(canvas); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext?.('2d', { alpha: false });
    if (!ctx) throw new Error('A postcard canvas could not be created.');
    ctx.imageSmoothingEnabled = false;
    return { canvas, ctx };
  }
  try {
    const scene = surface(INTERIOR_WIDTH, INTERIOR_HEIGHT);
    // Only generated furniture and appearance enter this render. Live requests,
    // results, status, PR details and artifacts stay out even if supplied on agent.
    renderInterior(scene.ctx, room, { agent: {}, time: 0, reduce: true });
    paintRoomAtmosphere(scene.ctx, room, model.timeState, { time: 0, reduce: true });
    const card = surface(POSTCARD_WIDTH, POSTCARD_HEIGHT);
    drawCard(card.ctx, scene.canvas, room, model);
    const output = surface(width, height);
    rect(output.ctx, 0, 0, width, height, PAPER);
    output.ctx.drawImage(card.canvas, 0, 0, width, height);
    const timeout = Number.isFinite(toBlobTimeoutMs) ? Math.max(1, Math.min(10000, toBlobTimeoutMs)) : 8000;
    const blob = await pngBlob(output.canvas, timeout);
    return { blob, filename: model.filename, width, height, model };
  } finally {
    for (const canvas of canvases) { canvas.width = 0; canvas.height = 0; }
  }
}

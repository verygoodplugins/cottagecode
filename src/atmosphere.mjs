/** Decorative light only: no task data, status, collision, or geometry changes. */
import { hauntStage, paintHauntGhost, paintRoomDust } from './folklore.mjs';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = value => value * value * (3 - 2 * value);
const color = (rgb, alpha = 1) => `rgba(${rgb.map(Math.round).join(',')},${clamp(alpha).toFixed(4)})`;
const PHASES = Object.freeze({ morning: 7, day: 12, dusk: 19, night: 23 });
const LIMITS = Object.freeze({ ponds: 6, trees: 12, particles: 40, litCottages: 96, plots: 256 });

// Neighboring keyframes interpolate smoothly, including across midnight.
// Darkness drives a real palette change; it is not a translucent navy veil.
const LIGHT = [
  { hour: 0, darkness: .52, warmth: 0, windowGlow: 1, fireflies: 1, windowShade: 1, tint: [22, 37, 70], sky: [26, 40, 70] },
  { hour: 4, darkness: .52, warmth: 0, windowGlow: 1, fireflies: .85, windowShade: 1, tint: [22, 37, 70], sky: [34, 49, 81] },
  { hour: 5, darkness: .21, warmth: .25, windowGlow: .4, fireflies: .15, windowShade: .7, tint: [100, 104, 127], sky: [115, 137, 157] },
  { hour: 7, darkness: .025, warmth: .4, windowGlow: 0, fireflies: 0, windowShade: .12, tint: [183, 139, 95], sky: [187, 198, 184] },
  { hour: 9, darkness: 0, warmth: 0, windowGlow: 0, fireflies: 0, windowShade: 0, tint: [50, 75, 94], sky: [157, 191, 194] },
  { hour: 16, darkness: 0, warmth: 0, windowGlow: 0, fireflies: 0, windowShade: 0, tint: [50, 75, 94], sky: [157, 191, 194] },
  { hour: 17, darkness: .055, warmth: .45, windowGlow: .1, fireflies: 0, windowShade: .2, tint: [163, 101, 92], sky: [210, 174, 150] },
  { hour: 19, darkness: .26, warmth: .65, windowGlow: .75, fireflies: .45, windowShade: .82, tint: [86, 64, 99], sky: [115, 98, 135] },
  { hour: 21, darkness: .52, warmth: .15, windowGlow: 1, fireflies: 1, windowShade: 1, tint: [22, 37, 70], sky: [35, 49, 81] },
  { hour: 24, darkness: .52, warmth: 0, windowGlow: 1, fireflies: 1, windowShade: 1, tint: [22, 37, 70], sky: [26, 40, 70] },
];

/**
 * Read the local device clock by default. Explicit hours wrap at 24, while a
 * phase string chooses its representative hour. Invalid inputs use noon.
 * Animation time in the painters is separate, and is measured in seconds.
 */
export function villageTime(input = new Date()) {
  let hour, source;
  if (input instanceof Date && finite(input.getTime())) {
    hour = input.getHours() + input.getMinutes() / 60 + input.getSeconds() / 3600 + input.getMilliseconds() / 3600000;
    source = 'device-clock';
  } else if (finite(input)) {
    hour = ((input % 24) + 24) % 24;
    source = 'hour';
  } else if (typeof input === 'string' && Object.hasOwn(PHASES, input)) {
    hour = PHASES[input]; source = 'phase';
  } else { hour = 12; source = 'fallback'; }
  const phase = hour >= 5 && hour < 9 ? 'morning' : hour >= 9 && hour < 17 ? 'day' : hour >= 17 && hour < 21 ? 'dusk' : 'night';
  const phaseProgress = phase === 'morning' ? (hour - 5) / 4 : phase === 'day' ? (hour - 9) / 8 :
    phase === 'dusk' ? (hour - 17) / 4 : (hour >= 21 ? hour - 21 : hour + 3) / 8;
  const i = LIGHT.findIndex((frame, index) => index < LIGHT.length - 1 && hour >= frame.hour && hour < LIGHT[index + 1].hour);
  const a = LIGHT[Math.max(0, i)], b = LIGHT[Math.max(0, i) + 1];
  const t = smooth(clamp((hour - a.hour) / (b.hour - a.hour)));
  const state = { phase, hour, source, phaseProgress, label: phase[0].toUpperCase() + phase.slice(1) };
  for (const key of ['darkness', 'warmth', 'windowGlow', 'fireflies', 'windowShade']) state[key] = mix(a[key], b[key], t);
  state.roomDarkness = state.darkness * .7;
  state.nightness = smooth(clamp(state.darkness / .52));
  state.tint = Object.freeze(a.tint.map((value, index) => mix(value, b.tint[index], t)));
  state.sky = Object.freeze(a.sky.map((value, index) => mix(value, b.sky[index], t)));
  return Object.freeze(state);
}

const validRect = rect => rect && [rect.x, rect.y, rect.w, rect.h].every(finite) && rect.w > 0 && rect.h > 0;
const distanceToRect = (point, rect) => Math.hypot(Math.max(rect.x - point.x, 0, point.x - rect.x - rect.w),
  Math.max(rect.y - point.y, 0, point.y - rect.y - rect.h));

/** Foot-center position determines the town; selecting a remote cottage does not. */
export function locateVillageTown(player, districts = [], { interiorTown } = {}) {
  if (typeof interiorTown === 'string' && interiorTown.trim()) return interiorTown.trim();
  if (!player || !finite(player.x) || !finite(player.y)) return 'HubTown';
  let nearest = null, distance = Infinity;
  for (const district of Array.isArray(districts) ? districts : []) {
    if (!validRect(district) || typeof district.key !== 'string' || !district.key.trim()) continue;
    const d = distanceToRect(player, district);
    // Roads choose the nearest actual district. Ties favor the home town, then
    // the key, so reordering the feed cannot change the music at a crossroads.
    if (d < distance || d === distance && (!nearest || district.key === 'HubTown' ||
      nearest.key !== 'HubTown' && district.key < nearest.key)) {
      nearest = district; distance = d;
    }
  }
  return nearest?.key || 'HubTown';
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) result = Math.imul(result ^ char.codePointAt(0), 16777619);
  return result >>> 0;
}
function random(seed) {
  let state = seed;
  return () => {
    state = Math.imul(state ^ state >>> 15, 1 | state) + 0x6d2b79f5 | 0;
    return ((state ^ state >>> 14) >>> 0) / 4294967296;
  };
}
function stableRects(rects, limit) {
  // Limit the inspected set as well as the draw count on very large fleets.
  return (Array.isArray(rects) ? rects : []).slice(0, 192).filter(validRect)
    .map(rect => ({ rect, seed: hash([rect.x, rect.y, rect.w, rect.h].join(':')) }))
    .sort((a, b) => a.seed - b.seed).slice(0, limit);
}

/** Stable decorative anchors, seeded only from real pond and trunk geometry. */
export function atmosphereAccents({ width, height, ponds = [], trees = [] } = {}) {
  if (!finite(width) || !finite(height) || width < 8 || height < 8) return [];
  const accents = [];
  const add = (kind, rectangle, count) => {
    const seed = hash(kind + ':' + rectangle.seed), next = random(seed), rect = rectangle.rect;
    for (let i = 0; i < count && accents.length < LIMITS.particles; i++) {
      const angle = next() * Math.PI * 2, radius = .75 + next() * .5;
      const x = kind === 'pond' ? rect.x + rect.w / 2 + Math.cos(angle) * (rect.w / 2 + 3) * radius : rect.x + rect.w / 2 + (next() - .5) * 24;
      const y = kind === 'pond' ? rect.y + rect.h / 2 + Math.sin(angle) * (rect.h / 2 + 5) * radius : rect.y - 4 + (next() - .5) * 18;
      accents.push({ id: kind + ':' + seed + ':' + i, kind, x: clamp(x, 3, width - 4), y: clamp(y, 3, height - 4),
        phase: next() * Math.PI * 2, speed: .22 + next() * .24, drift: 1.5 + next() * 2.5 });
    }
  };
  for (const pond of stableRects(ponds, LIMITS.ponds)) add('pond', pond, 4);
  for (const tree of stableRects(trees, LIMITS.trees)) add('tree', tree, 2);
  return accents;
}

function painter(ctx) {
  return (x, y, w, h, fill) => {
    if (w <= 0 || h <= 0) return;
    ctx.fillStyle = fill;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };
}
function clipped(ctx, width, height, protectedRects) {
  ctx.beginPath(); ctx.rect(0, 0, width, height);
  for (const rect of protectedRects) if (validRect(rect)) ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip('evenodd');
}
function stateOf(state) {
  return state && finite(state.darkness) && Array.isArray(state.tint) && Array.isArray(state.sky) ? state : villageTime(state ?? 12);
}

/** Pure visual settings for QA or other renderers; working must be explicit. */
export function sceneStyle(timeState, { interior = false, working = false } = {}) {
  const state = stateOf(timeState), nightness = smooth(clamp(state.darkness / .52));
  return Object.freeze({
    nightness,
    desaturation: nightness * (interior ? working ? .34 : .78 : .9),
    colorMix: nightness * (interior ? working ? .27 : .72 : .86),
    darkness: nightness * (interior ? working ? .36 : .65 : .78),
    coolColor: Object.freeze([91, 110, 148]),
    multiplyColor: Object.freeze([52, 70, 112]),
    windowCover: clamp(state.windowShade),
    windowGlow: working ? clamp(state.windowGlow) : 0,
  });
}

function palette(ctx, p, width, height, style, state) {
  if (style.desaturation > .0001) {
    ctx.globalCompositeOperation = 'saturation';
    p(0, 0, width, height, color([128, 128, 128], style.desaturation));
    ctx.globalCompositeOperation = 'color';
    p(0, 0, width, height, color(style.coolColor, style.colorMix));
    ctx.globalCompositeOperation = 'multiply';
    p(0, 0, width, height, color(style.multiplyColor, style.darkness));
  }
  ctx.globalCompositeOperation = 'source-over';
  const warmth = state.warmth * .04 * (1 - style.nightness);
  if (warmth > .0001) p(0, 0, width, height, color([246, 184, 119], warmth));
}

function glow(p, x, y, w, h, strength) {
  p(x - 6, y - 4, w + 12, h + 10, color([255, 178, 85], strength * .10));
  p(x - 3, y - 2, w + 6, h + 5, color([255, 204, 115], strength * .17));
}

function panes(p, x, y, fill) {
  p(x, y, 3, 3, fill); p(x + 4, y, 4, 3, fill);
  p(x, y + 4, 3, 4, fill); p(x + 4, y + 4, 4, 4, fill);
}

function windowLight(p, x, y, agent, opacity, state, style, small = false) {
  const working = agent?.status === 'working', strength = working ? state.windowGlow * opacity * opacity : 0;
  const warmth = .25 + (hash(agent?.id || x + ':' + y) % 25) / 100;
  const warm = [255, 201 + warmth * 20, 111 + warmth * 35], dark = [20, 30, 49];
  // Full night replaces the glass, including a previous frame's bright panes.
  // Filter opacity affects the light's color, rather than letting old pixels leak.
  const glass = working ? dark.map((value, i) => mix(value, warm[i], opacity)) : dark;
  if (strength > .001) {
    glow(p, x, y, small ? 2 : 8, small ? 3 : 8, strength);
    for (let i = 0; i < (small ? 2 : 4); i++) p(x - 1 - i * 2, y + (small ? 4 : 10) + i * 4,
      (small ? 4 : 10) + i * 4, 4, color([249, 187, 98], strength * (.16 - i * .025)));
  }
  if (small) p(x, y, 2, 3, color(glass, style.windowCover));
  else panes(p, x, y, color(glass, style.windowCover));
  if (working) {
    p(x, y, small ? 1 : 3, 1, color([255, 235, 174], strength * .8));
  } else if (style.nightness > .001 && !small) {
    const shutter = color([43, 57, 79], style.nightness);
    panes(p, x, y, shutter);
    for (const side of [0, 4]) {
      p(x + side, y + 1, side ? 4 : 3, 1, color([73, 88, 113], style.nightness * .8));
      p(x + side, y + 5, side ? 4 : 3, 1, color([22, 32, 51], style.nightness));
    }
    if (hauntStage(agent) !== 'none') paintHauntGhost(p, x, y, style.nightness);
  }
  return working && strength > .001;
}

/**
 * Paint after houses/fauna and before thought bubbles, Jack, and other UI.
 * Optional `trees` are actual trunk rectangles (treeTo emits 6×8 solids).
 * Plots may supply opacity when their town has been faded by a filter. Prefer
 * signalsPaintedAfter:true and repaint dispatch stands after this pass: this
 * preserves semantic colors without leaving daylight patches in the scenery.
 */
export function paintTownAtmosphere(ctx, world = {}, timeState = villageTime(12), { time = 0, reduce = false, signalsPaintedAfter = false, beforePalette = null } = {}) {
  const { width, height } = world || {}, state = stateOf(timeState);
  const result = { phase: state.phase, windows: 0, fireflies: 0 };
  if (!ctx || !finite(width) || !finite(height) || width <= 0 || height <= 0) return result;
  const hasAtmosphere = state.darkness > .0001 || state.warmth > .0001 || state.windowGlow > .001 || state.fireflies > .01;
  ctx.save();
  try {
    ctx.imageSmoothingEnabled = false;
    // Dynamic town sprites are a render pass of their own. Run them even during
    // the zero-effect Day preview, then keep them ahead of the dusk/night palette.
    if (typeof beforePalette === 'function') {
      ctx.save();
      try { ctx.globalCompositeOperation = 'source-over'; beforePalette(ctx); }
      finally { ctx.restore(); }
    }
    if (!hasAtmosphere) return result;
    const plots = (Array.isArray(world.plots) ? world.plots : []).slice(0, LIMITS.plots).filter(plot => finite(plot.x) && finite(plot.y));
    const frame = reduce || !finite(time) ? 0 : time, style = sceneStyle(state);
    // Standalone callers retain the parcel/label colors. The live renderer draws
    // those once more after this palette pass, avoiding rectangular light gaps.
    clipped(ctx, width, height, signalsPaintedAfter ? [] : plots.flatMap(plot => [
      { x: plot.x - 16, y: plot.y + 49, w: 16, h: 13 },
      { x: plot.x - 14, y: plot.y + 37, w: 13, h: 12 },
      { x: plot.x - 21, y: plot.y + 80, w: 56, h: 11 },
      ...(plot.kids || []).slice(0, 3).filter(kid => finite(kid.x) && finite(kid.y)).map(kid => ({ x: kid.x + 5, y: kid.y - 4, w: 7, h: 7 })),
    ]));
    const p = painter(ctx);
    palette(ctx, p, width, height, style, state);
    if (style.windowCover > .001) for (const plot of plots.slice(0, LIMITS.litCottages)) {
      const agent = plot.agent || {};
      const opacity = finite(plot.opacity) ? clamp(plot.opacity) : 1;
      if (opacity <= .001) continue;
      for (const x of [plot.x + 12, plot.x + 34]) {
        const y = plot.y + 41;
        if (windowLight(p, x, y, agent, opacity, state, style)) result.windows++;
      }
      for (const kid of (plot.kids || []).slice(0, 3)) if (finite(kid.x) && finite(kid.y))
        if (windowLight(p, kid.x + 4, kid.y + 10, kid.agent, opacity, state, style, true)) result.windows++;
    }
    if (state.fireflies > .01) for (const accent of atmosphereAccents(world)) {
      const x = clamp(accent.x + Math.sin(frame * accent.speed + accent.phase) * accent.drift, 3, width - 4);
      const y = clamp(accent.y + Math.cos(frame * accent.speed * .7 + accent.phase) * accent.drift, 3, height - 4);
      const blink = .4 + .6 * (.5 + .5 * Math.sin(frame * .8 + accent.phase));
      const alpha = state.fireflies * blink;
      p(x - 2, y - 1, 5, 3, color([213, 240, 139], alpha * .09));
      p(x - 1, y - 2, 3, 5, color([218, 243, 145], alpha * .075));
      p(x, y, 1, 1, color([250, 247, 172], alpha * .9));
      result.fireflies++;
    }
  } finally { ctx.restore(); }
  return result;
}

/** Paint in the room's existing 240×176 coordinate system after its renderer. */
export function paintRoomAtmosphere(ctx, room, timeState = villageTime(12), { time = 0, reduce = false, agent = null } = {}) {
  const state = stateOf(timeState), result = { phase: state.phase, windows: 0 };
  if (!ctx || !room || !finite(room.width) || !finite(room.height)) return result;
  const haunt = hauntStage(agent);
  const hasLight = state.roomDarkness > .0001 || state.windowShade > .001 || state.windowGlow > .001;
  if (!hasLight && haunt === 'none') return result;
  const review = room.objects?.find(object => object.id === 'review');
  const protectedRects = review ? [
    { x: review.x + 2, y: review.y - 12, w: review.w - 4, h: 14 },
    { x: review.x + review.w - 22, y: review.y + 2, w: 18, h: 11 },
    { x: review.x + 3, y: review.y + review.h - 12, w: review.w - 6, h: 2 },
  ] : [];
  const working = agent?.status === 'working', style = sceneStyle(state, { interior: true, working });
  const frame = reduce || !finite(time) ? 0 : time;
  ctx.save();
  try {
    ctx.imageSmoothingEnabled = false;
    // Includes the status plaque and the drawer signal: ready remains gold,
    // unknown remains gray, and no warm ambient light changes those meanings.
    clipped(ctx, room.width, room.height, protectedRects);
    const p = painter(ctx);
    if (hasLight) {
      palette(ctx, p, room.width, room.height, style, state);
      const win = room.window;
      if (validRect(win) && state.windowShade > .001) {
        ctx.save();
        try {
          // drawRoom's curtains and crossbars stay visible around the glass.
          ctx.beginPath();
          ctx.rect(win.x + 3, win.y, 7, 11); ctx.rect(win.x + 12, win.y, 8, 11);
          ctx.rect(win.x + 3, win.y + 13, 7, 10); ctx.rect(win.x + 12, win.y + 13, 8, 10);
          ctx.clip();
          p(win.x, win.y, win.w, win.h, color(state.sky, state.windowShade));
          p(win.x, win.y + 17, win.w, 6, color([48, 73, 61], state.windowShade * .85));
          p(win.x + 7, win.y + 14, 9, 8, color([55, 77, 65], state.windowShade * .85));
          const moon = style.nightness;
          p(win.x + 14, win.y + 4, 4, 4, color([246, 227, 172], state.windowShade * .75));
          p(win.x + 16, win.y + 3, 3, 4, color(state.sky, state.windowShade * moon));
          if (state.fireflies > .2) p(win.x + 6, win.y + 5, 1, 1, color([223, 230, 218], state.fireflies * .6));
          result.windows = 1;
        } finally { ctx.restore(); }
        // A small moonlit projection follows the existing authored window shaft.
        for (let i = 0; i < 4; i++) p(win.x + 4 + i * 3, 54 + i * 7, 21, 6,
          color(style.nightness > .3 ? [112, 145, 195] : [253, 203, 138], state.windowShade * .08));
      }
      const hearth = room.objects?.find(object => object.id === 'hearth');
      if (validRect(hearth) && working && state.windowGlow > .001) {
        const flicker = .9 + Math.sin(frame * 1.7 + Number(room.seed || 0) % 17) * .1;
        glow(p, hearth.x + 3, hearth.y + hearth.h - 10, hearth.w - 6, 8, state.windowGlow * flicker);
        p(hearth.x - 5, hearth.y + hearth.h - 2, hearth.w + 10, 6, color([255, 190, 105], state.windowGlow * flicker * .15));
      } else if (validRect(hearth) && style.nightness > .001) {
        // Bedtime hearths settle to embers; the renderer's original bright flames
        // are covered rather than being left shining underneath a dark overlay.
        p(hearth.x + 7, hearth.y + hearth.h - 15, hearth.w - 14, 12, color([29, 34, 43], style.nightness));
        p(hearth.x + 11, hearth.y + hearth.h - 5, 2, 1, color([128, 78, 55], style.nightness));
        p(hearth.x + 17, hearth.y + hearth.h - 4, 2, 1, color([103, 68, 53], style.nightness));
      }
      const desk = room.objects?.find(object => object.id === 'workbench');
      if (working && validRect(desk) && state.windowGlow > .001) {
        ctx.globalCompositeOperation = 'screen';
        glow(p, desk.x + 3, desk.y + 2, desk.w - 6, 16, state.windowGlow * .75);
        p(desk.x + 4, desk.y + 4, desk.w - 8, 12, color([242, 175, 89], state.windowGlow * .12));
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    paintRoomDust(p, room, haunt);
  } finally { ctx.restore(); }
  return result;
}

/** Optional 24×23 pixel prop. Top-left coordinates; never adds a collision. */
export function paintGramophone(ctx, x, y, { time = 0, playing = false, reduce = false, scale = 1 } = {}) {
  if (!ctx || !finite(x) || !finite(y) || !finite(scale) || scale <= 0) return;
  ctx.save();
  try {
    ctx.translate(Math.round(x), Math.round(y)); ctx.scale(scale, scale); ctx.imageSmoothingEnabled = false;
    const p = painter(ctx), step = playing && !reduce && finite(time) ? Math.floor(time * 3) % 4 : 0;
    p(1, 21, 23, 2, '#263a3066'); p(2, 15, 20, 7, '#493627'); p(3, 16, 18, 5, '#9e7243');
    p(4, 17, 16, 1, '#d2a563'); p(5, 21, 3, 2, '#493627'); p(17, 21, 3, 2, '#493627');
    p(4, 13, 13, 3, '#493627'); p(6, 12, 9, 3, '#29343a'); p(9, 13, 3, 1, '#c19658');
    p(6 + [0, 3, 6, 3][step], 12 + [1, 0, 1, 2][step], 2, 1, '#788078');
    p(17, 7, 2, 8, '#715230'); p(14, 10, 4, 2, '#c49950'); p(16, 13, 3, 1, '#e7c476');
    p(9, 3, 10, 6, '#493627'); p(6, 1, 8, 9, '#493627'); p(5, 2, 2, 7, '#493627');
    p(7, 2, 6, 7, '#d5aa57'); p(13, 4, 5, 4, '#ba8a40'); p(18, 6, 2, 3, '#e2bc66');
    p(6, 3, 3, 5, '#edce84'); p(8, 3, 3, 5, '#60462d'); p(9, 4, 2, 3, '#3d3226');
    p(12, 3, 2, 1, '#f3d68b'); p(13, 8, 4, 1, '#785732'); p(22, 18, 2, 1, '#d8b260');
    p(23, 17, 1, 3, '#493627');
  } finally { ctx.restore(); }
}

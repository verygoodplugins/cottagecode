import test from 'node:test';
import assert from 'node:assert/strict';
import { villageTime, locateVillageTown, atmosphereAccents, sceneStyle, paintTownAtmosphere, paintRoomAtmosphere, paintGramophone } from '../src/atmosphere.mjs';
import { createInterior } from '../src/interiors.mjs';

const WORLD = {
  width: 800, height: 460,
  plots: [
    { x: 70, y: 90, agent: { id: 'hazel', town: 'HubTown', status: 'working', pr: { state: 'open', reviewState: 'ready' } } },
    { x: 150, y: 90, agent: { id: 'fern', town: 'HubTown', status: 'idle' } },
    { x: 520, y: 90, agent: { id: 'willow', town: 'AppTown', status: 'offline' } },
  ],
  ponds: [{ x: 90, y: 320, w: 96, h: 45 }, { x: 650, y: 322, w: 70, h: 40 }],
  trees: [{ x: 17, y: 290, w: 6, h: 8 }, { x: 769, y: 300, w: 6, h: 8 }],
  districts: [
    { key: 'HubTown', x: 40, y: 40, w: 300, h: 350 },
    { key: 'AppTown', x: 450, y: 40, w: 300, h: 350 },
  ],
};

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function recordingContext() {
  const calls = [], stack = [];
  const ctx = {
    calls, fillStyle: 'original-ink', globalAlpha: .65, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true,
    save() { stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, imageSmoothingEnabled: this.imageSmoothingEnabled }); calls.push(['save']); },
    restore() { assert.ok(stack.length, 'balanced canvas state'); Object.assign(this, stack.pop()); calls.push(['restore']); },
    beginPath() { calls.push(['beginPath']); },
    rect(...args) { calls.push(['rect', ...args]); },
    clip(rule) { calls.push(['clip', rule]); },
    fillRect(...args) { calls.push(['fillRect', ...args, this.fillStyle, this.globalAlpha, this.globalCompositeOperation]); },
    translate(...args) { calls.push(['translate', ...args]); },
    scale(...args) { calls.push(['scale', ...args]); },
    get depth() { return stack.length; },
  };
  return ctx;
}
function renderTown(phase, options = {}, world = WORLD) {
  const ctx = recordingContext(), result = paintTownAtmosphere(ctx, world, villageTime(phase), options);
  return { ctx, calls: ctx.calls, result };
}
function renderRoom(room, phase, options = {}) {
  const ctx = recordingContext(), result = paintRoomAtmosphere(ctx, room, villageTime(phase), options);
  return { ctx, calls: ctx.calls, result };
}

// Sampled software canvas: independently applies the standard blend equations
// and clipping at selected pixels, without browser or native-canvas dependencies.
function pixelContext(points) {
  const ctx = recordingContext(), pixels = Object.fromEntries(Object.entries(points).map(([id, point]) => [id, { ...point, rgb: point.rgb.map(value => value / 255) }]));
  let path = [], clips = [];
  const savedClips = [], original = { save: ctx.save, restore: ctx.restore, fillRect: ctx.fillRect, beginPath: ctx.beginPath, rect: ctx.rect, clip: ctx.clip };
  const luminance = rgb => rgb[0] * .3 + rgb[1] * .59 + rgb[2] * .11;
  const setLum = (rgb, target) => {
    const difference = target - luminance(rgb);
    let result = rgb.map(value => value + difference);
    const low = Math.min(...result), high = Math.max(...result);
    if (low < 0) result = result.map(value => target + (value - target) * target / (target - low));
    if (high > 1) result = result.map(value => target + (value - target) * (1 - target) / (high - target));
    return result;
  };
  const contains = (point, rect) => point.x + .5 >= rect[0] && point.x + .5 < rect[0] + rect[2] && point.y + .5 >= rect[1] && point.y + .5 < rect[1] + rect[3];
  ctx.globalAlpha = 1;
  ctx.save = function () { savedClips.push([...clips]); original.save.call(this); };
  ctx.restore = function () { clips = savedClips.pop(); original.restore.call(this); };
  ctx.beginPath = function () { path = []; original.beginPath.call(this); };
  ctx.rect = function (...args) { path.push(args); original.rect.call(this, ...args); };
  ctx.clip = function (rule) { clips.push({ path: [...path], rule }); original.clip.call(this, rule); };
  ctx.fillRect = function (...rect) {
    original.fillRect.call(this, ...rect);
    const values = this.fillStyle.match(/^rgba\(([^)]+)\)$/)?.[1].split(',').map(Number);
    assert.ok(values, 'sampled renderer expects an explicit rgba fill');
    const source = values.slice(0, 3).map(value => value / 255), alpha = values[3] * this.globalAlpha;
    for (const point of Object.values(pixels)) {
      if (!contains(point, rect) || !clips.every(clip => {
        const count = clip.path.filter(r => contains(point, r)).length;
        return clip.rule === 'evenodd' ? count % 2 === 1 : count > 0;
      })) continue;
      let blend;
      if (this.globalCompositeOperation === 'saturation') {
        assert.equal(source[0], source[1]); assert.equal(source[1], source[2]);
        blend = [luminance(point.rgb), luminance(point.rgb), luminance(point.rgb)];
      } else if (this.globalCompositeOperation === 'color') blend = setLum(source, luminance(point.rgb));
      else if (this.globalCompositeOperation === 'multiply') blend = point.rgb.map((value, i) => value * source[i]);
      else if (this.globalCompositeOperation === 'screen') blend = point.rgb.map((value, i) => 1 - (1 - value) * (1 - source[i]));
      else blend = source;
      point.rgb = point.rgb.map((value, i) => value * (1 - alpha) + blend[i] * alpha);
    }
  };
  ctx.pixel = id => pixels[id].rgb.map(value => Math.round(value * 255));
  return ctx;
}

test('local phase boundaries include midnight and explicit hours wrap consistently', () => {
  for (const [hour, expected] of [[0, 'night'], [4.999, 'night'], [5, 'morning'], [8.999, 'morning'], [9, 'day'], [16.999, 'day'], [17, 'dusk'], [20.999, 'dusk'], [21, 'night'], [23.999, 'night'], [24, 'night'], [-1, 'night'], [33, 'day']]) {
    assert.equal(villageTime(hour).phase, expected, String(hour));
  }
  assert.equal(villageTime(24).hour, 0);
  assert.equal(villageTime(-1).hour, 23);
  assert.equal(villageTime(48).phaseProgress, villageTime(0).phaseProgress);
  for (const phase of ['morning', 'day', 'dusk', 'night']) assert.equal(villageTime(phase).phase, phase);
  const date = new Date(2026, 8, 15, 18, 30, 15, 250), result = villageTime(date);
  assert.equal(result.source, 'device-clock');
  assert.equal(result.hour, 18.5 + 15 / 3600 + .25 / 3600);
  assert.equal(result.phase, 'dusk');
  for (const invalid of [NaN, Infinity, new Date('invalid'), null, {}, 'unexpected']) {
    assert.equal(villageTime(invalid).hour, 12);
    assert.equal(villageTime(invalid).source, 'fallback');
  }
});

test('lighting changes continuously and remains legible at every hour', () => {
  for (let hour = 0; hour < 24; hour += .05) {
    const state = villageTime(hour);
    assert.ok(state.darkness >= 0 && state.darkness <= .52);
    assert.ok(state.roomDarkness >= 0 && state.roomDarkness <= .3641);
    for (const key of ['warmth', 'windowGlow', 'fireflies', 'windowShade']) assert.ok(state[key] >= 0 && state[key] <= 1, key);
    for (const color of [...state.tint, ...state.sky]) assert.ok(color >= 0 && color <= 255);
  }
  for (const boundary of [0, 4, 5, 7, 9, 16, 17, 19, 21, 24]) {
    const before = villageTime(boundary - .0001), after = villageTime(boundary + .0001);
    for (const key of ['darkness', 'warmth', 'windowGlow', 'fireflies', 'windowShade'])
      assert.ok(Math.abs(before[key] - after[key]) < .0001, key + ' jumped at ' + boundary);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(before.tint[i] - after.tint[i]) < .0001);
  }
  assert.equal(villageTime('day').darkness, 0);
  assert.equal(villageTime('day').windowGlow, 0);
  assert.equal(villageTime('day').fireflies, 0);
  assert.ok(villageTime('dusk').windowGlow > .5);
  assert.equal(villageTime('night').windowGlow, 1);
});

test('night recolors existing green grass and warm paths into a visibly darker blue palette', () => {
  const points = { grass: { x: 3, y: 4, rgb: [99, 184, 95] }, path: { x: 12, y: 14, rgb: [227, 168, 96] } };
  const ctx = pixelContext(points);
  paintTownAtmosphere(ctx, { width: 24, height: 24 }, villageTime('night'));
  const luminance = rgb => rgb[0] * .3 + rgb[1] * .59 + rgb[2] * .11;
  for (const [id, original] of Object.entries(points)) {
    const night = ctx.pixel(id);
    assert.ok(night[2] > night[0] + 30, id + ' should read blue, not green or brown: ' + night);
    assert.ok(night[2] > night[1] + 20, id + ' needs a clear night hue');
    assert.ok(luminance(night) < luminance(original.rgb) * .56, id + ' is still too close to daytime brightness: ' + night);
    assert.ok(luminance(night) > 35, 'paths should remain visible');
  }
  const operations = ctx.calls.filter(call => call[0] === 'fillRect').map(call => call[7]);
  assert.deepEqual(operations, ['saturation', 'color', 'multiply']);
  assert.equal(sceneStyle(villageTime('day')).darkness, 0);
  assert.ok(sceneStyle(villageTime('night')).desaturation >= .85);
  assert.ok(sceneStyle(villageTime('night')).darkness >= .75);
});

test('night replaces previously bright inactive panes, keeps only working windows warm, and respects filters', () => {
  const points = Object.fromEntries(WORLD.plots.map((plot, i) => [i, { x: plot.x + 13, y: plot.y + 47, rgb: [255, 240, 180] }]));
  const ctx = pixelContext(points);
  paintTownAtmosphere(ctx, WORLD, villageTime('night'), { signalsPaintedAfter: true, reduce: true });
  assert.ok(ctx.pixel('0')[0] > 245 && ctx.pixel('0')[1] > 190, 'working window should glow gold');
  for (const id of ['1', '2']) assert.deepEqual(ctx.pixel(id), [43, 57, 79], 'inactive glass must be fully replaced with cool shutters');
  const faded = pixelContext({ active: points[0] });
  paintTownAtmosphere(faded, { ...WORLD, plots: WORLD.plots.map(plot => ({ ...plot, opacity: .3 })) }, villageTime('night'), { signalsPaintedAfter: true });
  assert.ok(faded.pixel('active')[0] < ctx.pixel('0')[0] * .5, 'filter fading must not be undone by warm lights');
  for (const status of ['idle', 'blocked', 'done', 'offline', 'unknown']) {
    const result = renderTown('night', {}, { ...WORLD, plots: [{ ...WORLD.plots[0], agent: { status } }] });
    assert.equal(result.result.windows, 0, status + ' must not acquire a working light');
  }
});

test('working apprentice sheds keep their tiny lights and other sheds are opaque dark blue', () => {
  const kids = [
    { x: 78, y: 173, agent: { id: 'late-apprentice', status: 'working' } },
    { x: 96, y: 173, agent: { id: 'sleeping-apprentice', status: 'done' } },
  ];
  const ctx = pixelContext(Object.fromEntries(kids.map((kid, i) => [i, { x: kid.x + 4, y: kid.y + 11, rgb: [255, 240, 180] }])));
  const result = paintTownAtmosphere(ctx, { ...WORLD, plots: [{ ...WORLD.plots[0], kids }] }, villageTime('night'), { signalsPaintedAfter: true });
  assert.equal(result.windows, 3);
  assert.ok(ctx.pixel('0')[0] > 245 && ctx.pixel('0')[1] > 190);
  assert.deepEqual(ctx.pixel('1'), [20, 30, 49]);
});

test('semantic PR pixels keep their exact colors without leaving a whole daylight desk', () => {
  const room = createInterior({ id: 'semantic-night', town: 'MemTown' }), review = room.objects.find(object => object.id === 'review');
  for (const rgb of [[246, 220, 137], [240, 143, 124], [180, 187, 195], [153, 207, 146]]) {
    const points = {
      plaque: { x: review.x + 5, y: review.y - 10, rgb },
      parcel: { x: review.x + review.w - 10, y: review.y + 6, rgb },
      drawer: { x: review.x + 5, y: review.y + review.h - 11, rgb },
      desk: { x: review.x + 7, y: review.y + 8, rgb: [210, 178, 140] },
    };
    const ctx = pixelContext(points);
    paintRoomAtmosphere(ctx, room, villageTime('night'), { agent: { status: 'idle' }, reduce: true });
    for (const id of ['plaque', 'parcel', 'drawer']) assert.deepEqual(ctx.pixel(id), rgb, id + ' changed a PR meaning');
    assert.notDeepEqual(ctx.pixel('desk'), points.desk.rgb, 'normal desk surface should receive the night palette');
  }
  const plot = WORLD.plots[0], prColor = [246, 220, 137];
  const ctx = pixelContext({ parcel: { x: plot.x - 8, y: plot.y + 56, rgb: prColor }, flag: { x: plot.x - 8, y: plot.y + 45, rgb: prColor } });
  paintTownAtmosphere(ctx, WORLD, villageTime('night'), { reduce: true });
  assert.deepEqual(ctx.pixel('parcel'), prColor);
  assert.deepEqual(ctx.pixel('flag'), prColor);
  const deferred = renderTown('night', { signalsPaintedAfter: true });
  assert.equal(deferred.calls.filter(call => call[0] === 'rect').length, 1, 'post-painted dispatch UI needs no daylight holes');
});

test('working rooms stay warmer while sleeping rooms darken and the fireplace settles to embers', () => {
  const room = createInterior({ id: 'bedtime-mood', town: 'VaultTown' }), hearth = room.objects.find(object => object.id === 'hearth');
  const points = { floor: { x: 122, y: 149, rgb: [183, 137, 93] }, flame: { x: hearth.x + 13, y: hearth.y + hearth.h - 10, rgb: [247, 206, 119] } };
  const awake = pixelContext(points), asleep = pixelContext(points);
  paintRoomAtmosphere(awake, room, villageTime('night'), { agent: { status: 'working' }, reduce: true });
  paintRoomAtmosphere(asleep, room, villageTime('night'), { agent: { status: 'idle' }, reduce: true });
  assert.ok(awake.pixel('floor').reduce((a, b) => a + b, 0) > asleep.pixel('floor').reduce((a, b) => a + b, 0) * 1.25);
  assert.deepEqual(asleep.pixel('flame'), [29, 34, 43]);
  assert.ok(awake.pixel('flame')[0] > asleep.pixel('flame')[0] * 2);
  assert.ok(sceneStyle(villageTime('night'), { interior: true, working: true }).colorMix < sceneStyle(villageTime('night'), { interior: true }).colorMix);
});

test('town follows Jack’s feet, nearest road district, or the actual interior', () => {
  assert.equal(locateVillageTown({ x: 90, y: 90 }, WORLD.districts), 'HubTown');
  assert.equal(locateVillageTown({ x: 600, y: 200 }, WORLD.districts), 'AppTown');
  assert.equal(locateVillageTown({ x: 435, y: 200 }, WORLD.districts), 'AppTown');
  assert.equal(locateVillageTown({ x: 355, y: 200 }, WORLD.districts), 'HubTown');
  const midpoint = { x: 395, y: 200 };
  assert.equal(locateVillageTown(midpoint, WORLD.districts), 'HubTown');
  assert.equal(locateVillageTown(midpoint, [...WORLD.districts].reverse()), 'HubTown');
  assert.equal(locateVillageTown({ x: 600, y: 200 }, WORLD.districts, { interiorTown: 'MemTown' }), 'MemTown');
  assert.equal(locateVillageTown(null, WORLD.districts), 'HubTown');
  assert.equal(locateVillageTown({ x: NaN, y: 20 }, WORLD.districts), 'HubTown');
  assert.equal(locateVillageTown({ x: 20, y: 20 }, [{ key: 'MissingBounds' }]), 'HubTown');
  assert.equal(locateVillageTown({ x: 20, y: 20 }, [], { interiorTown: 'VaultTown' }), 'VaultTown');
  const annex = [...WORLD.districts, { key: 'AppTown', x: 40, y: 450, w: 300, h: 350 }];
  assert.equal(locateVillageTown({ x: 90, y: 600 }, annex), 'AppTown');
});

test('firefly anchors are deterministic, bounded, and attached to real ponds or trees', () => {
  const first = atmosphereAccents(WORLD);
  assert.deepEqual(first, atmosphereAccents(structuredClone(WORLD)));
  assert.deepEqual(first, atmosphereAccents({ ...WORLD, ponds: [...WORLD.ponds].reverse(), trees: [...WORLD.trees].reverse() }));
  assert.deepEqual(first, atmosphereAccents({ ...WORLD, plots: WORLD.plots.map(plot => ({ ...plot, agent: { ...plot.agent, status: 'done', lastLine: 'Unrelated progress', updatedAt: Date.now() } })) }));
  assert.ok(first.some(accent => accent.kind === 'pond'));
  assert.ok(first.some(accent => accent.kind === 'tree'));
  assert.equal(first.length, 12);
  for (const accent of first) {
    assert.ok(accent.x >= 3 && accent.x <= WORLD.width - 4);
    assert.ok(accent.y >= 3 && accent.y <= WORLD.height - 4);
    const anchors = accent.kind === 'pond' ? WORLD.ponds : WORLD.trees;
    assert.ok(anchors.some(rect => Math.hypot(accent.x - (rect.x + rect.w / 2), accent.y - (rect.y + rect.h / 2)) < Math.max(rect.w, rect.h) * .8 + 25));
  }
  const huge = { width: 4000, height: 4000,
    ponds: Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i * 2, w: 100, h: 40 })),
    trees: Array.from({ length: 1000 }, (_, i) => ({ x: i * 2, y: i, w: 6, h: 8 })),
  };
  assert.equal(atmosphereAccents(huge).length, 40);
  assert.deepEqual(atmosphereAccents({ width: 10, height: 10 }), []);
  assert.deepEqual(atmosphereAccents({ width: NaN, height: 10, ponds: WORLD.ponds }), []);
});

test('only working cottages have warm evening windows, with dark panes for every other status', () => {
  const day = renderTown('day');
  assert.equal(day.result.windows, 0);
  assert.equal(day.result.fireflies, 0);
  assert.equal(day.calls.filter(call => call[0] === 'fillRect').length, 0);
  const dusk = renderTown('dusk');
  assert.equal(dusk.result.windows, 2);
  assert.equal(dusk.result.fireflies, 12);
  const plot = WORLD.plots[0], glass = dusk.calls.filter(call => call[0] === 'fillRect' && call[3] <= 4 && call[4] >= 3);
  for (const x of [plot.x + 12, plot.x + 34]) for (const [dx, dy, w, h] of [[0, 0, 3, 3], [4, 0, 4, 3], [0, 4, 3, 4], [4, 4, 4, 4]])
    assert.ok(glass.some(call => call[1] === x + dx && call[2] === plot.y + 41 + dy && call[3] === w && call[4] === h));
  assert.ok(dusk.calls.some(call => call[0] === 'clip' && call[1] === 'evenodd'));
  const rects = dusk.calls.filter(call => call[0] === 'rect');
  for (const plot of WORLD.plots) {
    assert.ok(rects.some(call => call[1] === plot.x - 16 && call[2] === plot.y + 49 && call[3] === 16 && call[4] === 13));
    assert.ok(rects.some(call => call[1] === plot.x - 21 && call[2] === plot.y + 80));
  }
  const faded = renderTown('night', {}, { ...WORLD, plots: WORLD.plots.map(plot => ({ ...plot, opacity: 0 })) });
  assert.equal(faded.result.windows, 0);
});

test('reduced motion freezes fireflies and hearth light without turning them off', () => {
  const still = renderTown('night', { time: 0, reduce: true });
  assert.deepEqual(still.calls, renderTown('night', { time: 300, reduce: true }).calls);
  assert.ok(still.result.fireflies > 0);
  assert.notDeepEqual(renderTown('night', { time: 0 }).calls, renderTown('night', { time: 30 }).calls);
  const room = createInterior({ id: 'cottage-one', taskId: 'first-task', town: 'HubTown' });
  const agent = { status: 'working' };
  assert.deepEqual(renderRoom(room, 'night', { time: 0, reduce: true, agent }).calls, renderRoom(room, 'night', { time: 300, reduce: true, agent }).calls);
  assert.notDeepEqual(renderRoom(room, 'night', { time: 0, agent }).calls, renderRoom(room, 'night', { time: 3, agent }).calls);
  assert.deepEqual(renderRoom(room, 'night', { time: 0, agent: { status: 'idle' } }).calls, renderRoom(room, 'night', { time: 300, agent: { status: 'idle' } }).calls);
});

test('room overlay protects the actual PR plaque, parcel and drawer across all authored layouts', () => {
  const layouts = new Set();
  for (let i = 0; i < 40; i++) {
    const room = createInterior({ id: 'house-' + i, town: ['HubTown', 'AppTown', 'MemTown', 'VaultTown'][i % 4] });
    layouts.add(room.layout);
    const night = renderRoom(room, 'night', { reduce: true }), review = room.objects.find(object => object.id === 'review');
    assert.equal(night.result.windows, 1);
    assert.ok(night.calls.some(call => call[0] === 'rect' && call[1] === review.x + 2 && call[2] === review.y - 12 && call[3] === review.w - 4 && call[4] === 14));
    assert.ok(night.calls.some(call => call[0] === 'rect' && call[1] === review.x + review.w - 22 && call[2] === review.y + 2 && call[3] === 18 && call[4] === 11));
    assert.ok(night.calls.some(call => call[0] === 'rect' && call[1] === review.x + 3 && call[2] === review.y + review.h - 12 && call[3] === review.w - 6 && call[4] === 2));
    assert.ok(night.calls.some(call => call[0] === 'clip' && call[1] === 'evenodd'));
    const win = room.window;
    assert.ok(night.calls.some(call => call[0] === 'rect' && call[1] === win.x + 3 && call[2] === win.y && call[3] === 7 && call[4] === 11));
    assert.equal(renderRoom(room, 'day').calls.filter(call => call[0] === 'fillRect').length, 0);
  }
  assert.equal(layouts.size, 4);
});

test('painters restore canvas state and never mutate frozen room, world, or task data', () => {
  const world = freeze(structuredClone(WORLD)), before = JSON.stringify(world);
  const room = freeze(createInterior({ id: 'freeze', town: 'VaultTown' })), roomBefore = JSON.stringify(room);
  const state = villageTime('night');
  for (const render of [renderTown('night', { time: 15 }, world), renderRoom(room, 'night', { time: 15 })]) {
    assert.equal(render.ctx.depth, 0);
    assert.equal(render.ctx.fillStyle, 'original-ink');
    assert.equal(render.ctx.globalAlpha, .65);
    assert.equal(render.ctx.globalCompositeOperation, 'source-over');
    assert.equal(render.ctx.imageSmoothingEnabled, true);
  }
  assert.equal(JSON.stringify(world), before);
  assert.equal(JSON.stringify(room), roomBefore);
  assert.ok(Object.isFrozen(state));
  const ctx = recordingContext();
  assert.doesNotThrow(() => paintTownAtmosphere(ctx, null));
});

test('draw cost is bounded for large scenes, and all canvas numbers are finite', () => {
  const world = { ...WORLD, plots: Array.from({ length: 10000 }, (_, i) => ({ x: i * 80, y: 90, agent: { id: 'cottage-' + i, status: 'working' } })) };
  const { calls, result } = renderTown('night', { time: Infinity }, world);
  assert.equal(result.windows, 192);
  assert.ok(calls.length < 3300);
  for (const call of calls) for (const value of call.slice(1)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  const ctx = recordingContext();
  assert.deepEqual(paintRoomAtmosphere(ctx, null), { phase: 'day', windows: 0 });
  assert.equal(paintTownAtmosphere(ctx, { width: NaN, height: 10 }).windows, 0);
});

test('gramophone is a deterministic tiny prop with opt-in disc animation', () => {
  const draw = options => { const ctx = recordingContext(); paintGramophone(ctx, 12, 34, options); return ctx; };
  assert.deepEqual(draw({ time: 0 }).calls, draw({ time: 15 }).calls);
  assert.deepEqual(draw({ time: 0, playing: true, reduce: true }).calls, draw({ time: 15, playing: true, reduce: true }).calls);
  assert.notDeepEqual(draw({ time: 0, playing: true }).calls, draw({ time: 1, playing: true }).calls);
  assert.equal(draw({ playing: true }).depth, 0);
  assert.ok(draw({ scale: 2 }).calls.some(call => call[0] === 'scale' && call[1] === 2 && call[2] === 2));
});

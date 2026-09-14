import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterior, isWalkable, renderInterior, renderResident, reviewSignal } from '../src/interiors.mjs';

const agent = { id: 'bolt-1', taskId: 'task-42', name: 'Bolt', town: 'HubTown', status: 'working' };
const required = ['request', 'clock', 'workbench', 'review', 'shelf', 'exit'];

test('room and resident stay identical when task content, timing, or PR state updates', () => {
  const first = createInterior(agent);
  const later = createInterior({ ...agent, task: 'A different update', activity: 'Running tests', lastLine: 'New output', startedAt: 50, updatedAt: 12345, status: 'done', pr: { number: 42, state: 'merged' } });
  assert.deepEqual(first, later);
  assert.equal(first.width, 240);
  assert.equal(first.height, 176);
});

test('legacy feeds retain cottage identity without explicit task boundaries', () => {
  const { taskId, ...legacy } = agent;
  assert.deepEqual(createInterior(legacy), createInterior({ ...legacy, task: 'Another ask', taskStartedAt: 42, startedAt: 99, name: 'Bolt renamed' }));
  assert.notEqual(createInterior(agent).seed, createInterior({ ...agent, taskId: 'task-43' }).seed);
  assert.notEqual(createInterior({ id: 'a:b', taskId: 'c' }).seed, createInterior({ id: 'a', taskId: 'b:c' }).seed);
});

test('known and explicitly supplied project themes do not hash unrelated projects into themes', () => {
  for (const [town, theme] of Object.entries({ HubTown: 'hub', AppTown: 'app', MemTown: 'memory', VaultTown: 'vault', FusionTown: 'neutral', WildTown: 'neutral' })) {
    assert.equal(createInterior({ ...agent, town }).theme, theme);
  }
  assert.equal(createInterior({ ...agent, town: 'OtherTown', interiorTheme: 'vault' }).theme, 'vault');
  assert.equal(createInterior({ ...agent, interiorTheme: 'unknown-theme' }).theme, 'neutral');
});

function reachablePoints(room) {
  const seen = new Set();
  const queue = [[room.door.x, room.door.y]];
  // All authored approaches and spawn points are aligned to the two-pixel grid.
  const encode = (x, y) => y * room.width + x;
  seen.add(encode(...queue[0]));
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [nx, ny] of [[x - 2, y], [x + 2, y], [x, y - 2], [x, y + 2]]) {
      const key = encode(nx, ny);
      if (!seen.has(key) && isWalkable(room, nx, ny)) {
        seen.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  return { seen, encode };
}

test('160 task seeds across all four towns have varied homes and reachable interaction points', () => {
  const seeds = new Set();
  const plans = new Set();
  const wardrobes = new Set();
  const rugs = new Set();
  for (let i = 0; i < 160; i++) {
    const room = createInterior({ ...agent, id: `cottage-${i % 11}`, taskId: `task-${i}`, town: ['HubTown', 'AppTown', 'MemTown', 'VaultTown'][i % 4] });
    seeds.add(room.seed);
    plans.add(room.layout);
    wardrobes.add(JSON.stringify(room.resident));
    rugs.add(`${room.palette.rug}:${room.rug.pattern}`);
    assert.ok(isWalkable(room, room.door.x, room.door.y), `${room.layout}: blocked doorway`);
    assert.ok(isWalkable(room, room.resident.x, room.resident.y), `${room.layout}: resident in furniture`);
    const { seen, encode } = reachablePoints(room);
    for (const id of required) {
      const object = room.objects.find((candidate) => candidate.id === id);
      assert.ok(object?.interactable, `${room.layout}: missing ${id}`);
      const { x, y } = object.approach;
      assert.ok(isWalkable(room, x, y), `${room.layout}: ${id} has a blocked approach (${x},${y})`);
      // The clock is sometimes centered on an odd pixel; its neighboring floor
      // point must be reachable, so there is no false failure from grid parity.
      assert.ok(seen.has(encode(x, y)) || seen.has(encode(x - 1, y)) || seen.has(encode(x + 1, y)), `${room.layout}: ${id} is isolated`);
      const dx = Math.max(object.x - x, 0, x - object.x - object.w);
      const dy = Math.max(object.y - y, 0, y - object.y - object.h);
      assert.ok(Math.hypot(dx, dy) <= 16, `${room.layout}: ${id} cannot be interacted with nearby`);
    }
  }
  assert.equal(seeds.size, 160);
  assert.equal(plans.size, 4);
  assert.ok(wardrobes.size > 100);
  assert.ok(rugs.size >= 8);
});

test('town-wide accents preserve operational geometry and leave wall objects unobstructed', () => {
  for (let i = 0; i < 40; i++) {
    const task = { ...agent, taskId: `theme-task-${i}` };
    const baseline = createInterior(task);
    for (const town of ['AppTown', 'MemTown', 'VaultTown', 'OtherTown']) {
      const room = createInterior({ ...task, town });
      assert.equal(room.seed, baseline.seed);
      assert.deepEqual(room.door, baseline.door);
      assert.deepEqual(room.objects.filter((o) => required.includes(o.id)), baseline.objects.filter((o) => required.includes(o.id)));
      assert.deepEqual(room.floor, baseline.floor);
      for (const panel of room.decor.wallPanels) {
        for (const object of [...room.objects.filter((o) => ['request', 'clock'].includes(o.id)), room.window]) {
          assert.ok(panel.x + panel.w <= object.x || panel.x >= object.x + object.w, `${town} decor obscures a wall interaction`);
        }
        assert.ok(panel.y >= 13 && panel.y + panel.h <= 47, `${town} wall decor extends into a walking path`);
      }
      if (town === 'MemTown') {
        assert.ok(room.decor.wallPanels.every((p) => p.kind === 'bookcase'));
        assert.ok(room.decor.wallPanels.flatMap((p) => p.books).length >= 35, 'library should look densely shelved');
        assert.equal(room.resident.heldItem, 'book');
      } else if (town === 'VaultTown') {
        assert.ok(room.decor.wallPanels.flatMap((p) => p.clocks).length >= 4, 'workshop needs a visible clock collection');
        assert.ok(['loupe', 'keyring', 'tool'].includes(room.resident.heldItem));
      } else if (town === 'AppTown') {
        assert.ok(room.decor.wallPanels.every((p) => p.kind === 'device-rack'));
        assert.ok(room.decor.wallPanels.reduce((n, p) => n + p.screens, 0) >= 5, 'device studio should have a wall of equipment');
        assert.ok(['phone', 'tablet'].includes(room.resident.heldItem));
      } else {
        assert.equal(room.theme, 'neutral');
        assert.deepEqual(room.decor.wallPanels, []);
      }
    }
  }
});

test('task identity varies shelf contents, clock silhouettes and personal props deterministically', () => {
  const variants = new Set();
  const clockStyles = new Set();
  const props = new Set();
  for (let i = 0; i < 40; i++) {
    const room = createInterior({ ...agent, town: 'VaultTown', taskId: `clock-task-${i}` });
    variants.add(JSON.stringify(room.decor));
    room.decor.wallPanels.flatMap((p) => p.clocks).forEach((c) => clockStyles.add(c.style));
    props.add(room.resident.heldItem);
    assert.deepEqual(room, createInterior({ ...agent, town: 'VaultTown', taskId: `clock-task-${i}`, updatedAt: i * 1234 }));
  }
  assert.equal(variants.size, 40);
  assert.ok(clockStyles.size >= 4);
  assert.equal(props.size, 3);
});

test('wall and furniture collision rejects invalid coordinates', () => {
  const room = createInterior(agent);
  for (const [x, y] of [[0, 0], [120, 0], [240, 80], [120, 175], [NaN, 80], [90, Infinity]]) assert.equal(isWalkable(room, x, y), false);
  for (const object of room.objects.filter((candidate) => candidate.solid)) {
    assert.equal(isWalkable(room, object.x + object.w / 2, object.y + object.h / 2), false, object.id);
  }
});

function recordingContext() {
  const rects = [];
  let depth = 0;
  return {
    rects,
    get depth() { return depth; },
    save() { depth++; }, restore() { depth--; },
    translate(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); },
    scale(x, y) { assert.ok(Number.isFinite(x) && Number.isFinite(y)); },
    fillRect(x, y, w, h) { assert.ok([x, y, w, h].every(Number.isFinite)); assert.ok(w >= 0 && h >= 0); rects.push([x, y, w, h, this.fillStyle]); },
    fillText() {}, measureText(text) { return { width: text.length * 3.6 }; },
  };
}

test('rendering preserves the generated room and supports missing data and every review state', () => {
  for (const town of ['HubTown', 'AppTown', 'MemTown', 'VaultTown', 'OtherTown']) {
    const room = createInterior({ ...agent, town });
    const before = structuredClone(room);
    for (const reviewState of ['none', 'open', 'active', 'waiting-codex', 'waiting-ci', 'blocked', 'ready', 'merged', 'closed', 'unknown']) {
      const ctx = recordingContext();
      renderInterior(ctx, room, { time: 1750, agent: { ...agent, pr: { state: reviewState === 'merged' || reviewState === 'closed' ? reviewState : 'open', reviewState, checkedAt: Date.now(), source: 'github' } }, player: { ...room.door, walking: true }, selectedObject: 'review' });
      assert.ok(ctx.rects.length > 300);
      assert.equal(ctx.depth, 0);
    }
    renderInterior(recordingContext(), room);
    assert.deepEqual(room, before);
  }
});

test('reduced motion freezes scene animation while resident sprites support scale', () => {
  for (const town of ['HubTown', 'AppTown', 'MemTown', 'VaultTown']) {
    const room = createInterior({ ...agent, town });
    const a = recordingContext();
    const b = recordingContext();
    renderInterior(a, room, { agent, time: 0, reduce: true, player: { ...room.door, walking: true } });
    renderInterior(b, room, { agent, time: 1500, reduce: true, player: { ...room.door, walking: true } });
    assert.deepEqual(a.rects, b.rects, town);
  }
  const room = createInterior(agent);
  const scaled = recordingContext();
  renderResident(scaled, 120, 100, room.resident, { scale: 2, time: 400, walking: true });
  assert.equal(scaled.depth, 0);
});

function prFor(stage, now) {
  if (stage === 'unknown') return undefined;
  if (stage === 'none') return { state: 'none', source: 'feed', checkedAt: now };
  return {
    number: 42, url: 'https://github.com/example/cottage/pull/42',
    state: ['merged', 'closed'].includes(stage) ? stage : 'open',
    source: 'github', checkedAt: now, headSha: 'abc123', reviewedHeadSha: 'abc123',
    labels: ['open', 'merged', 'closed'].includes(stage) ? [] : ['babysit:' + stage],
  };
}

test('every PR stage has an accurate, visibly rendered light with its own icon', () => {
  const now = Date.now();
  const room = createInterior(agent);
  const before = structuredClone(room);
  const shapes = new Set();
  for (const stage of ['none', 'open', 'active', 'waiting-codex', 'waiting-ci', 'blocked', 'ready', 'merged', 'closed', 'unknown']) {
    const pr = prFor(stage, now);
    const signal = reviewSignal(pr, now);
    assert.equal(signal.stage, stage);
    assert.ok(signal.label && signal.shortLabel && signal.color && signal.shape);
    shapes.add(signal.shape);
    const ctx = recordingContext();
    renderInterior(ctx, room, { agent: { ...agent, pr }, reduce: true });
    // A dynamic drawer light plus the signal plaque/icon use this exact color.
    assert.ok(ctx.rects.filter((rect) => rect[4] === signal.color).length >= 3, stage);
    assert.deepEqual(room, before, `${stage} changed the room instead of its live signal`);
  }
  assert.equal(shapes.size, 10, 'stage must also be readable without relying on color');
});

test('stale, conflicting, draft and changed-head readiness never light the ready signal', () => {
  const now = Date.now();
  const ready = prFor('ready', now);
  const readyColor = reviewSignal(ready, now).color;
  const cases = [
    { ...ready, stale: true },
    { ...ready, checkedAt: now - 120001 },
    { ...ready, checkedAt: null },
    { ...ready, labels: ['babysit:ready', 'babysit:active'] },
    { ...ready, headSha: 'new-head' },
    { ...ready, isDraft: true },
    { ...ready, reviewState: 'blocked' },
  ];
  for (const pr of cases) {
    const signal = reviewSignal(pr, now);
    assert.equal(signal.stage, 'unknown');
    assert.equal(signal.shape, 'question');
    assert.notEqual(signal.color, readyColor);
  }
});

test('conversation pose and bubble leave the room intact and freeze under reduced motion', () => {
  const room = createInterior({ ...agent, town: 'AppTown' });
  const before = structuredClone(room);
  const idle = recordingContext();
  const talking = recordingContext();
  const later = recordingContext();
  renderInterior(idle, room, { agent, reduce: true });
  renderInterior(talking, room, { agent, talking: true, reduce: true, time: 0 });
  renderInterior(later, room, { agent, talking: true, reduce: true, time: 9999 });
  assert.ok(talking.rects.length > idle.rects.length, 'speaking has a visible acknowledgement');
  assert.deepEqual(talking.rects, later.rects);
  assert.deepEqual(room, before);
  const a = recordingContext(), b = recordingContext();
  renderResident(a, 100, 100, room.resident, { talking: true, walking: true, reduce: true, time: 0 });
  renderResident(b, 100, 100, room.resident, { talking: true, walking: true, reduce: true, time: 170 });
  assert.deepEqual(a.rects, b.rects);
});

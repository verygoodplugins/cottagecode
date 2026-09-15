/** Domestic animation only. Feed statuses, tasks, and room seeds never change. */
const clamp = value => Math.max(0, Math.min(1, value));
function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}
export function isBedtime(light) {
  const hour = light?.hour;
  return Number.isFinite(hour) && (hour >= 18.5 || hour < 5);
}

/** The live clock stays truthful even when a filtered or empty feed has no families to paint. */
export function villageLifeLabel(light, routines = []) {
  const families = Array.isArray(routines) ? routines : [...routines.values()];
  const evening = isBedtime(light);
  if (evening && families.some(family => !family.settled)) return 'Families are heading home · Chickens to their coops';
  if (evening) {
    const late = families.filter(family => family.mode === 'working-late').length;
    return 'The village is tucked in · ' + late + ' cottage' + (late === 1 ? '' : 's') + ' working late';
  }
  return 'Daytime · Children and chickens in the gardens';
}
function along(points, fraction) {
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
  let remaining = clamp(fraction) * lengths.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const f = lengths[i] ? remaining / lengths[i] : 1;
      return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
    }
    remaining -= lengths[i];
  }
  return { ...points.at(-1) };
}

/** Stable families, one short homecoming per evening; refreshes do not restart it. */
export function createBedtimeRoutine() {
  const homes = new Map();
  let evening = null, started = 0, cycle = 0;
  return {
    update(plots, light, { time = 0, reduce = false } = {}) {
      time = Number.isFinite(time) ? time : 0;
      const nextEvening = isBedtime(light);
      if (evening !== nextEvening) { evening = nextEvening; started = time; cycle++; }
      const frames = new Map(), present = new Set();
      for (const plot of plots) {
        const agent = plot.agent || {}, key = JSON.stringify([agent.id, agent.taskId ?? null]);
        present.add(key);
        if (!homes.has(key)) homes.set(key, { seed: hash(key), arrived: time });
        const home = homes.get(key), seed = home.seed;
        const elapsed = reduce || home.tuckedCycle === cycle ? 100 : Math.max(0, time - Math.max(started, home.arrived) - (seed % 17) / 10);
        if (evening && elapsed >= 12) home.tuckedCycle = cycle;
        const door = { x: plot.x + 27, y: plot.y + 64 }, lane = { x: plot.x + 17, y: plot.y + 73 };
        const yard = { x: plot.x + 17, y: plot.y + 112 };
        const settled = evening && elapsed >= 12;
        const mode = !evening ? 'day' : !settled ? 'gathering' : agent.status === 'working' ? 'working-late' : 'asleep';
        const parent = !evening ? null : elapsed < 4 ? along([door, lane, yard], elapsed / 4) : along([yard, lane, door], (elapsed - 4) / 6);
        const coop = { x: plot.x - 12, y: plot.y + 100, w: 17, h: 14 };
        const hens = Array.from({ length: seed % 3 === 0 ? 2 : seed % 3 === 1 ? 1 : 0 }, (_, i) => {
          const start = { x: plot.x + 7 + i * 13, y: plot.y + 119 + i * 3 };
          const end = { x: coop.x + 8, y: coop.y + 13 };
          const walk = !evening ? null : along([start, { x: yard.x - 6, y: yard.y + 3 }, end], (elapsed - 2 - i * .5) / 6);
          const point = walk || { x: start.x + (reduce ? 0 : Math.sin(time * .6 + seed + i) * 5), y: start.y };
          return { ...point, hidden: evening && elapsed >= 8.5 + i * .5, walking: evening ? elapsed > 2 && elapsed < 9 : !reduce, flip: evening, index: i };
        });
        const kids = (plot.kids || []).map((kid, i) => {
          const start = { x: kid.x + 8, y: kid.y + 20 };
          const point = !evening ? { x: start.x + (reduce ? 0 : Math.sin(time * .5 + hash(kid.agent.id)) * 3), y: start.y } :
            along([start, { x: yard.x - 7, y: start.y }, { x: lane.x - 3, y: lane.y + 8 }, door], (elapsed - 3 - i * .6) / 7);
          return { ...point, id: kid.agent.id, hidden: evening && elapsed >= 10.5 + i * .6, walking: evening && elapsed > 3 && !settled };
        });
        frames.set(agent.id, { key, mode, evening, settled, parent, kids, hens, coop, door, progress: evening ? clamp(elapsed / 12) : 0 });
      }
      for (const key of homes.keys()) if (!present.has(key)) homes.delete(key);
      return frames;
    },
  };
}

/** The armchair's footprint becomes a little bed; authored walking lanes stay put. */
export function roomRest(room, agent, light, routine) {
  const bed = room?.objects?.find(object => object.id === 'chair');
  if (!bed || !isBedtime(light) || !routine?.settled || agent?.status === 'working') return null;
  return { bed, host: { x: bed.x + bed.w / 2, y: bed.y + bed.h - 1 } };
}

export function paintBed(ctx, room, rest, { time = 0, reduce = false, talking = false } = {}) {
  if (!rest) return;
  const { x, y, w, h } = rest.bed, resident = room.resident;
  const p = (dx, dy, width, height, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(dx), Math.round(dy), width, height); };
  ctx.save();
  p(x + 1, y, w - 2, h, '#3c4658'); p(x + 2, y + 2, w - 4, h - 5, '#c2c9c4');
  p(x + 4, y + 2, w - 8, 6, '#dfdfc6');
  p(x + 7, y + 3, 7, 5, resident.hair); p(x + 8, y + 5, 6, 4, resident.skin);
  p(x + 9, y + 7, 2, 1, '#3b3b4e');
  p(x + 3, y + 9, w - 6, h - 11, '#687ca7'); p(x + 3, y + 9, w - 6, 2, '#a4b7cf');
  p(x + 5, y + 12, 2, Math.max(1, h - 15), '#8399ba');
  p(x + 1, y + h - 4, w - 2, 3, '#6d5960');
  p(x + 2, y + h - 1, 2, 2, '#3c4658'); p(x + w - 4, y + h - 1, 2, 2, '#3c4658');
  const lift = reduce ? 0 : Math.floor(time * .8) % 2;
  if (talking) {
    p(x + w - 1, y - 6, 13, 8, '#cad8dd');
    for (let i = 0; i < 3; i++) p(x + w + 1 + i * 3, y - 3, 1, 1, '#374761');
  } else {
    // Tiny pixel z, kept separate from real blocked/done status markers.
    p(x + w - 1, y - 4 - lift, 4, 1, '#b4cbe0'); p(x + w + 1, y - 3 - lift, 1, 1, '#b4cbe0');
    p(x + w, y - 2 - lift, 1, 1, '#b4cbe0'); p(x + w - 1, y - 1 - lift, 4, 1, '#b4cbe0');
  }
  ctx.restore();
}

export function paintCoop(ctx, routine) {
  if (!routine.hens.length) return;
  const { x, y, w, h } = routine.coop;
  const p = (dx, dy, width, height, color) => { ctx.fillStyle = color; ctx.fillRect(dx, dy, width, height); };
  ctx.save();
  p(x + 2, y + 5, w - 3, h - 4, '#725745'); p(x + 3, y + 6, w - 5, h - 6, '#bd9461');
  p(x, y + 4, w, 2, '#3e4045'); p(x + 2, y + 2, w - 4, 2, '#a16d51'); p(x + 5, y, w - 10, 2, '#c58e64');
  p(x + 7, y + 8, 5, 5, routine.settled ? '#7a6551' : '#343b44');
  if (routine.settled) { p(x + 7, y + 8, 5, 1, '#b09a70'); p(x + 9, y + 9, 1, 3, '#b09a70'); }
  p(x + 1, y + h, 3, 2, '#4b4847'); p(x + w - 5, y + h, 3, 2, '#4b4847');
  ctx.restore();
}

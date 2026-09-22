/** Door thresholds sit just outside collision bounds. Only crossing toward the
 * doorway changes scenes, so holding a key cannot bounce Jack back through it. */
export function cottageDoors(plots, visible = () => true) {
  return plots.flatMap(plot => [
    ...(visible(plot.agent) ? [{id: plot.agent.id, x: plot.x + 27, y: plot.y + 70, width: 18}] : []),
    ...(plot.kids || []).filter(kid => visible(kid.agent)).map(kid => ({id: kid.agent.id, x: kid.x + 8, y: kid.y + 21, width: 14})),
  ]);
}

/** A resident is interactable only while their own cottage still has a
 * rendered plot. Actors survive scene refreshes for animation continuity, so
 * the plot list is the authoritative visibility boundary. Roommates stay
 * talkable beside the stoop even when the host is indoors. */
export function residentTargets(actors, plots) {
  const rendered = new Set((plots || [])
    .filter(plot => plot?.agent && plot.hidden !== true && plot.rendered !== false && plot.visible !== false)
    .map(plot => plot.agent.id));
  const byId = new Map(actors || []);
  const hosts = [...byId].flatMap(([id, actor]) =>
    rendered.has(id) && !actor?.indoors ? [{id, x:actor.x + 5, y:actor.y + 14}] : []);
  const mates = (plots || []).flatMap(plot => {
    if (!rendered.has(plot.agent?.id)) return [];
    const actor = byId.get(plot.agent.id);
    const baseX = actor ? actor.x : plot.x + 22;
    const baseY = actor ? actor.y : plot.y + 52;
    return (plot.agent.roommates || [])
      .filter((mate) => mate.status !== "offline")
      .map((mate, i) => ({
        id: mate.id, x: baseX + 12 + i * 6, y: baseY + 14,
      }));
  });
  return hosts.concat(mates);
}

export function crossedDoor(from, to, doors, direction = 'in') {
  const dy = to.y - from.y;
  if (!Number.isFinite(dy) || (direction === 'out' ? dy <= 0 : dy >= 0)) return null;
  for (const door of doors) {
    const fraction = (door.y - from.y) / dy;
    if (fraction < 0 || fraction > 1) continue;
    const x = from.x + (to.x - from.x) * fraction;
    if (Math.abs(x - door.x) <= door.width / 2) return door;
  }
  return null;
}

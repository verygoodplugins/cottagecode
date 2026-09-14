/** Door thresholds sit just outside collision bounds. Only crossing toward the
 * doorway changes scenes, so holding a key cannot bounce Jack back through it. */
export function cottageDoors(plots, visible = () => true) {
  return plots.flatMap(plot => [
    ...(visible(plot.agent) ? [{id: plot.agent.id, x: plot.x + 27, y: plot.y + 70, width: 18}] : []),
    ...(plot.kids || []).filter(kid => visible(kid.agent)).map(kid => ({id: kid.agent.id, x: kid.x + 8, y: kid.y + 21, width: 14})),
  ]);
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

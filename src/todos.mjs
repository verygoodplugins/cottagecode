/** Explicit task checklists only. Never derive task status from prose. */
export const MAX_TODOS = 100;
const MAX_TEXT = 500;
const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function time(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[T ]/.test(value))) return null;
  const ms = typeof value === "number" ? value : Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/, "$1T$2Z"));
  return Number.isFinite(ms) && ms >= 1577836800000 ? ms : null;
}
function hash(value) {
  let n = 2166136261;
  for (const char of value) n = Math.imul(n ^ char.charCodeAt(0), 16777619);
  return (n >>> 0).toString(36);
}
function object(value) {
  if (typeof value === "string" && value.length <= 128 * 1024) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** null means no trustworthy snapshot; {items:[]} is an explicit cleared list. */
export function normalizeTodos(value, { source = "", updatedAt = null } = {}) {
  const snapshot = Array.isArray(value) ? { items: value } : object(value);
  if (!snapshot || !Array.isArray(snapshot.items)) return null;
  const items = [];
  const ids = new Map();
  let truncated = snapshot.items.length > MAX_TODOS || snapshot.truncated === true;
  for (const item of snapshot.items.slice(0, MAX_TODOS)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const body = text(item.text ?? item.content ?? item.step ?? item.title);
    let status = text(item.status).toLowerCase();
    if (status === "done") status = "completed";
    if (!status && typeof item.completed === "boolean") status = item.completed ? "completed" : "pending";
    if (!body || !STATUSES.has(status)) return null;
    const explicitId = text(item.id);
    const base = explicitId && explicitId.length <= 160 ? explicitId : `todo-${hash(body)}`;
    const count = (ids.get(base) || 0) + 1;
    ids.set(base, count);
    items.push({ id: count === 1 ? base : `${base}-${count}`, text: body.slice(0, MAX_TEXT), status });
    if (body.length > MAX_TEXT) truncated = true;
  }
  return {
    items,
    source: (text(source) || text(snapshot.source) || "feed").slice(0, 100),
    updatedAt: time(updatedAt) ?? time(snapshot.updatedAt),
    ...(snapshot.stale === true ? { stale: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function todosFromTool(name, input, options = {}) {
  const tool = text(name).split(/__|[.:/]/).at(-1)?.toLowerCase();
  const args = object(input);
  if (!args) return null;
  if (tool === "todowrite") return normalizeTodos(args.todos, { ...options, source: options.source || "transcript:TodoWrite" });
  if (tool === "update_plan") return normalizeTodos(args.plan, { ...options, source: options.source || "transcript:update_plan" });
  return null;
}

/** Accept plan arrays and complete tool arguments, never flattened plan previews. */
export function todosFromEvent(event, { source = "" } = {}) {
  if (!event || typeof event !== "object" || ["thinking", "redacted_thinking"].includes(event.kind)) return null;
  const updatedAt = event.timestamp ?? event.ts;
  if (event.todos !== undefined) return normalizeTodos(event.todos, { source, updatedAt });
  if (["plan", "todo_list", "todos", "plan_update"].includes(event.kind)) {
    const raw = event.items ?? event.plan;
    if (raw !== undefined) return normalizeTodos(raw, { source: source || "timeline:plan", updatedAt });
  }
  if (["tool", "tool_call", "tool_use"].includes(event.kind))
    return todosFromTool(event.tool || event.name || event.title, event.input ?? event.arguments ?? event.input_preview, { source, updatedAt });
  return null;
}

/** Events are supplied in source order. Explicit empty snapshots supersede older work. */
export function latestTodos(events, { source = "", initial = null } = {}) {
  let latest = normalizeTodos(initial);
  for (const event of events || []) {
    const candidate = todosFromEvent(event, { source });
    if (!candidate) continue;
    if (candidate.updatedAt !== null && latest?.updatedAt !== null && latest?.updatedAt > candidate.updatedAt) continue;
    latest = candidate;
  }
  return latest;
}

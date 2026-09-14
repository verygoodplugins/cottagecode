/** Public, bounded activity records. Private transcript thinking is never exported. */
const MAX_EVENTS = 2000;
const KINDS = new Map([
  ["request", "request"], ["user_message", "request"],
  ["progress", "progress"], ["assistant_message", "progress"],
  ["summary", "summary"], ["reasoning_summary", "summary"],
  ["plan", "summary"], ["question", "status"],
  ["tool", "tool"], ["tool_call", "tool"], ["tool_use", "tool"],
  ["result", "result"], ["tool_result", "result"],
  ["status", "status"], ["attempt_started", "status"], ["attempt_completed", "status"],
  ["attempt_boundary", "status"],
  ["handoff", "handoff"],
]);

export function timestampMs(value) {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}[T ]/.test(value.trim())) return null;
  const normalized = typeof value === "string"
    ? value.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/, "$1T$2Z")
    : value;
  const ms = typeof normalized === "number" ? normalized : Date.parse(normalized);
  return Number.isFinite(ms) && ms >= 1577836800000 ? ms : null;
}

export function safeActivityUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function normalizeActivityEvent(value) {
  if (!value || typeof value !== "object") return null;
  const kind = KINDS.get(value.kind);
  // In particular, AutoHub's `thinking` events contain raw private blocks.
  if (!kind || typeof value.id !== "string" || !value.id.trim()) return null;
  const body = value.text ?? value.detail ?? value.output_preview ?? "";
  const text = (typeof body === "string" ? body : "").trim();
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const label = text || title;
  if (!label) return null;
  const event = {
    id: value.id.slice(0, 400),
    timestamp: timestampMs(value.timestamp ?? value.ts),
    kind,
    text: label.slice(0, 1200),
  };
  const url = safeActivityUrl(value.url);
  if (url) event.url = url;
  if (kind === "handoff") {
    const town = label => typeof label === "string" && label.trim().length > 0 &&
      label.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(label) ? label.trim() : "";
    const from = town(value.from);
    const to = town(value.to);
    if (from && to) Object.assign(event, { from, to });
  }
  return event;
}

export function mergeActivityEvents(existing = [], incoming = [], max = MAX_EVENTS) {
  const records = new Map();
  for (const raw of [...existing, ...incoming]) {
    const event = normalizeActivityEvent(raw);
    if (event) records.set(event.id, event);
  }
  // Keep undated records at their source position; do not fabricate their clocks.
  // Anchoring only the sort key prevents new dated events slipping behind an
  // undated forward cursor (Codex transcripts often omit event timestamps).
  const events = [...records.values()];
  let anchor = events.find(event => event.timestamp !== null)?.timestamp || 0;
  return events.map(event => {
    if (event.timestamp !== null) anchor = event.timestamp;
    return { event, order: anchor };
  }).sort((a, b) => a.order - b.order).slice(-max).map(entry => entry.event);
}

export function pageActivity(events, { after, before, limit = 100, source = "none" } = {}) {
  const cap = Math.min(500, Math.max(1, Number(limit) || 100));
  let start = 0;
  let end = events.length;
  let cursorReset = false;
  if (before) {
    end = events.findIndex(event => event.id === before);
    if (end < 0) { end = 0; cursorReset = true; }
  } else if (after) {
    const index = events.findIndex(event => event.id === after);
    if (index < 0) cursorReset = true;
    else start = index + 1;
  }
  const forward = Boolean(after && !cursorReset);
  const selected = forward ? events.slice(start, Math.min(end, start + cap)) : events.slice(Math.max(start, end - cap), end);
  const hasMore = forward ? start + selected.length < end : end - selected.length > 0;
  return {
    events: selected,
    source,
    hasMore,
    cursor: (before ? selected[0]?.id : selected.at(-1)?.id) || (after && !cursorReset ? after : null),
    ...(cursorReset ? { cursorReset: true } : {}),
  };
}

/** AutoHub only supports backwards cursors, so retain safe events for forward polls. */
export function createHubTimelineReader({
  baseUrl = process.env.COTTAGE_HUB_URL || "",
  token = process.env.COTTAGE_HUB_TOKEN || "",
  fetchFn = globalThis.fetch,
  now = Date.now,
  ttl = 1500,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let base = null;
  try {
    const candidate = new URL(baseUrl);
    if (["http:", "https:"].includes(candidate.protocol) && !candidate.username && !candidate.password) base = candidate;
  } catch { /* Unconfigured source stays explicitly unavailable. */ }

  async function refresh(taskId, options) {
    const old = cache.get(taskId);
    if (old && !options.before && now() - old.checkedAt < ttl) return old;
    const entry = old ? { ...old } : { events: [], hasOlder: false, checkedAt: 0, source: "none" };
    let before = options.before || "";
    try {
      for (let page = 0; page < 4; page++) {
        const url = new URL(base.href);
        const root = url.pathname.replace(/\/$/, "").replace(/\/v1$/, "");
        url.pathname = `${root}/v1/tasks/${encodeURIComponent(taskId)}/timeline`;
        url.search = "";
        url.searchParams.set("limit", "500");
        if (before) url.searchParams.set("before", before);
        const response = await fetchFn(url, {
          headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(4000),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Timeline unavailable (HTTP ${response.status})`);
        const body = await response.json();
        if (!Array.isArray(body.events)) throw new Error("Timeline returned an invalid event list");
        const safe = body.events.map(normalizeActivityEvent).filter(Boolean);
        entry.events = before ? mergeActivityEvents(safe, entry.events) : mergeActivityEvents(entry.events, safe);
        entry.source = body.source && body.source !== "none" ? `hub:${String(body.source).slice(0, 60)}` : "none";
        entry.hasOlder = Boolean(body.has_more ?? body.hasMore);
        const needsCursor = options.after && !entry.events.some(event => event.id === options.after);
        if (!entry.hasOlder || (!needsCursor && (safe.length || !body.events.length))) break;
        const next = body.events[0]?.id;
        if (typeof next !== "string" || next === before) break;
        before = next;
      }
      entry.checkedAt = now();
      entry.stale = false;
      delete entry.error;
    } catch (error) {
      entry.stale = true;
      entry.error = error.name === "TimeoutError" ? "Timeline request timed out" : "Timeline temporarily unavailable";
      // Never copy fetch errors: their messages may include deployment credentials.
      entry.checkedAt = now();
    }
    cache.set(taskId, entry);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return entry;
  }

  return {
    configured: Boolean(base),
    async read(taskId, options = {}) {
      if (!base || !taskId) return { ...pageActivity([], options), unavailable: true };
      const key = `${taskId}\n${options.before || ""}`;
      if (!inFlight.has(key)) inFlight.set(key, refresh(taskId, options).finally(() => inFlight.delete(key)));
      const entry = await inFlight.get(key);
      const result = pageActivity(entry.events, { ...options, source: entry.source });
      if (!options.after && entry.hasOlder) result.hasMore = true;
      return { ...result, checkedAt: entry.checkedAt, ...(entry.stale ? { stale: true, error: entry.error } : {}) };
    },
  };
}

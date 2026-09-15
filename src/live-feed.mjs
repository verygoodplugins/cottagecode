import { feedEnvelope } from "./feed-client.mjs";

/** New feed connections must not retain a prior endpoint's paths or couriers. */
export function blankFeedMeta() {
  return { source: "", relationships: [], handoffs: [] };
}

/**
 * Read a feed only while its endpoint is still the selected endpoint. This
 * prevents a late response from one feed populating another feed's town.
 */
export async function readCurrentFeed(endpoint, {
  fetchFn = fetch,
  isCurrent = () => true,
  signal,
} = {}) {
  try {
    const response = await fetchFn(endpoint, { headers: { accept: "application/json" }, signal });
    if (!isCurrent(endpoint)) return { kind: "superseded" };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!isCurrent(endpoint)) return { kind: "superseded" };
    return { kind: "success", data: feedEnvelope(payload) };
  } catch (error) {
    return isCurrent(endpoint) ? { kind: "error", error } : { kind: "superseded" };
  }
}

/**
 * Coalesce refresh requests and run one more pass whenever the active pass was
 * superseded. `run` returns true when its result must be discarded and retried.
 */
export function createLatestRefresh(run) {
  let active = null;
  let rerun = false;
  return function refresh({ latest = false } = {}) {
    if (active) {
      if (latest) rerun = true;
      return active;
    }
    active = (async () => {
      try {
        do {
          rerun = false;
          if (await run()) rerun = true;
        } while (rerun);
      } finally {
        active = null;
      }
    })();
    return active;
  };
}

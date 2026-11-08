/** One resumable, server-only Hub telemetry connection. Only invalidation hints
 * cross this boundary; canonical task detail remains the lifecycle authority. */
const identifier = value => typeof value === 'string' && value.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/.test(value);
const cursorValue = value => typeof value === 'string' && /^\d{1,40}$/.test(value);

export function createHubEventStream({
  url, token = '', fetchFn = globalThis.fetch, onChange = () => {},
  retryMs = 2000, connectTimeoutMs = 10000, idleTimeoutMs = 45000,
  maxFrameBytes = 256 * 1024,
} = {}) {
  let active = false, generation = 0, cursor = null, controller = null, currentReader = null;
  let retryTimer = null, connectTimer = null, idleTimer = null;
  let reconnectMs = retryMs, failures = 0;
  const clearConnectionTimers = () => {
    clearTimeout(connectTimer); clearTimeout(idleTimer);
    connectTimer = idleTimer = null;
  };
  const notify = (hint, current) => {
    if (active && generation === current) onChange(hint);
  };

  async function connect(current) {
    const abort = new AbortController(); controller = abort;
    connectTimer = setTimeout(() => abort.abort(), connectTimeoutMs);
    connectTimer.unref?.();
    let reader;
    try {
      const response = await fetchFn(url, {
        headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cursor ? { 'last-event-id': cursor } : {}) },
        redirect: 'error', signal: abort.signal,
      });
      if (!active || generation !== current) { await response.body?.cancel?.(); return; }
      clearTimeout(connectTimer); connectTimer = null;
      if (!response.ok || !response.headers?.get('content-type')?.includes('text/event-stream') || !response.body?.getReader) {
        await response.body?.cancel?.(); throw new Error('Hub stream unavailable');
      }
      failures = 0;
      // Connect before resnapshotting: subsequent events fence any in-flight
      // canonical read, including the first connection's head-to-read window.
      notify({ type: 'resync' }, current);
      const decoder = new TextDecoder(); let pending = '', event = '', data = [], id = null, frameBytes = 0;
      const dispatch = () => {
        if (event === 'reset' || event === 'snapshot') {
          notify({ type: 'resync' }, current);
        } else if (event === 'agent_event' && data.length) {
          let envelope;
          try { envelope = JSON.parse(data.join('\n')); } catch { throw new Error('Invalid Hub stream frame'); }
          if (envelope?.schemaVersion === 1 && envelope.kind === 'diagnostic' && envelope.payload?.code === 'telemetry_gap') {
            notify({ type: 'resync' }, current);
          } else if (envelope?.schemaVersion === 1 && envelope.kind === 'task_updated' && envelope.payload?.resync === true) {
            // Canonical public IDs can exceed telemetry's bounded vocabulary.
            // A global hint preserves those tasks through a canonical resnapshot.
            notify({ type: 'resync' }, current);
          } else if (envelope?.schemaVersion === 1 && identifier(envelope.taskId)) {
            const type = ['task_updated', 'lifecycle'].includes(envelope.kind) ? 'task' :
              ['tool', 'usage', 'context', 'progress', 'diagnostic'].includes(envelope.kind) ? 'telemetry' : null;
            if (type) notify({ type, taskId: envelope.taskId,
              parentTaskId: identifier(envelope.parentTaskId) ? envelope.parentTaskId : null }, current);
          }
        }
        if (id !== null && cursorValue(id)) cursor = id;
        event = ''; data = []; id = null; frameBytes = 0;
      };
      const line = value => {
        if (value === '') { dispatch(); return; }
        frameBytes += value.length;
        if (frameBytes > maxFrameBytes) throw new Error('Hub stream frame too large');
        if (value[0] === ':') return;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        let content = colon < 0 ? '' : value.slice(colon + 1);
        if (content[0] === ' ') content = content.slice(1);
        if (field === 'event') event = content;
        else if (field === 'data') data.push(content);
        else if (field === 'id') id = content;
        else if (field === 'retry' && /^\d+$/.test(content)) reconnectMs = Math.max(250, Math.min(30000, Number(content)));
      };
      reader = currentReader = response.body.getReader();
      abort.signal.addEventListener('abort', () => { void reader.cancel().catch(() => {}); }, { once: true });
      while (active && generation === current && !abort.signal.aborted) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abort.abort(), idleTimeoutMs); idleTimer.unref?.();
        const { done, value } = await reader.read();
        if (done || !active || generation !== current || abort.signal.aborted) break;
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const next = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
          line(next);
        }
        // Bound even an unterminated line; complete frames are discarded as read.
        if (pending.length + frameBytes > maxFrameBytes) throw new Error('Hub stream frame too large');
      }
    } catch { failures++; /* Polling retains recovery; never export upstream errors. */ }
    finally {
      abort.abort();
      try { await reader?.cancel(); } catch { /* Already aborted. */ }
      if (generation === current) {
        clearConnectionTimers(); controller = currentReader = null;
        if (active) {
          const delay = Math.min(30000, reconnectMs * 2 ** Math.min(failures, 4));
          retryTimer = setTimeout(() => { retryTimer = null; void connect(current); }, delay);
          retryTimer.unref?.();
        }
      }
    }
  }

  return {
    start() { if (!active) { active = true; generation++; void connect(generation); } },
    stop() {
      active = false; generation++; controller?.abort(); controller = null;
      void currentReader?.cancel().catch(() => {}); currentReader = null;
      clearTimeout(retryTimer); retryTimer = null; clearConnectionTimers();
    },
  };
}

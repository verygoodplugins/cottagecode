/**
 * Opt-in ambient beds played through at most two reusable HTMLAudio elements.
 * Catalog phase may be a string or an array; exact town/phase wins, then a
 * generic phase bed, then generic `any`. No preferences are persisted.
 */
export function createMusic({
  tracks = [], audioFactory = () => new globalThis.Audio(),
  now = () => globalThis.performance?.now() ?? Date.now(),
  setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout,
  visibilitySource = globalThis.document, fadeMs = 1800, switchDelayMs = 4000,
  loadTimeoutMs = 15000,
} = {}) {
  const clamp = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : fallback;
  const catalog = [];
  for (const raw of Array.isArray(tracks) ? tracks : []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id || typeof raw.url !== 'string' || !raw.url.trim() || catalog.some(track => track.id === raw.id)) continue;
    const phases = (Array.isArray(raw.phase) ? raw.phase : [raw.phase || 'any']).filter(phase => typeof phase === 'string').map(phase => phase.trim().toLowerCase());
    catalog.push({ id: raw.id, title: typeof raw.title === 'string' ? raw.title : raw.id, url: raw.url,
      phases, town: typeof raw.town === 'string' ? raw.town : '', duration: Number(raw.duration) || null });
    if (catalog.length === 64) break;
  }
  fadeMs = Math.max(100, Number(fadeMs) || 1800);
  switchDelayMs = Math.max(0, Number(switchDelayMs) || 0);
  loadTimeoutMs = Math.max(1000, Number(loadTimeoutMs) || 15000);
  const slots = [];
  let enabled = false, disposed = false, hidden = Boolean(visibilitySource?.hidden), volume = .16;
  let scene = { phase: 'day', town: '', indoors: false, talking: false };
  let current = null, incoming = null, timer = null, change = null, error = '';
  let master = .16, masterRamp = null;
  const targetVolume = () => volume * (scene.indoors ? .65 : 1) * (scene.talking ? .25 : 1);
  const sameTrack = (a, b) => (a?.id || null) === (b?.id || null);
  function select() {
    const phase = track => track.phases.includes(scene.phase);
    return catalog.find(track => track.town === scene.town && track.town && phase(track)) ||
      catalog.find(track => !track.town && phase(track)) ||
      catalog.find(track => !track.town && track.phases.includes('any')) || null;
  }
  let desired = select();

  function interpolate(ramp, time) {
    const progress = Math.max(0, Math.min(1, (time - ramp.start) / ramp.duration));
    const smooth = progress * progress * (3 - 2 * progress);
    return { value: ramp.from + (ramp.to - ramp.from) * smooth, done: progress === 1 };
  }
  function settle(slot, value) { const resolve = slot.resolve; slot.resolve = null; resolve?.(value); }
  function release(slot) {
    if (!slot) return;
    slot.version++;
    slot.audio.onended = slot.audio.onerror = slot.audio.onwaiting = slot.audio.onplaying = null;
    try { slot.audio.volume = 0; slot.audio.pause(); } catch { /* A failed device is already silent. */ }
    try { slot.audio.removeAttribute('src'); slot.audio.load(); } catch { /* Release when supported. */ }
    if (current === slot) current = null;
    if (incoming === slot) incoming = null;
    slot.track = null; slot.playing = false; slot.loading = false; slot.buffering = false;
    slot.weight = 0; slot.ramp = null;
    settle(slot, false);
  }
  function stopImmediately() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null; change = null;
    for (const slot of slots) if (slot.track) release(slot);
  }
  function fail(message) {
    error = message; enabled = false;
    stopImmediately();
  }
  function rampSlot(slot, to, duration = fadeMs, retire = false) {
    if (slot.ramp) slot.weight = interpolate(slot.ramp, now()).value;
    slot.ramp = { from: slot.weight, to, start: now(), duration, retire };
  }
  function applyVolume(slot) {
    try { slot.audio.volume = clamp(master * slot.weight, 0); }
    catch { fail('Music volume could not be changed on this device.'); }
  }
  function updateMaster(duration = 650) {
    if (masterRamp) master = interpolate(masterRamp, now()).value;
    masterRamp = { from: master, to: targetVolume(), start: now(), duration };
    schedule();
  }
  function obtainSlot() {
    let slot = slots.find(candidate => !candidate.track);
    if (!slot && slots.length < 2) {
      const audio = audioFactory();
      if (!audio || typeof audio.play !== 'function' || typeof audio.pause !== 'function') throw new Error('unsupported_audio');
      slot = { audio, version: 0, track: null, weight: 0, playing: false, loading: false, buffering: false, ramp: null, resolve: null };
      slots.push(slot);
    }
    if (!slot) {
      slot = slots.find(candidate => candidate !== current) || slots[0];
      release(slot);
    }
    return slot;
  }
  function start(track, { loop = false, duration = fadeMs } = {}) {
    if (!enabled || hidden || disposed || !track) return Promise.resolve(false);
    if (!loop && incoming && sameTrack(incoming.track, track)) return incoming.promise;
    if (!loop && current?.playing && sameTrack(current.track, track)) {
      if (incoming) release(incoming);
      rampSlot(current, 1);
      for (const slot of slots) if (slot !== current && slot.track) rampSlot(slot, 0, duration, true);
      schedule();
      return Promise.resolve(true);
    }
    if (incoming) release(incoming);
    let slot;
    try { slot = obtainSlot(); }
    catch { fail('Music playback is not supported on this device.'); return Promise.resolve(false); }
    const version = ++slot.version;
    slot.track = track; slot.weight = 0; slot.ramp = null; slot.loading = true;
    slot.deadline = now() + loadTimeoutMs;
    slot.promise = new Promise(resolve => { slot.resolve = resolve; });
    incoming = slot;
    const active = () => slot.version === version && slot.track === track && enabled && !hidden && !disposed;
    slot.audio.onended = () => {
      if (!active()) return;
      const wasCurrent = current === slot;
      release(slot);
      if (wasCurrent && !incoming) void start(track, { loop: true });
    };
    slot.audio.onerror = () => { if (active()) fail('Music could not load. Enable it again to retry.'); };
    slot.audio.onwaiting = () => { if (active()) { slot.buffering = true; slot.deadline = now() + loadTimeoutMs; } };
    slot.audio.onplaying = () => { if (active()) slot.buffering = false; };
    try {
      slot.audio.preload = 'auto'; slot.audio.loop = false; slot.audio.volume = 0;
      slot.audio.src = track.url;
      // Keep this call synchronous with enable(true), preserving the user's
      // activation gesture. No fetch, decoding, or media exists before opt-in.
      const played = slot.audio.play();
      Promise.resolve(played).then(() => {
        if (!active()) {
          // A reused element may already be playing a newer source. Only stop
          // abandoned playback; an obsolete promise must not pause its successor.
          if (!slot.track || !enabled || hidden || disposed) { try { slot.audio.pause(); } catch {} }
          return;
        }
        const previous = current;
        slot.loading = false; slot.playing = true; slot.buffering = false;
        current = slot; incoming = null;
        rampSlot(slot, 1, duration);
        if (previous && previous !== slot) rampSlot(previous, 0, duration, true);
        settle(slot, true); schedule();
      }, reason => {
        if (active()) fail(reason?.name === 'NotAllowedError'
          ? 'Playback was blocked. Enable music again to allow it.'
          : 'Music could not play. Enable it again to retry.');
      });
    } catch { fail('Music could not play on this device.'); }
    schedule();
    return slot.promise;
  }
  function tick() {
    const time = now();
    if (disposed || hidden) return;
    if (masterRamp) {
      const next = interpolate(masterRamp, time); master = next.value;
      if (next.done) masterRamp = null;
    }
    for (const slot of slots) {
      if (!slot.track) continue;
      if ((slot.loading || slot.buffering) && time >= slot.deadline) { fail('Music took too long to load. Enable it again to retry.'); return; }
      if (slot.ramp) {
        const next = interpolate(slot.ramp, time); slot.weight = next.value;
        if (next.done) {
          const retire = slot.ramp.retire; slot.ramp = null;
          if (retire) { release(slot); continue; }
        }
      }
      applyVolume(slot);
    }
    if (!enabled) return;
    if (change && time >= change.at) {
      const track = change.track; change = null;
      if (track) void start(track);
      else for (const slot of slots) if (slot.track) rampSlot(slot, 0, fadeMs, true);
    }
    if (current?.playing && !incoming && !current.ramp?.retire) {
      const duration = Number.isFinite(current.audio.duration) && current.audio.duration > 0 ? current.audio.duration : current.track.duration;
      const overlap = duration ? Math.min(fadeMs / 1000, duration / 4) : 0;
      if (overlap > 0 && current.audio.currentTime >= duration - overlap)
        void start(current.track, { loop: true, duration: overlap * 1000 });
    }
  }
  function schedule() {
    if (timer !== null || disposed || hidden || (!enabled && !slots.some(slot => slot.track))) return;
    timer = setTimeoutFn(() => { timer = null; tick(); schedule(); }, 50);
  }
  function enable(value) {
    if (disposed) return Promise.resolve(false);
    if (!value && !enabled) return Promise.resolve(false);
    enabled = Boolean(value); change = null;
    if (!enabled) {
      if (incoming) release(incoming);
      for (const slot of slots) if (slot.track) rampSlot(slot, 0, Math.min(fadeMs, 450), true);
      schedule();
      return Promise.resolve(false);
    }
    error = ''; desired = select();
    if (hidden) return Promise.resolve(true);
    if (!desired) { fail('No music is available for this scene.'); return Promise.resolve(false); }
    if (!slots.some(slot => slot.track)) { master = targetVolume(); masterRamp = null; }
    return start(desired);
  }
  function setScene(value = {}) {
    if (disposed) return;
    if (typeof value.phase === 'string') scene.phase = value.phase.trim().toLowerCase();
    if (typeof value.town === 'string') scene.town = value.town;
    const before = targetVolume();
    if (typeof value.indoors === 'boolean') scene.indoors = value.indoors;
    if (typeof value.talking === 'boolean') scene.talking = value.talking;
    if (targetVolume() !== before) updateMaster(scene.talking ? 350 : 800);
    const next = select();
    if (!sameTrack(next, desired)) {
      desired = next;
      if (enabled && !hidden) {
        if (incoming && !sameTrack(incoming.track, next)) release(incoming);
        change = sameTrack(current?.track, next) ? null : { track: next, at: now() + switchDelayMs };
        schedule();
      }
    }
  }
  function setHidden(value) {
    if (disposed || hidden === Boolean(value)) return;
    hidden = Boolean(value);
    if (hidden) stopImmediately();
    else if (enabled) { master = targetVolume(); masterRamp = null; desired = select(); if (desired) void start(desired); }
  }
  const visibilityChanged = () => setHidden(Boolean(visibilitySource?.hidden));
  visibilitySource?.addEventListener?.('visibilitychange', visibilityChanged);
  return {
    enable, setScene, setHidden,
    get volume() { return volume; },
    set volume(value) { if (!disposed) { volume = clamp(value, volume); updateMaster(); } },
    get enabled() { return enabled; },
    get state() {
      const playing = !hidden && slots.some(slot => slot.playing && !slot.audio.paused);
      const audible = playing && slots.some(slot => slot.playing && !slot.audio.paused && slot.audio.volume > .0001);
      const status = disposed ? 'disposed' : error ? 'error' : hidden && enabled ? 'paused' : !enabled ? playing ? 'stopping' : 'off'
        : incoming ? current?.playing ? 'switching' : 'starting' : current?.buffering ? 'buffering' : playing ? 'playing' : 'unavailable';
      return { enabled, playing, audible, hidden, status, volume, effectiveVolume: targetVolume(),
        track: current?.track ? { id: current.track.id, title: current.track.title } : null,
        pendingTrackId: incoming?.track?.id || change?.track?.id || null, error };
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; stopImmediately();
      visibilitySource?.removeEventListener?.('visibilitychange', visibilityChanged);
    },
  };
}

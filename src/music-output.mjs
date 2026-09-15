/** Lazy, quiet output for the two reusable media elements used by createMusic. */
export function createMusicOutput({
  Audio = globalThis.Audio,
  AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
} = {}) {
  const entries = [];
  let context = null, disposed = false, closing = null;
  const attempt = fn => { try { fn(); } catch {} };
  const cancelled = () => Object.assign(new Error('Music playback was cancelled.'), { name: 'AbortError' });

  function quiet(entry) {
    entry.version++; entry.wanted = false; entry.ready = false;
    try {
      if (entry.gain) entry.gain.gain.value = 0;
      else entry.audio.volume = 0;
    } catch { attempt(() => { entry.audio.muted = true; }); }
    attempt(() => entry.audio.pause());
  }
  function release(entry) {
    quiet(entry);
    attempt(() => { entry.audio.muted = true; });
    for (const event of ['onended', 'onerror', 'onwaiting', 'onplaying']) attempt(() => { entry.audio[event] = null; });
    attempt(() => entry.audio.removeAttribute('src'));
    attempt(() => entry.audio.load());
    attempt(() => entry.source?.disconnect());
    attempt(() => entry.gain?.disconnect());
  }
  function gain(entry, value) {
    try { entry.gain.gain.value = value; }
    catch (error) { quiet(entry); throw error; }
  }
  function routed(entry) {
    const audio = entry.audio;
    const adapter = {
      play() {
        if (disposed) return Promise.reject(cancelled());
        const version = ++entry.version;
        entry.wanted = true; entry.ready = false;
        let resumed, played;
        const failed = error => {
          if (entry.version === version || !entry.wanted || disposed) quiet(entry);
          throw error;
        };
        try {
          gain(entry, 0); audio.muted = false;
          // Both calls happen in the enabling gesture, without an await between
          // them. The gain stays zero until both operations have succeeded.
          resumed = Promise.resolve(context.resume());
          played = Promise.resolve(audio.play());
        } catch (error) {
          resumed?.catch(() => {});
          try { failed(error); } catch (failure) { return Promise.reject(failure); }
        }
        // Some engines settle an old play after pause. Keep it silent without
        // allowing an obsolete completion to interrupt a newer play request.
        void played.then(() => {
          if (!entry.wanted || disposed) quiet(entry);
        }, () => {});
        return Promise.all([resumed, played]).then(() => {
          if (disposed || entry.version !== version || !entry.wanted) throw cancelled();
          if (context.state !== 'running') throw new Error('The music output did not start.');
          entry.ready = true; gain(entry, entry.volume);
        }).catch(failed);
      },
      pause() { quiet(entry); },
      load() { quiet(entry); audio.load(); },
      removeAttribute(name) { if (name === 'src') quiet(entry); audio.removeAttribute(name); },
      get volume() { return entry.volume; },
      set volume(value) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Music volume must be between 0 and 1.');
        entry.volume = value;
        if (!disposed) gain(entry, entry.ready ? value : 0);
      },
      get src() { return audio.src; },
      set src(value) { quiet(entry); audio.src = value; },
    };
    for (const name of ['paused', 'duration']) Object.defineProperty(adapter, name, { get: () => audio[name] });
    for (const name of ['preload', 'loop', 'currentTime', 'onended', 'onerror', 'onwaiting', 'onplaying']) {
      Object.defineProperty(adapter, name, { get: () => audio[name], set: value => { audio[name] = value; } });
    }
    return adapter;
  }

  return {
    create() {
      if (disposed) throw cancelled();
      if (entries.length >= 2) throw new Error('Music already has two output elements.');
      if (typeof Audio !== 'function') throw new Error('Audio playback is unavailable.');
      const audio = new Audio(), entry = { audio, volume: 0, version: 0, wanted: false, ready: false };
      let nativeVolume = false;
      try { audio.volume = 0; nativeVolume = audio.volume === 0; } catch {}
      if (nativeVolume) { entries.push(entry); return audio; }
      try {
        audio.muted = true;
        if (typeof AudioContext !== 'function') throw new Error('Quiet music output is unavailable.');
        context ||= new AudioContext();
        entry.source = context.createMediaElementSource(audio);
        entry.gain = context.createGain();
        entry.gain.gain.value = 0;
        entry.source.connect(entry.gain); entry.gain.connect(context.destination);
        audio.muted = false;
        const adapter = routed(entry);
        entries.push(entry);
        return adapter;
      } catch (error) {
        release(entry); // A failed attempt does not consume a reusable slot.
        throw error;
      }
    },
    suspend() {
      for (const entry of entries) quiet(entry);
      if (!context || disposed || context.state === 'closed') return Promise.resolve(true);
      try { return Promise.resolve(context.suspend()).then(() => true, () => false); }
      catch { return Promise.resolve(false); }
    },
    dispose() {
      if (closing) return closing;
      disposed = true;
      for (const entry of entries) release(entry);
      try { closing = context ? Promise.resolve(context.close()).then(() => true, () => false) : Promise.resolve(true); }
      catch { closing = Promise.resolve(false); }
      return closing;
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusicOutput } from '../src/music-output.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture({ ignored = false, playPlan, resumePlan, failNode = false, lifecycleFailure = false } = {}) {
  const media = [], contexts = [], calls = [];
  class Audio {
    storedVolume = 1; muted = false; paused = true; src = ''; duration = 65; currentTime = 0;
    constructor() { media.push(this); }
    get volume() { return ignored ? 1 : this.storedVolume; }
    set volume(value) { if (!ignored) this.storedVolume = value; }
    play() {
      calls.push('play');
      if (ignored) assert.equal(contexts[0].gains.find(gain => gain.audio === this)?.gain.value, 0, 'gain is zero before native playback');
      if (playPlan instanceof Error) throw playPlan;
      const result = typeof playPlan === 'function' ? playPlan() : playPlan;
      return Promise.resolve(result).then(() => { this.paused = false; });
    }
    pause() { this.paused = true; calls.push('pause'); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.paused = true; this.currentTime = 0; }
  }
  class AudioContext {
    state = 'suspended'; destination = {}; gains = []; sources = []; resumes = 0; suspends = 0; closes = 0;
    constructor() { contexts.push(this); }
    createMediaElementSource(audio) {
      const source = { audio, connected: null, disconnected: false,
        connect: gain => { gain.audio = audio; source.connected = gain; return gain; },
        disconnect: () => { source.disconnected = true; source.connected = null; } };
      this.sources.push(source); return source;
    }
    createGain() {
      if (typeof failNode === 'function' ? failNode() : failNode) throw new Error('Node unavailable');
      const gain = { gain: { value: 1 }, connected: null, disconnected: false,
        connect: destination => { assert.equal(gain.gain.value, 0, 'connect starts silent'); gain.connected = destination; },
        disconnect: () => { gain.disconnected = true; gain.connected = null; } };
      this.gains.push(gain); return gain;
    }
    resume() {
      calls.push('resume'); this.resumes++;
      if (resumePlan instanceof Error) throw resumePlan;
      const result = typeof resumePlan === 'function' ? resumePlan() : resumePlan;
      return Promise.resolve(result).then(() => { this.state = 'running'; });
    }
    suspend() { this.suspends++; this.state = 'suspended'; return lifecycleFailure ? Promise.reject(new Error('suspend failed')) : Promise.resolve(); }
    close() { this.closes++; this.state = 'closed'; return lifecycleFailure ? Promise.reject(new Error('close failed')) : Promise.resolve(); }
  }
  const output = createMusicOutput({ Audio, AudioContext });
  return { output, media, contexts, calls };
}

test('native output stays lazy and avoids an audio context when volume works', async () => {
  const f = fixture();
  await f.output.suspend();
  assert.equal(f.media.length, 0); assert.equal(f.contexts.length, 0);
  const audio = f.output.create();
  assert.equal(audio, f.media[0]); assert.equal(audio.volume, 0);
  audio.src = '/day.mp3'; audio.volume = .16; await audio.play();
  assert.equal(audio.volume, .16); assert.equal(audio.paused, false);
  await f.output.suspend();
  assert.equal(audio.paused, true); assert.equal(audio.volume, 0);
  assert.equal(f.contexts.length, 0);
  f.output.create();
  assert.throws(() => f.output.create(), /two output/);
  await f.output.dispose();
  assert.ok(f.media.every(audio => audio.paused && audio.muted && !audio.src));
  assert.throws(() => f.output.create(), { name: 'AbortError' });
});

test('ignored native volume uses one context and two independently quiet gain paths', async () => {
  const f = fixture({ ignored: true }), a = f.output.create(), b = f.output.create();
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].sources.length, 2);
  assert.equal(f.contexts[0].gains.length, 2); assert.throws(() => f.output.create(), /two output/);
  a.volume = .16; b.volume = .08;
  assert.equal(a.volume, .16); assert.equal(f.media[0].volume, 1);
  assert.equal(f.contexts[0].gains[0].gain.value, 0);
  const playing = a.play();
  assert.deepEqual(f.calls.slice(-2), ['resume', 'play'], 'both calls are synchronous');
  assert.equal(f.contexts[0].gains[0].gain.value, 0);
  await playing;
  assert.equal(f.contexts[0].gains[0].gain.value, .16);
  a.volume = .026; assert.equal(f.contexts[0].gains[0].gain.value, .026);
  await b.play(); assert.equal(f.contexts[0].gains[1].gain.value, .08);
  assert.equal(f.contexts[0].gains[0].gain.value, .026);
  await f.output.dispose();
  assert.equal(f.contexts[0].closes, 1);
  assert.ok(f.contexts[0].sources.every(source => source.disconnected));
  assert.ok(f.contexts[0].gains.every(gain => gain.disconnected && gain.gain.value === 0));
});

test('fallback delegates the media interface and pauses while preserving requested volume', async () => {
  const f = fixture({ ignored: true }), a = f.output.create(), raw = f.media[0];
  a.src = '/night.mp3'; a.preload = 'auto'; a.loop = false; a.currentTime = 12;
  const event = () => {};
  for (const name of ['onended', 'onerror', 'onwaiting', 'onplaying']) { a[name] = event; assert.equal(raw[name], event); assert.equal(a[name], event); }
  assert.equal(a.src, raw.src); assert.equal(raw.preload, 'auto'); assert.equal(raw.loop, false);
  assert.equal(a.currentTime, 12); assert.equal(a.duration, 65); assert.equal(a.paused, true);
  a.volume = .1; await a.play(); a.pause();
  assert.equal(a.paused, true); assert.equal(a.volume, .1); assert.equal(f.contexts[0].gains[0].gain.value, 0);
  await a.play(); assert.equal(f.contexts[0].gains[0].gain.value, .1);
  a.load(); assert.equal(a.currentTime, 0); assert.equal(a.paused, true);
  a.removeAttribute('src'); assert.equal(a.src, '');
  assert.throws(() => { a.volume = NaN; }, RangeError);
  assert.throws(() => { a.volume = 2; }, RangeError);
  await f.output.dispose();
});

test('resume and native play failures never release the gain and late starts stay paused', async () => {
  for (const failing of ['resume', 'play']) {
    const pending = deferred(), reason = Object.assign(new Error('Denied'), { name: 'NotAllowedError' });
    const f = fixture({ ignored: true, resumePlan: failing === 'resume' ? () => Promise.reject(reason) : pending.promise,
      playPlan: failing === 'play' ? () => Promise.reject(reason) : pending.promise });
    const a = f.output.create(); a.volume = .16;
    await assert.rejects(a.play(), { name: 'NotAllowedError' });
    assert.equal(f.contexts[0].gains[0].gain.value, 0); assert.equal(a.paused, true);
    pending.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(a.paused, true); assert.equal(f.contexts[0].gains[0].gain.value, 0);
    await f.output.dispose();
  }
  for (const key of ['resumePlan', 'playPlan']) {
    const f = fixture({ ignored: true, [key]: new Error('Synchronous failure') }), a = f.output.create();
    await assert.rejects(a.play(), /Synchronous failure/);
    assert.equal(a.paused, true); assert.equal(f.contexts[0].gains[0].gain.value, 0);
    await f.output.dispose();
  }
});

test('failed graph creation frees the slot budget and cannot expose unattenuated media', async () => {
  let attempts = 0;
  const f = fixture({ ignored: true, failNode: () => attempts++ === 0 });
  assert.throws(() => f.output.create(), /Node unavailable/);
  assert.equal(f.media[0].muted, true); assert.equal(f.media[0].paused, true);
  assert.equal(f.contexts[0].sources[0].disconnected, true);
  f.output.create(); f.output.create();
  assert.throws(() => f.output.create(), /two output/);
  assert.equal(f.contexts.length, 1);
  await f.output.dispose();
  const unsupported = createMusicOutput({ Audio: class { get volume() { return 1; } set volume(value) {} pause() {} }, AudioContext: null });
  assert.throws(() => unsupported.create(), /Quiet music output/);
  await unsupported.dispose();
});

test('suspend and disposal are silent immediately and suppress late play completion', async () => {
  for (const action of ['suspend', 'dispose']) {
    const pending = deferred(), f = fixture({ ignored: true, playPlan: pending.promise }), a = f.output.create();
    a.volume = .16; const playing = a.play();
    await f.output[action]();
    assert.equal(a.paused, true); assert.equal(f.contexts[0].gains[0].gain.value, 0);
    pending.resolve(); await assert.rejects(playing, { name: 'AbortError' });
    assert.equal(a.paused, true); assert.equal(f.contexts[0].gains[0].gain.value, 0);
    await f.output.dispose(); await f.output.dispose();
    assert.equal(f.contexts[0].closes, 1);
    await assert.rejects(a.play(), { name: 'AbortError' });
  }
});

test('a cancelled play cannot silence a newer play on the same element', async () => {
  const pending = deferred(); let attempts = 0;
  const f = fixture({ ignored: true, playPlan: () => attempts++ ? undefined : pending.promise }), a = f.output.create();
  a.volume = .16; const first = a.play(); a.pause(); await a.play();
  pending.resolve(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(a.paused, false); assert.equal(f.contexts[0].gains[0].gain.value, .16);
  await f.output.dispose();
});

test('lifecycle rejection is handled and a gain failure mutes and pauses playback', async () => {
  const f = fixture({ ignored: true, lifecycleFailure: true }), a = f.output.create();
  a.volume = .16; await a.play();
  Object.defineProperty(f.contexts[0].gains[0].gain, 'value', { get: () => .16, set: () => { throw new Error('Gain failed'); } });
  assert.throws(() => { a.volume = .05; }, /Gain failed/);
  assert.equal(a.paused, true); assert.equal(f.media[0].muted, true);
  assert.equal(await f.output.suspend(), false);
  assert.equal(await f.output.dispose(), false);
  assert.equal(await f.output.dispose(), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMusic } from '../src/music.mjs';

class Clock {
  time = 0;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  set = (callback, delay) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + delay, callback }); return id; };
  clear = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
      await Promise.resolve(); await Promise.resolve();
    }
    this.time = end;
    await Promise.resolve(); await Promise.resolve();
  }
}
class Visibility {
  hidden = false;
  listeners = new Set();
  addEventListener(name, listener) { assert.equal(name, 'visibilitychange'); this.listeners.add(listener); }
  removeEventListener(name, listener) { this.listeners.delete(listener); }
  set(value) { this.hidden = value; for (const listener of this.listeners) listener(); }
}
class Media {
  paused = true;
  volume = 1;
  duration = 60;
  position = 0;
  startedAt = 0;
  requests = [];
  playCalls = 0;
  loads = 0;
  constructor(clock, plans) { this.clock = clock; this.plans = plans; }
  set src(value) { this.url = value; if (value) this.requests.push(value); this.position = 0; }
  get src() { return this.url || ''; }
  get currentTime() { return this.position + (this.paused ? 0 : (this.clock.time - this.startedAt) / 1000); }
  set currentTime(value) { this.position = value; this.startedAt = this.clock.time; }
  begin() { this.startedAt = this.clock.time; this.paused = false; this.onplaying?.(); }
  play() {
    this.playCalls++;
    const plan = this.plans.shift();
    if (plan === 'reject') return Promise.reject(Object.assign(new Error('private URL or device details'), { name: 'NotAllowedError' }));
    if (plan?.defer) return new Promise((resolve, reject) => {
      plan.resolve = () => { this.begin(); resolve(); };
      plan.reject = reject;
    });
    this.begin(); return Promise.resolve();
  }
  pause() { this.position = this.currentTime; this.paused = true; }
  removeAttribute(name) { assert.equal(name, 'src'); this.url = ''; }
  load() { this.loads++; this.position = 0; }
}
const tracks = [
  { id: 'morning', title: 'Morning bed', phase: 'morning', url: '/music/morning.mp3' },
  { id: 'day', title: 'Day bed', phase: 'day', url: '/music/day.mp3' },
  { id: 'dusk', title: 'Dusk bed', phase: 'dusk', url: '/music/dusk.mp3' },
  { id: 'night', title: 'Night bed', phase: 'night', url: '/music/night.mp3' },
  { id: 'app', title: 'AppTown bed', phase: ['morning', 'day'], town: 'AppTown', url: '/music/app.mp3' },
  { id: 'vault', title: 'VaultTown bed', phase: ['morning', 'day'], town: 'VaultTown', url: '/music/vault.mp3' },
];
function fixture(options = {}) {
  const clock = new Clock(), visibility = new Visibility(), media = [], plans = options.plans || [];
  const music = createMusic({ tracks, now: clock.now, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear, visibilitySource: visibility,
    audioFactory: () => { const audio = new Media(clock, plans); if (options.duration) audio.duration = options.duration; media.push(audio); return audio; }, ...options });
  return { music, clock, visibility, media, get requests() { return media.flatMap(audio => audio.requests); } };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .00001, `${actual} should equal ${expected}`);
const live = f => f.media.filter(audio => audio.src);

test('music starts off with no media work until opt-in, and a fresh controller stays off', async () => {
  const f = fixture();
  f.music.setScene({ phase: 'day', town: 'AppTown' });
  f.music.volume = .16;
  await f.clock.advance(60000);
  assert.equal(f.media.length, 0);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.music.state.enabled, false);
  assert.equal(f.music.state.audible, false);
  assert.equal(await f.music.enable(true), true);
  assert.deepEqual(f.requests, ['/music/app.mp3']);
  assert.equal(f.music.state.track.id, 'app');
  assert.equal(f.music.state.audible, false, 'fade-in starts at silence');
  await f.clock.advance(1800);
  near(f.media[0].volume, .16);
  assert.equal(f.music.state.audible, true);
  const fresh = fixture();
  assert.equal(fresh.music.state.enabled, false);
  assert.equal(fresh.media.length, 0);
  f.music.dispose(); fresh.music.dispose();
  assert.equal(f.music.state.playing, false);
  assert.equal(live(f).length, 0);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.visibility.listeners.size, 0);
});

test('town selection waits for stable boundaries and regional beds never replace dusk or night', async () => {
  const f = fixture();
  await f.music.enable(true); await f.clock.advance(1800);
  f.music.setScene({ town: 'AppTown' }); await f.clock.advance(2000);
  f.music.setScene({ town: 'HubTown' }); await f.clock.advance(5000);
  assert.deepEqual(f.requests, ['/music/day.mp3']);
  f.music.setScene({ town: 'AppTown' }); await f.clock.advance(3999);
  assert.equal(f.requests.length, 1);
  await f.clock.advance(1);
  assert.equal(f.music.state.track.id, 'app');
  await f.clock.advance(1800);
  f.music.setScene({ phase: 'night' }); await f.clock.advance(4000);
  assert.equal(f.music.state.track.id, 'night');
  await f.clock.advance(1800);
  f.music.setScene({ town: 'VaultTown' }); await f.clock.advance(5000);
  assert.equal(f.music.state.track.id, 'night');
  assert.equal(f.requests.length, 3, 'town changes at night reuse the same bed');
  f.music.setScene({ phase: 'morning' }); await f.clock.advance(4000);
  assert.equal(f.music.state.track.id, 'vault');
  assert.equal(f.media.length, 2);
  f.music.dispose();
});

test('music volume fades independently, gently indoors and more strongly during conversation', async () => {
  const f = fixture();
  await f.music.enable(true); await f.clock.advance(1800);
  f.music.setScene({ indoors: true });
  await f.clock.advance(400);
  assert.ok(f.media[0].volume < .16 && f.media[0].volume > .104);
  await f.clock.advance(400); near(f.media[0].volume, .16 * .65);
  f.music.setScene({ talking: true }); await f.clock.advance(350);
  near(f.media[0].volume, .16 * .65 * .25);
  f.music.setScene({ talking: false }); await f.clock.advance(800);
  near(f.media[0].volume, .16 * .65);
  f.music.volume = .4; await f.clock.advance(650); near(f.media[0].volume, .4 * .65);
  assert.equal(f.music.volume, .4);
  assert.equal(f.requests.length, 1, 'gain changes never change or reload the selected track');
  f.music.volume = 2; await f.clock.advance(650); near(f.media[0].volume, .65);
  f.music.volume = -1; await f.clock.advance(650); near(f.media[0].volume, 0);
  assert.equal(f.music.state.audible, false);
  f.music.dispose();
});

test('track changes crossfade and retire outgoing media without allocating a third element', async () => {
  const f = fixture();
  await f.music.enable(true); await f.clock.advance(1800);
  f.music.setScene({ town: 'AppTown' }); await f.clock.advance(4000);
  assert.equal(live(f).length, 2);
  const old = f.media[0], next = f.media[1];
  near(old.volume, .16); near(next.volume, 0);
  await f.clock.advance(900); near(old.volume, .08); near(next.volume, .08);
  await f.clock.advance(900);
  assert.equal(old.paused, true); assert.equal(old.src, ''); near(next.volume, .16);
  f.music.setScene({ town: 'VaultTown' }); await f.clock.advance(4900);
  assert.equal(f.media.length, 2); assert.equal(live(f).length, 2);
  f.music.dispose();
  assert.ok(f.media.every(audio => audio.paused && !audio.src && !audio.onended && !audio.onerror));
});

test('short tracks loop with overlap while reusing exactly two elements', async () => {
  const f = fixture({ duration: 5, fadeMs: 1000 });
  await f.music.enable(true); await f.clock.advance(4000);
  assert.equal(f.media.length, 2);
  assert.equal(live(f).length, 2);
  await f.clock.advance(500);
  near(f.media[0].volume, .08); near(f.media[1].volume, .08);
  await f.clock.advance(500);
  assert.equal(f.media[0].paused, true);
  assert.equal(f.music.state.track.id, 'day');
  await f.clock.advance(40000);
  assert.equal(f.media.length, 2);
  assert.ok(live(f).length <= 2);
  assert.equal(f.clock.timers.size, 1);
  assert.ok(f.requests.length > 5);
  f.music.dispose();
});

test('visibility stops all audio and resumes only the existing opt-in session', async () => {
  const f = fixture();
  await f.music.enable(true); await f.clock.advance(1800);
  f.music.setScene({ town: 'AppTown' }); await f.clock.advance(4500);
  f.visibility.set(true);
  assert.equal(f.music.state.status, 'paused');
  assert.equal(f.music.state.enabled, true);
  assert.equal(f.music.state.playing, false);
  assert.equal(live(f).length, 0);
  assert.equal(f.clock.timers.size, 0);
  const requests = f.requests.length;
  f.music.setScene({ phase: 'night' }); await f.clock.advance(60000);
  assert.equal(f.requests.length, requests);
  f.visibility.set(false); await f.clock.advance(1800);
  assert.equal(f.music.state.track.id, 'night');
  assert.equal(f.music.state.audible, true);
  assert.equal(await f.music.enable(false), false);
  assert.equal(f.music.state.status, 'stopping');
  await f.clock.advance(450);
  assert.equal(f.music.state.status, 'off');
  assert.equal(live(f).length, 0);
  const stoppedRequests = f.requests.length;
  f.visibility.set(true); f.visibility.set(false); await f.clock.advance(10000);
  assert.equal(f.requests.length, stoppedRequests);
  f.music.dispose();
});

test('late play completion cannot undo disable or disposal', async () => {
  for (const action of ['disable', 'dispose', 'hidden']) {
    const deferred = { defer: true }, f = fixture({ plans: [deferred] });
    const enabling = f.music.enable(true);
    assert.equal(f.music.state.status, 'starting');
    if (action === 'disable') await f.music.enable(false);
    else if (action === 'dispose') f.music.dispose();
    else f.visibility.set(true);
    assert.equal(await enabling, false);
    deferred.resolve(); await f.clock.advance(1000);
    assert.ok(f.media.every(audio => audio.paused && !audio.src && audio.volume === 0));
    assert.equal(f.music.state.audible, false);
    assert.equal(f.clock.timers.size, 0);
    f.music.dispose();
  }
});

test('changing scenes cancels a pending start and stale completion cannot replace the new track', async () => {
  const deferred = { defer: true }, f = fixture({ plans: [deferred] });
  const initial = f.music.enable(true);
  f.music.setScene({ phase: 'night' });
  assert.equal(await initial, false);
  await f.clock.advance(4000);
  assert.equal(f.music.state.track.id, 'night');
  deferred.resolve(); await f.clock.advance(1800);
  assert.equal(f.music.state.track.id, 'night');
  assert.equal(f.music.state.audible, true);
  assert.equal(live(f).length, 1);
  assert.ok(f.media.length <= 2);
  f.music.dispose();
});

test('rapid toggles preserve a live fade and repeated disable does not extend stopping', async () => {
  const f = fixture();
  await f.music.enable(true); await f.clock.advance(1800);
  await f.music.enable(false); await f.clock.advance(200);
  assert.ok(f.media[0].volume > 0 && f.media[0].volume < .16);
  assert.equal(await f.music.enable(true), true);
  await f.clock.advance(1800);
  assert.equal(f.requests.length, 1, 're-enabling the same bed preserves its source');
  near(f.media[0].volume, .16);
  await f.music.enable(false); await f.clock.advance(250);
  await f.music.enable(false); await f.clock.advance(200);
  assert.equal(f.music.state.status, 'off');
  assert.equal(live(f).length, 0);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(await f.music.enable(true), true);
  await f.clock.advance(1800);
  assert.equal(f.music.state.audible, true);
  assert.equal(f.media.length, 1);
  f.music.dispose();
});

test('a cancelled start stays paused while a different scene is still waiting for debounce', async () => {
  const deferred = { defer: true }, f = fixture({ plans: [deferred] });
  const enabling = f.music.enable(true);
  f.music.setScene({ phase: 'night' });
  assert.equal(await enabling, false);
  deferred.resolve(); await f.clock.advance(1000);
  assert.equal(f.media[0].paused, true);
  assert.equal(f.media[0].src, '');
  assert.equal(f.music.state.audible, false);
  await f.clock.advance(4800);
  assert.equal(f.music.state.track.id, 'night');
  assert.equal(f.music.state.audible, true);
  f.music.dispose();
});

test('play, media, construction, and loading errors stop cleanly without retries or private error details', async () => {
  const denied = fixture({ plans: ['reject'] });
  assert.equal(await denied.music.enable(true), false);
  assert.equal(denied.music.state.status, 'error');
  assert.doesNotMatch(denied.music.state.error, /private URL|device details/);
  await denied.clock.advance(60000);
  assert.equal(denied.requests.length, 1);
  assert.equal(live(denied).length, 0);
  denied.music.dispose();
  const broken = fixture({ audioFactory: () => { throw new Error('Unavailable'); } });
  assert.equal(await broken.music.enable(true), false);
  assert.equal(broken.clock.timers.size, 0);
  broken.music.dispose();
  const failed = fixture();
  await failed.music.enable(true); await failed.clock.advance(1800);
  failed.media[0].onerror();
  assert.equal(failed.music.state.enabled, false);
  assert.equal(failed.music.state.audible, false);
  assert.equal(live(failed).length, 0);
  failed.music.dispose();
  const delayed = fixture({ plans: [{ defer: true }] });
  const enable = delayed.music.enable(true);
  await delayed.clock.advance(15000);
  assert.equal(await enable, false);
  assert.match(delayed.music.state.error, /too long/);
  assert.equal(delayed.clock.timers.size, 0);
  assert.equal(live(delayed).length, 0);
  delayed.music.dispose();
});

test('catalog fallback uses only a generic any-phase bed and empty catalogs stay silent', async () => {
  const f = fixture({ tracks: [{ id: 'fallback', title: 'Common bed', phase: 'any', url: '/music/common.mp3' },
    { id: 'regional', phase: ['morning', 'day'], town: 'AppTown', url: '/music/regional.mp3' }] });
  f.music.setScene({ phase: 'night', town: 'AppTown' });
  await f.music.enable(true);
  assert.equal(f.music.state.track.id, 'fallback');
  f.music.dispose();
  const empty = fixture({ tracks: [] });
  assert.equal(await empty.music.enable(true), false);
  assert.equal(empty.media.length, 0);
  assert.equal(empty.music.state.playing, false);
  empty.music.dispose();
});

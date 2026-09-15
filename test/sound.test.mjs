import test from 'node:test';
import assert from 'node:assert/strict';
import { createSound } from '../src/sound.mjs';

class Parameter {
  value = 0;
  events = [];
  setValueAtTime(value, time) { this.record('set', value, time); }
  linearRampToValueAtTime(value, time) { this.record('linear', value, time); }
  exponentialRampToValueAtTime(value, time) { assert.ok(value > 0); this.record('exponential', value, time); }
  record(kind, value, time) { assert.ok(Number.isFinite(value) && Number.isFinite(time)); this.events.push([kind, value, time]); }
}
class Node {
  connections = [];
  disconnects = 0;
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnects++; this.connections = []; }
}
class Oscillator extends Node {
  frequency = new Parameter();
  stops = [];
  start(time) { this.startedAt = time; }
  stop(time) { this.stops.push(time); }
  end() { this.onended?.(); }
}
class FakeContext {
  currentTime = 10;
  state = 'suspended';
  nodes = [];
  destination = {};
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  add(node) { this.nodes.push(node); return node; }
  createOscillator() { return this.add(new Oscillator()); }
  createGain() { return this.add(Object.assign(new Node(), { gain: new Parameter() })); }
  createStereoPanner() { return this.add(Object.assign(new Node(), { pan: new Parameter() })); }
  createBiquadFilter() { return this.add(Object.assign(new Node(), { frequency: new Parameter(), Q: new Parameter() })); }
}
function fixture() {
  const context = new FakeContext();
  let constructions = 0;
  const sound = createSound({ contextFactory: () => { constructions++; return context; } });
  return { context, sound, get constructions() { return constructions; } };
}

test('murmurs require opt-in and disable stops and disconnects every live node', async () => {
  const f = fixture();
  assert.equal(f.sound.murmur({ seed: 'Bolt' }), false);
  assert.equal(f.sound.play('door'), false);
  assert.equal(f.constructions, 0, 'sound off must not create or resume a context');
  assert.equal(await f.sound.enable(true), true);
  assert.equal(f.sound.murmur({ seed: 'Bolt' }), true);
  assert.equal(f.context.nodes.length, 7);
  const source = f.context.nodes.find((n) => n instanceof Oscillator);
  assert.ok(source.stops[0] > f.context.currentTime);
  assert.equal(await f.sound.enable(false), false);
  assert.equal(source.stops.at(-1), f.context.currentTime);
  assert.ok(f.context.nodes.every((n) => n.disconnects === 1 && n.connections.length === 0));
  assert.equal(source.onended, null);
  assert.equal(await f.sound.enable(true), true);
  assert.equal(f.constructions, 1);
  assert.equal(f.context.nodes.length, 7, 're-enabling cannot revive old syllables');
  assert.equal(f.sound.murmur({ seed: 'Bolt' }), true, 'a new greeting is allowed after re-enabling');
});

test('murmur schedules a deterministic multi-syllable formant phrase with bounded duration', async () => {
  const a = fixture(), b = fixture(), c = fixture();
  await Promise.all([a.sound.enable(true), b.sound.enable(true), c.sound.enable(true)]);
  a.sound.murmur({ seed: 'resident-42' });
  b.sound.murmur({ seed: 'resident-42' });
  c.sound.murmur({ seed: 'resident-43' });
  const sourceA = a.context.nodes.find((n) => n instanceof Oscillator);
  const sourceB = b.context.nodes.find((n) => n instanceof Oscillator);
  const sourceC = c.context.nodes.find((n) => n instanceof Oscillator);
  assert.equal(sourceA.type, 'sawtooth');
  assert.deepEqual(sourceA.frequency.events, sourceB.frequency.events);
  assert.notDeepEqual(sourceA.frequency.events, sourceC.frequency.events);
  const syllables = sourceA.frequency.events.filter(([kind]) => kind === 'set');
  assert.ok(syllables.length >= 5 && syllables.length <= 7);
  assert.ok(sourceA.stops[0] - sourceA.startedAt > .6 && sourceA.stops[0] - sourceA.startedAt < 1.5);
  assert.equal(a.context.nodes.filter((n) => n.type === 'bandpass').length, 2);
  assert.equal(a.context.nodes.filter((n) => n.type === 'lowpass').length, 1);
  assert.ok(a.context.nodes.filter((n) => n.type === 'bandpass').every((n) => n.frequency.events.length === syllables.length * 2));
  sourceA.end();
  assert.ok(a.context.nodes.every((n) => n.disconnects === 1));
  sourceA.end();
  assert.ok(a.context.nodes.every((n) => n.disconnects === 1), 'ended cleanup is idempotent');
});

test('murmur attenuation, panning and cooldown prevent noisy repeats', async () => {
  const { context, sound } = fixture();
  await sound.enable(true);
  assert.equal(sound.murmur({ distance: 220 }), false);
  assert.equal(sound.murmur({ distance: Infinity }), false);
  assert.equal(context.nodes.length, 0);
  assert.equal(sound.murmur({ seed: 'A', distance: 110, pan: 4 }), true);
  const panner = context.nodes.find((n) => n.pan);
  assert.equal(panner.pan.value, 1);
  const envelope = context.nodes.find((n) => n.gain?.events.length > 0);
  const peaks = envelope.gain.events.filter(([kind]) => kind === 'linear').map(([, value]) => value);
  assert.ok(peaks.every((value) => value > 0 && value <= .045 * .5 * .75));
  assert.equal(sound.murmur({ seed: 'B' }), false, 'different residents share the greeting cooldown');
  context.nodes.find((n) => n instanceof Oscillator).end();
  context.currentTime += 1.5;
  assert.equal(sound.murmur({ seed: 'B', pan: -4 }), true);
  assert.equal(context.nodes.filter((n) => n.pan).at(-1).pan.value, -1);
});

test('ambience and alert switches stop only their own channels', async () => {
  const { context, sound } = fixture();
  await sound.enable(true);
  assert.equal(sound.play('ready'), true);
  const alertNodes = [...context.nodes];
  assert.equal(sound.murmur({ seed: 'A' }), true);
  const murmurNodes = context.nodes.slice(alertNodes.length);
  sound.ambience = false;
  assert.ok(murmurNodes.every((n) => n.disconnects === 1));
  assert.ok(alertNodes.every((n) => n.disconnects === 0));
  assert.equal(sound.murmur(), false);
  assert.equal(sound.play('door'), false);
  sound.alerts = false;
  assert.ok(alertNodes.every((n) => n.disconnects === 1));
  sound.ambience = true;
  context.currentTime += 2;
  assert.equal(sound.play('ready'), false);
  assert.equal(sound.murmur(), true);
  await sound.enable(false);
  assert.ok(context.nodes.every((n) => n.disconnects === 1));
});

test('audio initialization and partial voice failures return false without leaking nodes', async () => {
  const failedContext = new FakeContext();
  failedContext.resume = async () => { throw new Error('Audio unavailable'); };
  const disabled = createSound({ contextFactory: () => failedContext });
  assert.equal(await disabled.enable(true), false);
  assert.equal(disabled.murmur(), false);
  assert.equal(failedContext.nodes.length, 0);
  const constructionFailure = createSound({ contextFactory: () => { throw new Error('No device'); } });
  assert.equal(await constructionFailure.enable(true), false);
  const { context, sound } = fixture();
  await sound.enable(true);
  context.createBiquadFilter = () => { throw new Error('Node failure'); };
  assert.equal(sound.murmur(), false);
  assert.ok(context.nodes.every((n) => n.disconnects === 1));
  assert.ok(context.nodes.every((n) => n.onended === null));
});

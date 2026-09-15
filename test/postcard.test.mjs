import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterior } from '../src/interiors.mjs';
import { buildPostcardModel, postcardFilename, wrapPostcardText, createPostcard, POSTCARD_WIDTH, POSTCARD_HEIGHT } from '../src/postcard.mjs';

const now = Date.parse('2026-09-15T12:00:00Z');
const agent = { id: 'postcard-fixture', taskId: 'task-42', name: 'Bolt', town: 'HubTown', status: 'working' };

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

function canvasFixture({ encode = 'ok', context = true } = {}) {
  const surfaces = [], texts = [], rects = [], draws = [], requests = [];
  let depth = 0;
  const createCanvas = () => {
    const surface = {
      width: 0, height: 0,
      getContext(kind, options) {
        requests.push({ kind, options });
        if (!context) return null;
        return {
          save() { depth++; }, restore() { depth--; },
          translate(x, y) { assert.ok([x, y].every(Number.isFinite)); },
          scale(x, y) { assert.ok([x, y].every(Number.isFinite)); },
          beginPath() {}, rect() {}, clip() {},
          fillRect(x, y, w, h) { assert.ok([x, y, w, h].every(Number.isFinite)); assert.ok(w >= 0 && h >= 0); rects.push({ x, y, w, h, color: this.fillStyle }); },
          fillText(value, x, y) { assert.equal(typeof value, 'string'); assert.ok([x, y].every(Number.isFinite)); texts.push(value); },
          measureText(value) { const size = Number.parseFloat(this.font) || 7; return { width: Array.from(value).length * size * .6 }; },
          drawImage(source, ...coordinates) { assert.ok(coordinates.every(Number.isFinite)); draws.push({ sourceWidth: source.width, sourceHeight: source.height, coordinates, smoothing: this.imageSmoothingEnabled }); },
        };
      },
      toBlob(callback, type) {
        assert.equal(type, 'image/png');
        surface.encoded = { width: surface.width, height: surface.height };
        if (encode === 'throw') throw new DOMException('Synthetic tainted canvas', 'SecurityError');
        if (encode === 'never') return;
        const blob = encode === 'null' ? null : new Blob(encode === 'empty' ? [] : ['fixture-png'], { type: encode === 'wrong-type' ? 'image/jpeg' : 'image/png' });
        queueMicrotask(() => callback(blob));
      },
    };
    if (encode === 'missing') delete surface.toBlob;
    surfaces.push(surface); return surface;
  };
  return { createCanvas, surfaces, texts, rects, draws, requests, get depth() { return depth; } };
}

test('postcards default to scene identity, without inferring work or completion', () => {
  const unknown = buildPostcardModel({ agent: { ...agent, status: 'unknown' }, now });
  const done = buildPostcardModel({ agent: { ...agent, status: 'done', task: 'Private task', originalAsk: 'Private request', result: 'Everything completed', events: [{ text: 'Completed milestone' }], artifacts: [{ url: 'https://example.test/private' }] }, now });
  assert.deepEqual(done, unknown);
  assert.equal(done.milestone, null);
  assert.equal(done.brand, 'CottageCode');
  assert.equal(done.resident, 'Bolt');
  assert.equal(done.town, 'HubTown');
  assert.equal(done.dateISO, '2026-09-15');
  assert.doesNotMatch(JSON.stringify(done), /Private|Everything completed|Completed milestone|example\.test/);
  assert.equal(buildPostcardModel({ agent, now, milestone: { status: 'completed' } }).milestone, null);
});

test('one explicit recorded milestone keeps its source time; an unknown time stays unknown', () => {
  const completed = buildPostcardModel({ agent, now, milestone: { text: 'PR merged', timestamp: now - 86400000, url: 'https://github.com/example/project/pull/42?token=private#checks' } });
  assert.equal(completed.milestone.text, 'PR merged');
  assert.equal(completed.milestone.timestamp, now - 86400000);
  assert.equal(completed.milestone.dateLabel, '14 SEP 2026');
  assert.equal(completed.milestone.url, 'https://github.com/example/project/pull/42');
  assert.equal(completed.milestone.linkLabel, 'github.com/example/project/pull/42');
  const unknown = buildPostcardModel({ agent, now: null, milestone: { text: 'Recorded observation' } });
  assert.equal(unknown.capturedAt, null);
  assert.equal(unknown.dateISO, 'undated');
  assert.equal(unknown.milestone.timestamp, null);
  assert.equal(unknown.milestone.dateLabel, 'Date not supplied');
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///private/file', '//example.test/path', 'https://name:secret@example.test/path', 'not a url'])
    assert.equal(buildPostcardModel({ agent, now, milestone: { text: 'A record', url } }).milestone.url, '');
});

test('the captured lighting preserves the selected hour within a phase', () => {
  const model = buildPostcardModel({ agent, now, timeState: { hour: 20.75, phase: 'dusk' } });
  assert.equal(model.timeState.hour, 20.75);
  assert.equal(model.timeState.phase, 'dusk');
  assert.equal(buildPostcardModel({ agent, now, timeState: 'night' }).timeState.phase, 'night');
});

test('names and milestone text remain literal Unicode text, with controls removed and bounded clusters', () => {
  const family = '👩🏽‍💻';
  const model = buildPostcardModel({ agent: { ...agent, name: '<img onerror="run()"> & \u202eJack\n\t' + family.repeat(100) }, now,
    milestone: { text: 'Literal </script> & "quotes"\u0000\n' + family.repeat(5000) } });
  assert.match(model.resident, /^<img onerror="run\(\)"> & Jack /);
  assert.match(model.milestone.text, /^Literal <\/script> & "quotes" /);
  assert.doesNotMatch(model.resident + model.milestone.text, /[\u0000-\u001f\u202a-\u202e\ufffd]/u);
  assert.ok(model.resident.endsWith('…'));
  assert.ok(model.milestone.text.endsWith(family + '…'));
  assert.ok(Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(model.resident)).length <= 48);
  assert.ok(Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(model.milestone.text)).length <= 240);
});

test('portable filenames never contain source paths, reserved characters or unbounded names', () => {
  assert.equal(postcardFilename({ agent, now }), 'cottagecode-hubtown-bolt-2026-09-15.png');
  for (const name of ['../../private/CON:*?<>|\\\"', 'üñîçødé resident', '🦆🏡', 'x'.repeat(20000)]) {
    const filename = postcardFilename({ agent: { ...agent, name, town: '../AppTown' }, now });
    assert.match(filename, /^cottagecode-[a-z0-9-]+-2026-09-15\.png$/);
    assert.ok(filename.length < 100);
    assert.doesNotMatch(filename, /\.\.|[/\\:*?<>|\"]/);
  }
  assert.equal(postcardFilename({ agent: { name: '', town: '' }, now: NaN }), 'cottagecode-town-resident-undated.png');
});

test('text wraps within its column and ellipsizes long words without splitting emoji', () => {
  const measure = value => Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)).length;
  assert.deepEqual(wrapPostcardText('one two three', measure, 7, 2), ['one two', 'three']);
  assert.deepEqual(wrapPostcardText('abcdefghijklm', measure, 5, 2), ['abcde', 'fghi…']);
  assert.deepEqual(wrapPostcardText('github.com/example/project/pull/42', measure, 25, 2), ['github.com/example/', 'project/pull/42']);
  const result = wrapPostcardText('👩🏽‍💻'.repeat(20), measure, 5, 2);
  assert.equal(result.length, 2);
  assert.ok(result.every(line => measure(line) <= 5));
  assert.equal(result[1], '👩🏽‍💻'.repeat(4) + '…');
  assert.deepEqual(wrapPostcardText('hello', measure, 0, 2), []);
  assert.deepEqual(wrapPostcardText('hello', () => Infinity, 5, 2), []);
});

test('PNG render preserves seeded inputs, renders only scene data, and uses crisp opaque bounded surfaces', async () => {
  const privateAgent = frozen({ ...agent, originalAsk: 'NEVER ORIGINAL REQUEST', result: 'NEVER RESULT', lastLine: 'NEVER JOURNAL', pr: { state: 'merged', title: 'NEVER PR TITLE' } });
  const room = frozen(createInterior(privateAgent)), before = JSON.stringify({ privateAgent, room });
  const fixture = canvasFixture();
  const output = await createPostcard({ agent: privateAgent, room, now, timeState: { phase: 'day' }, scale: 9999 }, fixture);
  assert.equal(output.blob.type, 'image/png');
  assert.ok(output.blob.size > 0);
  assert.equal(output.width, POSTCARD_WIDTH * 4);
  assert.equal(output.height, POSTCARD_HEIGHT * 4);
  assert.equal(fixture.surfaces.length, 3);
  assert.equal(fixture.depth, 0);
  assert.ok(fixture.rects.length > 400);
  assert.equal(fixture.requests.every(request => request.kind === '2d' && request.options.alpha === false), true);
  assert.equal(fixture.draws.every(draw => draw.smoothing === false), true);
  assert.deepEqual(fixture.surfaces.at(-1).encoded, { width: output.width, height: output.height });
  assert.equal(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0), true);
  assert.equal(JSON.stringify({ privateAgent, room }), before);
  assert.doesNotMatch(fixture.texts.join(' '), /NEVER|MERGED|Recorded moment/i);
  assert.ok(fixture.texts.includes('CottageCode'));
  assert.ok(fixture.texts.includes('HubTown'));
  assert.ok(fixture.texts.includes('Bolt'));
  const again = canvasFixture();
  await createPostcard({ agent: privateAgent, room, now, timeState: { phase: 'day' }, scale: 4 }, again);
  assert.deepEqual(fixture.rects, again.rects);
});

test('only an explicit milestone is printed and absent room uses the same seeded generation', async () => {
  const fixture = canvasFixture();
  const result = await createPostcard({ agent, now, milestone: { text: 'Review finished', timestamp: now, url: 'https://example.test/pr/42' } }, fixture);
  assert.equal(result.width, 1200);
  assert.equal(result.height, 840);
  assert.ok(fixture.texts.includes('RECORDED MOMENT'));
  assert.ok(fixture.texts.includes('Review finished'));
  assert.equal(result.model.milestone.timestamp, now);
});

test('missing, tainted, empty and failed canvas encoding reject cleanly and release memory', async () => {
  for (const encode of ['missing', 'throw', 'null', 'empty', 'wrong-type', 'never']) {
    const fixture = canvasFixture({ encode });
    await assert.rejects(createPostcard({ agent, now }, { ...fixture, toBlobTimeoutMs: 2 }), /postcard/i, encode);
    assert.equal(fixture.surfaces.every(surface => surface.width === 0 && surface.height === 0), true, encode);
  }
  const fixture = canvasFixture({ context: false });
  await assert.rejects(createPostcard({ agent, now }, fixture), /canvas/i);
  assert.equal(fixture.surfaces[0].width, 0);
  await assert.rejects(createPostcard({ agent, now }, { createCanvas: () => null }), /canvas/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {isPracticeDemo} from '../src/observatory.mjs';

const pending = { id: 'practice-question', prompt: 'Which scope should I use?' };

test('practice replies require the built-in demo, not a feed source label', () => {
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, null), true);
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, 'https://feed.example/agents'), false);
  assert.equal(isPracticeDemo({ source: 'hub', inputRequest: pending }, null), false);
  assert.equal(isPracticeDemo({ source: 'demo' }, null), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {isPracticeDemo,button,handoffAction,appendInlineHandoffs} from '../src/observatory.mjs';

const pending = { id: 'practice-question', prompt: 'Which scope should I use?' };

test('practice replies require the built-in demo state, not a feed source label', () => {
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, true), true);
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, false), false);
  assert.equal(isPracticeDemo({ source: 'hub', inputRequest: pending }, true), false);
  assert.equal(isPracticeDemo({ source: 'demo' }, true), false);
});

test('history jump actions escape untrusted cottage identifiers in button markup',()=>{
  const html=button('jump:agent" onfocus="alert(1)','Open cottage');
  assert.match(html,/data-action="jump:agent&quot; onfocus=&quot;alert\(1\)"/);
  assert.doesNotMatch(html,/data-action="jump:agent" onfocus=/);
});

test('inline activity routes only complete handoffs to the append path',()=>{
  const appended=[];
  appendInlineHandoffs([
    {id:'progress',kind:'progress',text:'Building'},
    {id:'handoff',kind:'handoff',from:'HubTown',to:'AppTown',text:'Interface contract ready'},
    {id:'partial',kind:'handoff',from:'HubTown',text:'Missing destination'},
  ],event=>appended.push(event));
  assert.deepEqual(appended,[{id:'handoff',kind:'handoff',from:'HubTown',to:'AppTown',text:'Interface contract ready'}]);
});

test('handoff action only exposes an HTTPS handoff target',()=>{
  assert.match(handoffAction('https://github.com/owner/repo/pull/9'),/data-action="handoff"/);
  assert.equal(handoffAction('http://localhost:8787/handoff'),'');
  assert.equal(handoffAction('javascript:alert(1)'), '');
});

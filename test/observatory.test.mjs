import test from 'node:test';
import assert from 'node:assert/strict';
import {button,appendInlineHandoffs} from '../src/observatory.mjs';

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

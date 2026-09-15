import test from 'node:test';
import assert from 'node:assert/strict';
import {isPracticeDemo,button,appendInlineHandoffs,isApprenticeArrivalActive,apprenticeArrivalPosition,apprenticeResidentPosition} from '../src/observatory.mjs';

const pending = { id: 'practice-question', prompt: 'Which scope should I use?' };

test('practice replies require the built-in demo, not a feed source label', () => {
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, null), true);
  assert.equal(isPracticeDemo({ source: 'demo', inputRequest: pending }, 'https://feed.example/agents'), false);
  assert.equal(isPracticeDemo({ source: 'hub', inputRequest: pending }, null), false);
  assert.equal(isPracticeDemo({ source: 'demo' }, null), false);
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

test('an apprentice arrival stays active only during its visible walk',()=>{
  const arrivals=[{id:'pip',start:100},{id:'moss',start:90}];
  assert.equal(isApprenticeArrivalActive(arrivals,'pip',100),true);
  assert.equal(isApprenticeArrivalActive(arrivals,'pip',107.99),true);
  assert.equal(isApprenticeArrivalActive(arrivals,'pip',108),false);
  assert.equal(isApprenticeArrivalActive(arrivals,'moss',100),false);
  assert.equal(isApprenticeArrivalActive(arrivals,'unknown',101),false);
});


test('an arriving apprentice uses its visible walking position and never a stale family hitbox',()=>{
  const arrivals=[{id:'pip',parent:'bolt',start:100}];
  const plots=[{x:100,y:200,agent:{id:'bolt'},kids:[{x:160,y:220,agent:{id:'pip'}}]}];
  const familyPosition={id:'pip',x:168,y:240};
  assert.deepEqual(apprenticeArrivalPosition(arrivals,'pip',plots,103),{id:'pip',x:147.5,y:256});
  assert.deepEqual(apprenticeResidentPosition(arrivals,'pip',plots,103,familyPosition),{id:'pip',x:147.5,y:256},'talk and click follow the visible walk');
  assert.deepEqual(apprenticeResidentPosition(arrivals,'pip',plots,108,familyPosition),familyPosition,'family interaction resumes after the arrival');
  assert.equal(apprenticeResidentPosition(arrivals,'pip',[],103,familyPosition),null,'an active arrival with no visible position cannot expose a stale hitbox');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {cottageDoors, crossedDoor, residentTargets} from '../src/interaction.mjs';

const plots = [{x:100,y:200,agent:{id:'host'},kids:[{x:160,y:220,agent:{id:'kid'}}]}];
test('walking into the front threshold enters cottages and apprentice sheds', () => {
  const doors = cottageDoors(plots);
  assert.equal(crossedDoor({x:127,y:276},{x:127,y:268},doors)?.id,'host');
  assert.equal(crossedDoor({x:168,y:242},{x:168,y:239},doors)?.id,'kid');
  assert.equal(crossedDoor({x:127,y:276},{x:127,y:220},doors)?.id,'host','a long frame cannot skip a door');
  assert.equal(crossedDoor({x:127,y:276},{x:127,y:268},cottageDoors(plots,a=>a.id==='kid')),null);
});
test('doors ignore sideways movement, walking away, and crossings beyond the door jamb', () => {
  const doors = cottageDoors(plots);
  for (const [from,to] of [
    [{x:110,y:276},{x:140,y:276}],
    [{x:127,y:268},{x:127,y:276}],
    [{x:145,y:276},{x:145,y:268}],
    [{x:127,y:260},{x:127,y:250}],
  ]) assert.equal(crossedDoor(from,to,doors),null);
  assert.equal(crossedDoor({x:100,y:280},{x:160,y:260},doors)?.id,'host','diagonal entry uses the crossing point');
});
test('the interior exit needs outward movement, preventing immediate reentry loops', () => {
  const exit = [{id:'exit',x:120,y:157,width:26}];
  assert.equal(crossedDoor({x:120,y:154},{x:120,y:159},exit,'out')?.id,'exit');
  assert.equal(crossedDoor({x:120,y:154},{x:120,y:150},exit,'out'),null,'walking inward from spawn stays indoors');
  assert.equal(crossedDoor({x:100,y:154},{x:100,y:159},exit,'out'),null);
  assert.equal(crossedDoor({x:127,y:276},{x:127,y:284},cottageDoors(plots)),null,'walking outward after exit stays outside');
});
test('only actors with a currently rendered cottage remain conversation targets', () => {
  const actors=new Map([
    ['shown',{x:10,y:20,indoors:false}],
    ['settled',{x:30,y:40,indoors:false}],
    ['hidden',{x:50,y:60,indoors:false}],
    ['unrendered',{x:70,y:80,indoors:false}],
    ['inside',{x:90,y:100,indoors:true}],
  ]);
  const plots=[
    {agent:{id:'shown'}},
    {agent:{id:'hidden'},hidden:true},
    {agent:{id:'unrendered'},rendered:false},
    {agent:{id:'inside'}},
  ];
  assert.deepEqual(residentTargets(actors,plots),[{id:'shown',x:15,y:34}]);
});

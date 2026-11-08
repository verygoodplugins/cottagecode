import test from 'node:test';
import assert from 'node:assert/strict';
import {createVillageExtras} from '../src/village-extras.mjs';

// Exercise the DOM controller as well as the separate music lifecycle model.
function controls(t) {
  const nodes=new Map(),listeners=new Map();
  const node=id=>{
    if(!nodes.has(id))nodes.set(id,{
      id,textContent:'',value:'',hidden:false,open:false,attributes:new Map(),
      setAttribute(name,value){this.attributes.set(name,value);},
      removeAttribute(name){this.attributes.delete(name);},
      addEventListener(){},
    });
    return nodes.get(id);
  };
  const originals=['document','window'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  t.after(()=>{for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  globalThis.document={getElementById:node,hidden:false,
    addEventListener:(name,listener)=>listeners.set(name,listener)};
  globalThis.window={addEventListener:(name,listener)=>listeners.set(name,listener)};
  const controller=createVillageExtras({getPostcard:()=>null,clearKeys:()=>{}});
  return {node,controller,close(){listeners.get('pagehide')({persisted:false});}};
}

test('music range input updates its percentage and controller without enabling playback',t=>{
  const f=controls(t),range=f.node('music-volume');
  for(const value of ['0','31','50','16']){
    range.value=value;range.oninput({target:range});
    assert.equal(f.controller.state.music.volume,Number(value)/100);
    assert.equal(f.node('music-volume-value').textContent,value+'%');
    assert.equal(f.controller.state.music.enabled,false);
    assert.equal(f.controller.state.music.playing,false);
  }
  f.controller.update({player:{x:0,y:0},world:{districts:[]},indoors:false,talking:false},10);
  assert.equal(f.controller.state.music.volume,.16,'a scene refresh preserves the chosen volume');
  f.close();
});

test('time select previews each phase immediately and preserves it across scene refreshes',t=>{
  const f=controls(t),select=f.node('village-time');
  for(const phase of ['morning','day','dusk','night']){
    select.value=phase;select.onchange({target:select});
    assert.equal(f.controller.state.timeMode,phase);
    assert.equal(f.controller.state.phase,phase);
    assert.match(f.node('village-clock').textContent,/preview/);
    f.controller.update({player:{x:0,y:0},world:{districts:[]},indoors:false,talking:false},10);
    assert.equal(f.controller.state.phase,phase);
  }
  select.value='auto';select.onchange({target:select});
  assert.equal(f.controller.state.timeMode,'auto');
  assert.match(f.node('village-clock').textContent,/local time/);
  assert.equal(f.controller.state.music.enabled,false);
  f.close();
});

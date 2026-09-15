import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationCapability} from '../src/conversation.mjs';
const now=Date.now(),endpoint='http://127.0.0.1:8787/agents';
const agent={taskId:'task-1',conversation:{available:true,mode:'redirect',checkedAt:now,messageUrl:'/agents/one/messages'}};
test('messaging requires explicit, fresh task capability on the connected feed origin',()=>{
  assert.equal(conversationCapability(agent,endpoint,{now}).url,'http://127.0.0.1:8787/agents/one/messages');
  for(const overrides of [{available:false},{mode:'resume'},{checkedAt:now-121000},{checkedAt:now+60000},{checkedAt:null},{messageUrl:undefined},{messageUrl:''},{messageUrl:'https://other.example/messages'},{messageUrl:'http://user:password@127.0.0.1:8787/messages'},{messageUrl:'javascript:alert(1)'}])
    assert.equal(conversationCapability({...agent,conversation:{...agent.conversation,...overrides}},endpoint,{now}).available,false);
  assert.equal(conversationCapability(agent,endpoint,{stale:true,now}).available,false);
  assert.equal(conversationCapability({...agent,taskId:null},endpoint,{now}).available,false);
  assert.equal(conversationCapability({taskId:'observed'},endpoint,{now}).available,false);
});

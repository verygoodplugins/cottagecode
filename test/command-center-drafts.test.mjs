import test from 'node:test';
import assert from 'node:assert/strict';
import {draftVersion,reconcileDraft} from '../experiments/command-center/drafts.mjs';
import {createReplyClient} from '../experiments/command-center/replies.mjs';

const now=Date.parse('2026-11-08T12:00:00Z'),endpoint='http://127.0.0.1:8790/agents';
const question=(extra={})=>({id:'cottage-1',taskId:'task-1',status:'blocked',inputRequest:{id:'q1',kind:'question',prompt:'Continue?'},conversation:{available:true,mode:'respond',checkedAt:now,messageUrl:'/agents/cottage-1/messages'},...extra});
const view=(raw,at)=>({id:raw.id,raw,capability:{available:true,mode:raw.conversation.mode,url:new URL(raw.conversation.messageUrl,endpoint).href}});
const draftFor=task=>({text:'Yes, continue.',version:draftVersion(task),raw:structuredClone(task.raw),changed:false});
const memory=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('same evidence refreshes expired checkedAt without discarding a draft and send succeeds',async()=>{
  const shown=view(question(),now),draft=draftFor(shown),freshRaw=question({conversation:{...question().conversation,checkedAt:now+121000}}),fresh=view(freshRaw,now+121000);
  reconcileDraft(draft,fresh);assert.equal(draft.changed,false);assert.equal(draft.raw.conversation.checkedAt,now+121000);assert.equal(draft.text,'Yes, continue.');
  let posts=0;const client=createReplyClient({endpoint,storage:memory(),now:()=>now+121000,fetchImpl:async(url,options)=>{
    if(options?.method==='POST'){posts++;return json({ok:true,delivery:'accepted',requestId:JSON.parse(options.body).requestId});}
    return json({agents:[freshRaw]});
  }});
  assert.equal((await client.send(draft.raw,draft.text)).phase,'sent');assert.equal(posts,1);
});

test('semantic task and route changes require review and preserve prior raw evidence and text',()=>{
  const base=view(question(),now),changes=[
    question({status:'working'}),question({inputRequest:{id:'q2',kind:'question',prompt:'Different?'}}),
    question({taskId:'task-2'}),question({terminal:true}),question({conversation:{...question().conversation,mode:'redirect',messageUrl:'/agents/cottage-1/messages'}}),
    question({conversation:{...question().conversation,messageUrl:'/agents/cottage-1/other'}}),
  ];
  for(const changedRaw of changes){const draft=draftFor(base),original=draft.raw;reconcileDraft(draft,view(changedRaw,now+121000));assert.equal(draft.changed,true);assert.equal(draft.raw,original);assert.equal(draft.text,'Yes, continue.');}
});

test('explicit review adoption accepts changed evidence and a later fresh snapshot refreshes it',()=>{
  const old=view(question(),now),draft=draftFor(old),changed=view(question({status:'working'}),now+121000);
  reconcileDraft(draft,changed);assert.equal(draft.changed,true);
  draft.raw=structuredClone(changed.raw);draft.version=draftVersion(changed);draft.changed=false;
  const refreshed=view(question({status:'working',conversation:{...question().conversation,checkedAt:now+242000}}),now+242000);
  reconcileDraft(draft,refreshed);assert.equal(draft.changed,false);assert.equal(draft.raw.conversation.checkedAt,now+242000);assert.equal(draft.text,'Yes, continue.');
});

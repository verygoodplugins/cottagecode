import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceOverviewHtml,replyPresentation,reconcileReplyReceipt,cottageSelection} from '../src/observatory.mjs';
import {createReplyClient} from '../src/command-replies.mjs';
import {inputRequestVersion} from '../src/input-request.mjs';

const endpoint='http://127.0.0.1:8790/agents';
const now=Date.parse('2026-11-04T10:00:00Z');
const agent={id:'selected-evidence',taskId:'task-selected',status:'blocked',terminal:false,
  inputRequest:{id:'q1',prompt:'Which scope?',options:['Small','Full']},
  conversation:{available:true,mode:'respond',messageUrl:'/agents/selected-evidence/messages',checkedAt:now}};
const storage=()=>{const records=new Map();return {getItem:key=>records.get(key)??null,setItem:(key,value)=>records.set(key,value)};};

test('evidence clocks distinguish task age, execution, session, observation and progress',()=>{
  const html=evidenceOverviewHtml({...agent,task:'Ship <feature>',harness:'codex',model:'gpt-6.1-sol-full-source-name',
    taskStartedAt:now-7200000,sessionStartedAt:now-600000,durationMs:180000,
    updatedAt:now-5000,lastProgressAt:now-120000},{now,endpoint});
  for(const value of ['Task age</dt><dd>2h 0m','Recorded execution</dt><dd>3m 0s',
    'Session age</dt><dd>10m 0s','Last observed</dt><dd>5s ago','Last progress</dt><dd>2m 0s ago',
    'Harness</dt><dd>codex','gpt-6.1-sol-full-source-name','data-action="talk"','Ship &lt;feature&gt;'])assert.ok(html.includes(value),value);
  assert.doesNotMatch(html,/Ship <feature>/);
});

test('absent execution and progress are not inferred from observation or model',()=>{
  const html=evidenceOverviewHtml({id:'a',status:'working',model:'codex-model',updatedAt:now},{now,endpoint});
  assert.doesNotMatch(html,/Recorded execution/);
  assert.match(html,/Harness<\/dt><dd>Unknown/);
  assert.match(html,/Task age<\/dt><dd>Unavailable/);
  assert.match(html,/Last progress<\/dt><dd>Unavailable/);
});
test('current turn clocks stay separate from unavailable task and session starts',()=>{
  const observed={id:'turn',status:'working',inventorySource:'codex_rollout',turnStartedAt:now-60000,taskStartedAt:null,sessionStartedAt:null};
  const html=evidenceOverviewHtml(observed,{now,endpoint});
  assert.match(html,/Current turn age<\/dt><dd>1m 0s/);assert.match(html,/Current turn started<\/dt><dd>/);
  assert.match(html,/Task age<\/dt><dd>Unavailable/);assert.match(html,/Session age<\/dt><dd>Unavailable/);
  const done=evidenceOverviewHtml({...observed,status:'done',terminal:true,endedAt:now-30000},{now:now+60000,endpoint});
  assert.match(done,/Current turn age<\/dt><dd>30s/,'finished turn age does not keep advancing');
  const missing=evidenceOverviewHtml({...observed,turnStartedAt:null},{now,endpoint});
  assert.match(missing,/Current turn age<\/dt><dd>Unavailable/);assert.match(missing,/Current turn started<\/dt><dd>Unavailable/);
});

test('observed usage labels cumulative session totals and keeps unpriced cost unavailable',()=>{
  const html=evidenceOverviewHtml({...agent,inventorySource:'codex_rollout',tokens:null,cost:null,
    usage:{scope:'session',tokens:{totalTokens:210},incompleteFields:[],cost:{usd:null,sources:[],complete:false},measuredAt:null},
    contextUsage:{usedTokens:100,windowTokens:200000,stale:true}},{now,endpoint});
  assert.match(html,/Session tokens<\/dt><dd>210/);
  assert.match(html,/Session cost<\/dt><dd>Unavailable/);
  assert.match(html,/Cumulative across this session/);
  assert.match(html,/Usage measurement time is unavailable/);
  assert.match(html,/Context<\/dt><dd>100 \/ 200,000 tokens · last recorded/);
  assert.doesNotMatch(html,/\$0\.00|0\.0c/);
  const missing=evidenceOverviewHtml({...agent,inventorySource:'codex_rollout'},{now,endpoint});
  assert.match(missing,/Session tokens<\/dt><dd>Unavailable/);
});

test('attempt subtotals retain partial and estimated qualifiers including a measured zero',()=>{
  const html=evidenceOverviewHtml({...agent,usage:{scope:'attempt',tokens:{totalTokens:0},incompleteFields:['totalTokens'],
    cost:{usd:0,sources:['estimate'],complete:false},measuredAt:null}},{now,endpoint});
  assert.match(html,/Attempt tokens<\/dt><dd>0 · partial/);
  assert.match(html,/Attempt cost<\/dt><dd>\$0\.00 · estimated · partial/);
  assert.match(html,/Current attempt totals/);
});
test('a lower-bound usage bucket also marks the displayed session total partial',()=>{
  const html=evidenceOverviewHtml({...agent,usageCoverage:{available:true,reason:'partial'},
    usage:{scope:'session',tokens:{totalTokens:210},incompleteFields:['outputTokens'],lowerBound:['output'],cost:{usd:null}}},{now,endpoint});
  assert.match(html,/Session tokens<\/dt><dd>210 · partial/);
});
test('context-only evidence retains its attempt scope when usage is unavailable',()=>{
  const html=evidenceOverviewHtml({...agent,usage:null,contextUsage:{scope:'attempt',usedTokens:100,windowTokens:200000}},{now,endpoint});
  assert.match(html,/Attempt tokens<\/dt><dd>Unavailable/);
  assert.match(html,/Current attempt totals/);
  assert.doesNotMatch(html,/Cumulative across this session/);
});

test('uncertain and active durable receipts remain composer locks regardless of draft text',()=>{
  for(const phase of ['checking','sending','uncertain']){
    const result=replyPresentation(agent,{phase,notice:'Check delivery'});
    assert.equal(result.locked,true);
    assert.equal(result.phase,phase==='uncertain'?'unconfirmed':'sending');
  }
  const sent={phase:'sent',inputVersion:inputRequestVersion(agent.inputRequest)};
  assert.equal(replyPresentation(agent,sent).locked,true);
  assert.equal(replyPresentation({...agent,inputRequest:{...agent.inputRequest,prompt:'Changed question'}},sent).locked,false);
  assert.equal(replyPresentation({...agent,conversation:{mode:'redirect'},inputRequest:null},sent).locked,false);
});

test('a lost reply receipt remains locked after recreating the client and editing the answer',async()=>{
  const saved=storage();let posts=0;
  const fetchImpl=async (_url,options)=>{
    if(options.method==='POST'){posts++;throw new Error('Lost connection');}
    return {ok:true,json:async()=>({agents:[agent]})};
  };
  const first=createReplyClient({endpoint,storage:saved,fetchImpl,now:()=>now});
  const result=await first.send(agent,'Small');
  assert.equal(result.phase,'uncertain');assert.equal(posts,1);
  const revisited=createReplyClient({endpoint,storage:saved,fetchImpl,now:()=>now});
  assert.deepEqual(replyPresentation(agent,revisited.state(agent.taskId)),{
    phase:'unconfirmed',locked:true,notice:result.notice});
  assert.equal((await revisited.send(agent,'Different text')).phase,'uncertain');
  assert.equal(posts,1,'editing never creates a second write after uncertain delivery');
});

test('latest preflight rejects changed input before an inspector answer can be posted',async()=>{
  let posts=0;
  const client=createReplyClient({endpoint,storage:storage(),now:()=>now,fetchImpl:async(_url,options)=>{
    if(options.method==='POST')posts++;
    return {ok:true,json:async()=>({agents:[{...agent,inputRequest:{...agent.inputRequest,prompt:'A new question'}}]})};
  }});
  const result=await client.send(agent,'Small');
  assert.equal(result.phase,'error');assert.match(result.notice,/question or its choices changed/i);assert.equal(posts,0);
});

test('polling preserves a selected evidence task while Jack occupies a different room',()=>{
  const agents=[{id:'room-host',status:'working'},{...agent}];
  assert.equal(cottageSelection(agents,{selected:agent.id,interiorId:'room-host'}),agent.id);
  assert.equal(cottageSelection(agents.slice(0,1),{selected:agent.id,interiorId:'room-host'}),'room-host');
});

test('a new question draft unlocks when the preceding revision finishes preflight or sending',async t=>{
  for(const outcome of ['error','sent'])await t.test(outcome,async()=>{
    let release,postStarted;
    const held=new Promise(resolve=>{release=resolve;});
    const started=new Promise(resolve=>{postStarted=resolve;});
    const nextAgent={...agent,inputRequest:{...agent.inputRequest,prompt:'A different question'}};
    const client=createReplyClient({endpoint,storage:storage(),now:()=>now,fetchImpl:async(_url,options)=>{
      if(options.method==='POST'){
        postStarted();await held;
        return {ok:true,json:async()=>({ok:true,delivery:'accepted',requestId:JSON.parse(options.body).requestId})};
      }
      if(outcome==='error')await held;
      return {ok:true,json:async()=>({agents:[outcome==='error'?nextAgent:agent]})};
    }});
    const pending=client.send(agent,'Small');
    if(outcome==='sent')await started;
    const nextDraft={text:'My next answer',phase:'idle',notice:''};
    reconcileReplyReceipt(nextDraft,nextAgent,client.state(agent.taskId));
    assert.equal(nextDraft.phase,'sending');assert.equal(nextDraft.deliveryLocked,true);
    release();assert.equal((await pending).phase,outcome);
    reconcileReplyReceipt(nextDraft,nextAgent,client.state(agent.taskId));
    assert.equal(nextDraft.deliveryLocked,false);
    assert.equal(nextDraft.phase,outcome==='error'?'error':'idle');
    assert.equal(nextDraft.text,'My next answer');
    if(outcome==='error')assert.match(nextDraft.notice,/question or its choices changed/i);
  });
});

test('receipt reconciliation preserves real uncertainty and accepted current-question locks',()=>{
  const draft={text:'Preserve me',phase:'sending',receiptPending:true};
  reconcileReplyReceipt(draft,agent,{phase:'uncertain',notice:'Check delivery'});
  assert.equal(draft.phase,'unconfirmed');assert.equal(draft.deliveryLocked,true);
  reconcileReplyReceipt(draft,agent,{phase:'idle'});
  assert.equal(draft.phase,'unconfirmed','missing later receipt evidence cannot silently clear uncertainty');
  const accepted={phase:'sent',notice:'Accepted',inputVersion:inputRequestVersion(agent.inputRequest)};
  reconcileReplyReceipt(draft,agent,accepted);
  assert.equal(draft.phase,'sent');assert.equal(draft.deliveryLocked,true);
});

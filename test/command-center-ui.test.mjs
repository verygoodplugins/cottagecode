import test from 'node:test';
import assert from 'node:assert/strict';
import {fleetView,taskView} from '../src/command-model.mjs';
import {attentionQueue,dispatchHTML,threadsHTML,graphData,searchTasks,previewHTML} from '../src/command-render.mjs';
import {drawPlotLens,lensContext,lensLabel} from '../src/command-center.mjs';

const now=Date.parse('2026-11-04T06:00:00Z');
const agent=(id,extra={})=>({id,taskId:id,task:`Work ${id}`,town:'HubTown',status:'working',inventoryScope:'dashboard',harness:'Codex',model:'GPT-6.1',updatedAt:now,taskStartedAt:now-3600000,...extra});
const view=raw=>taskView(raw,{now});
const pr={url:'https://github.com/example/project/pull/42',number:42,state:'open',authority:'hub',reviewState:'ready',stage:'ready',checkedAt:now,headSha:'1234567',reason:'Recorded checks passed'};

test('dispatch escapes all source strings and keeps clocks independent',()=>{
  const task=view(agent('x" onclick="bad',{task:'<img src=x onerror=bad()>',activity:'<script>bad()</script>',harness:'<svg onload=bad()>',model:'" autofocus',taskStartedAt:null,sessionStartedAt:now-7200000,durationMs:60000}));
  const html=dispatchHTML([task]);
  assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<svg'));
  assert.match(html,/&lt;img/);assert.match(html,/x&quot; onclick=&quot;bad/);
  assert.match(html,/<small>Task<\/small> Unavailable/);assert.match(html,/<small>Execution<\/small> 1m 0s/);assert.match(html,/<small>Session<\/small> 2h 0m/);
});

test('attention puts answerable recorded input before source-only input and blocked delivery',()=>{
  const blocked=view(agent('blocked',{status:'blocked',pr:{...pr,stage:'blocked',reviewState:'blocked'}}));
  const source=view(agent('source',{inputRequest:{prompt:'Open the original source?'}}));
  const answer={...view(agent('answer',{inputRequest:{prompt:'Keep seven days?'}})),capability:{available:true,mode:'respond'}};
  const working=view(agent('working'));
  assert.deepEqual(attentionQueue([blocked,source,working,answer]).map(task=>task.id),['answer','source','blocked']);
});

test('search matches multiple words across title, town, explicit owner and PR identity',()=>{
  const tasks=[view(agent('a',{task:'Repair read receipts',owner:'Mira',pr})),view(agent('b',{task:'Repair width',town:'MemTown'}))];
  assert.deepEqual(searchTasks(tasks,'MIRA 42').map(task=>task.id),['a']);
  assert.deepEqual(searchTasks(tasks,'repair mem').map(task=>task.id),['b']);
  assert.equal(searchTasks(tasks,'absent').length,0);
});

test('thread graph deduplicates shared delivery and keeps prerequisite direction',()=>{
  const fleet=fleetView({agents:[agent('prerequisite',{pr}),agent('dependent',{pr,parent:'prerequisite'})],relationships:[{from:'task:prerequisite',to:'task:dependent',kind:'depends-on'},{from:'task:missing',to:'task:dependent',kind:'depends-on'}]},{now});
  const {nodes,edges}=graphData(fleet.tasks,fleet);
  assert.equal([...nodes.values()].filter(node=>node.kind==='pr').length,1);
  assert.deepEqual(edges.filter(edge=>edge.kind==='depends-on'),[{from:'task:prerequisite',to:'task:dependent',kind:'depends-on'}]);
  const html=threadsHTML(fleet.tasks,fleet,{selectedId:'dependent',width:400});
  assert.match(html,/prerequisite → dependent/);assert.match(html,/Issue links are not recorded/);assert.match(html,/1 distinct PRs/);
  assert.ok(!html.includes('<svg'));
  assert.match(html,/value="dependent" selected/);
});

test('thread issue links accept only safe URLs and illustrative references stay local',()=>{
  const raw=agent('a',{issues:[{title:'<unsafe>',url:'javascript:alert(1)'},{title:'<safe>',url:'https://example.org/issue/1'}]});
  const fleet=fleetView([raw],{now});
  const html=threadsHTML(fleet.tasks,fleet,{width:900});
  assert.ok(!html.includes('javascript:'));assert.match(html,/href="https:\/\/example.org\/issue\/1"/);assert.match(html,/&lt;safe&gt;/);
  const illustrative=fleetView([{...raw,illustrative:true}],{now});
  assert.ok(!threadsHTML(illustrative.tasks,illustrative,{width:900}).includes('href='));
});

test('PR preview shows available evidence without inventing a check result',()=>{
  const html=previewHTML(view(agent('a',{pr:{...pr,reason:'<review pending>',checks:[]}})));
  assert.match(html,/CI unavailable/);assert.match(html,/Hub authority/);assert.match(html,/&lt;review pending&gt;/);
});

function canvas(){
  const calls=[],stack=[];
  const ctx={globalAlpha:.4,font:'original',fillStyle:'pink',textBaseline:'alphabetic',textAlign:'left',measureText:text=>({width:text.length*4}),
    save(){stack.push({globalAlpha:this.globalAlpha,font:this.font,fillStyle:this.fillStyle,textBaseline:this.textBaseline,textAlign:this.textAlign});},
    restore(){Object.assign(this,stack.pop());},fillRect(...args){calls.push(['rect',...args]);},fillText(...args){calls.push(['text',...args]);}};
  return {ctx,calls,stack};
}

test('lens annotates existing household and child positions, restores canvas state, and obeys dimming',()=>{
  const a=agent('a'),roommate=agent('b',{harness:'Claude Code'}),kid=agent('kid',{harness:'Cursor'}),other=agent('other',{town:'MemTown'});
  const plots=[{agent:{...a,roommates:[roommate]},x:20,y:60,w:54,kids:[{agent:kid,x:30,y:150}]},{agent:other,x:400,y:90}];
  const before=JSON.stringify(plots),{ctx,calls,stack}=canvas();
  drawPlotLens(ctx,plots,[a,roommate,kid,other].map(view),'owner',{selectedId:'b',townFilter:'HubTown',visible:raw=>raw.id!=='kid'});
  assert.equal(JSON.stringify(plots),before);assert.equal(stack.length,0);
  assert.equal(ctx.globalAlpha,.4);assert.equal(ctx.font,'original');assert.equal(ctx.fillStyle,'pink');
  const labels=calls.filter(call=>call[0]==='text');assert.deepEqual(labels,[['text','Claude Code +1',47,50]]);
});

test('village lens performs no drawing and missing clocks stay unavailable',()=>{
  const {ctx,calls}=canvas(),task=view(agent('a',{taskStartedAt:null,sessionStartedAt:now-60000}));
  drawPlotLens(ctx,[{agent:task.raw,x:0,y:0}],[task],'village');assert.equal(calls.length,0);
  assert.equal(lensLabel(task,'time'),'Unavailable');assert.match(lensContext(task,'time'),/Task Unavailable · Execution Unavailable · Session 1m 0s/);
});

test('Threads fills two actual lanes when issue evidence is absent and aligns delivery arrows',()=>{
  const fleet=fleetView([agent('a',{pr})],{now});
  const html=threadsHTML(fleet.tasks,fleet,{width:900});
  const header=html.match(/<div class="cc-graph-head"[^>]*>(.*?)<\/div>/s)?.[1];
  assert.equal(header,'<span style="left:1%;width:45%">Cottages</span><span style="left:52%;width:45%">Pull requests</span>');
  assert.match(html,/left:1%;top:20px;width:45%/);assert.match(html,/left:52%;top:20px;width:45%/);
  assert.match(html,/d="M414,62 C441,62 441,62 468,62"/);
});

test('Threads retains three evidence lanes and removes absent PR lanes',()=>{
  const issue={title:'Recorded issue',url:'https://example.org/issue/1'};
  const full=fleetView([agent('a',{issues:[issue],pr})],{now});
  const fullHTML=threadsHTML(full.tasks,full,{width:900});
  assert.match(fullHTML,/<span style="left:1%;width:28%">Issues<\/span><span style="left:35%;width:28%">Cottages<\/span><span style="left:69%;width:28%">Pull requests<\/span>/);
  const noPr=fleetView([agent('a',{issues:[issue]})],{now});
  const noPrHTML=threadsHTML(noPr.tasks,noPr,{width:900});
  assert.match(noPrHTML,/<span style="left:1%;width:45%">Issues<\/span><span style="left:52%;width:45%">Cottages<\/span>/);
  assert.ok(!noPrHTML.includes('>Pull requests</span>'));
});

test('parent-only Threads uses one lane with same-lane arrows preserving direction',()=>{
  const fleet=fleetView([agent('parent'),agent('child',{parent:'parent'})],{now});
  const html=threadsHTML(fleet.tasks,fleet,{width:900,selectedId:'child'});
  assert.match(html,/<span style="left:1%;width:96%">Cottages<\/span>/);
  assert.match(html,/d="M873,62 C897,62 897,190 873,190"/);
  assert.match(html,/Work parent — parent → child — Work child/);
  assert.match(html,/value="child" selected/);
});

test('search finds recorded cottage names and linked issue titles, numbers and URLs',()=>{
  const tasks=[view(agent('a',{name:'Bolt',issues:[{title:'Retain the receipt cursor',number:701,url:'https://example.org/issues/701'}]})),view(agent('b',{name:'Fern'}))];
  for(const query of ['bolt','receipt cursor','701','example.org/issues/701'])assert.deepEqual(searchTasks(tasks,query).map(task=>task.id),['a']);
  assert.deepEqual(searchTasks(tasks,'fern').map(task=>task.id),['b']);
  assert.equal(searchTasks(tasks,'702').length,0);
});

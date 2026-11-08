import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createLabServer} from '../experiments/command-center/server.mjs';
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function fixture(t){const seen=[];const upstream=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({url:req.url,method:req.method,origin:req.headers.origin,request:req.headers['x-cottagecode-request'],body});res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,agents:[],route:req.url}));});const upstreamUrl=await listen(upstream);const server=createLabServer({upstream:upstreamUrl});const url=await listen(server);t.after(()=>{server.closeAllConnections();upstream.closeAllConnections();return Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);});return {url,upstreamUrl,seen,server};}
const headers=origin=>({origin,'content-type':'application/json','x-cottagecode-request':'user-message'});
test('view links accept only known root perspectives and scenario values',async t=>{
  const {url,seen}=await fixture(t);const base=await fetch(url+'/'),status=base.status,body=await base.text();
  for(const query of ['view=townwatch','view=dispatch','view=threads&scenario=1','scenario=0']){
    const response=await fetch(url+'/?'+query);assert.equal(response.status,status);assert.equal(await response.text(),body);
  }
  for(const path of ['/?view=terminal','/?scenario=yes','/?view=townwatch&view=threads','/?upstream=elsewhere','/agents?view=threads','/model.mjs?scenario=1'])assert.equal((await fetch(url+path)).status,400,path);
  assert.equal(seen.length,0);
});
test('lab proxies only exact feed/activity routes to the constructor upstream',async t=>{
  const {url,seen}=await fixture(t);assert.equal((await fetch(url+'/agents')).status,200);assert.equal((await fetch(url+'/agents/cottage-1/activity?before=cursor&limit=10')).status,200);
  assert.deepEqual(seen.map(r=>r.url),['/agents','/agents/cottage-1/activity?before=cursor&limit=10']);
  for(const path of ['/v1/tasks','/agents/one/unknown','/agents?upstream=http://evil.invalid','/agents/one/activity?url=http://evil.invalid','/agents/a%2Fb/activity','/agents/a%252Fb/activity'])assert.equal((await fetch(url+path)).status,400,path);
  assert.equal(seen.length,2);
});
test('cross-origin, missing intent, unsupported methods and oversized writes never reach upstream',async t=>{
  const {url,seen}=await fixture(t);const path=url+'/agents/cottage-1/messages';
  assert.equal((await fetch(path,{method:'POST',headers:headers('https://evil.invalid'),body:'{}'})).status,403);
  assert.equal((await fetch(path,{method:'POST',headers:{origin:url,'content-type':'application/json'},body:'{}'})).status,403);
  for(const [method,route] of [['PUT','/agents'],['POST','/agents'],['GET','/agents/cottage-1/messages'],['DELETE','/agents/cottage-1/messages']])assert.equal((await fetch(url+route,{method})).status,405);
  assert.equal((await fetch(path,{method:'POST',headers:headers(url),body:JSON.stringify({message:'x'.repeat(40_000)})})).status,413);assert.equal(seen.length,0);
});
test('explicit local message proxy preserves validation headers for upstream authority',async t=>{
  const {url,upstreamUrl,seen}=await fixture(t);const body=JSON.stringify({taskId:'fictional',message:'stub only',requestId:'stub-only-1234'});
  assert.equal((await fetch(url+'/agents/cottage-1/messages',{method:'POST',headers:headers(url),body})).status,200);
  assert.equal(seen.length,1);assert.equal(seen[0].origin,upstreamUrl);assert.equal(seen[0].request,'user-message');assert.equal(seen[0].body,body);
});
test('static routes only expose safe known modules and no filesystem traversal',async t=>{
  const {url,seen}=await fixture(t);assert.equal((await fetch(url+'/model.mjs')).status,200);assert.equal((await fetch(url+'/drafts.mjs')).status,200);assert.equal((await fetch(url+'/src/pr.mjs')).status,200);
  for(const route of ['/src/../package.json','/src/%2e%2e%2fpackage.json','/server.mjs','/.git/config'])assert.ok([400,404].includes((await fetch(url+route)).status),route);assert.equal(seen.length,0);
});
test('upstream is fixed loopback only and redirect responses are not followed',async t=>{
  assert.throws(()=>createLabServer({upstream:'https://evil.invalid'}));let seen=0;
  const server=createLabServer({fetchImpl:async(_,options)=>{seen++;assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{location:'https://evil.invalid'}});}});const url=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
  assert.equal((await fetch(url+'/agents')).status,502);assert.equal(seen,1);
});
test('embedding callers cannot expose the lab on a non-loopback interface',()=>{
  const server=createLabServer();assert.throws(()=>server.listen(8790,'0.0.0.0'),/loopback/);assert.throws(()=>server.listen({port:8790,host:'0.0.0.0'}),/loopback/);
});

test('town preview serves the original scene and production modules without widening the proxy',async t=>{
  const server=createLabServer({town:true});const url=await listen(server);t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch(url+'/?demo=1');assert.equal(response.status,200);assert.match(await response.text(),/id="town"/);
  assert.equal((await fetch(url+'/modules/command-model.mjs')).status,200);
  for(const route of ['/?scenario=1','/modules/audio/../../package.json','/modules/.env','/v1/tasks'])assert.equal((await fetch(url+route)).status,400,route);
});

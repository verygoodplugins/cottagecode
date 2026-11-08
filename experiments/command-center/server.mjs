/** A loopback-only prototype harness; no arbitrary destination or generic proxy. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const localHosts=new Set(['127.0.0.1','localhost','[::1]']);
const staticFiles=new Map([['/','index.html'],['/model.mjs','model.mjs'],['/scenario.mjs','scenario.mjs'],['/replies.mjs','replies.mjs'],['/drafts.mjs','drafts.mjs'],['/app.mjs','app.mjs'],['/style.css','style.css']]);
const MAX_BODY=32*1024;
export function createLabServer({upstream='http://127.0.0.1:8787',fetchImpl=globalThis.fetch,town=false}={}){
  const target=new URL(upstream);
  if(target.protocol!=='http:'||!localHosts.has(target.hostname)||target.username||target.password||!['','/'].includes(target.pathname)||target.search||target.hash)throw new Error('The upstream must be a fixed loopback HTTP origin.');
  const server=createServer(async(req,res)=>{
    const json=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
    try{
      const host=new URL(`http://${req.headers.host}`);
      const port=server.address()?.port;
      if(!localHosts.has(host.hostname)||Number(host.port||80)!==port)return json(403,{error:'Use the local lab address.'});
      // Check raw segments before URL parsing can normalize traversal away.
      if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\')||/%(?:2f|5c|25)/i.test(req.url.split('?')[0])||req.url.split('?')[0].split('/').some(segment=>{try{return ['.','..'].includes(decodeURIComponent(segment));}catch{return true;}}))return json(400,{error:'Invalid local route.'});
      const url=new URL(req.url,host);
      const rawPath=req.url.split('?')[0];
      const agentRoute=/^\/agents\/([^/]+)\/(activity|messages)$/.exec(rawPath);
      let routeAction='',routeId='';
      if(agentRoute){try{routeId=decodeURIComponent(agentRoute[1]);}catch{return json(400,{error:'Invalid local route.'});}
        if(/^[A-Za-z0-9_.:-]+$/.test(routeId))routeAction=agentRoute[2];}
      const activity=routeAction==='activity',messages=routeAction==='messages',agents=url.pathname==='/agents';
      const source=/^\/src\/[a-zA-Z0-9_-]+\.mjs$/.test(url.pathname),module=town&&/^\/modules\/[a-zA-Z0-9_-]+\.mjs$/.test(url.pathname),audio=town&&/^\/modules\/audio\/[a-zA-Z0-9_-]+\.mp3$/.test(url.pathname),file=staticFiles.get(url.pathname);
      if(!agents&&!activity&&!messages&&!source&&!module&&!audio&&!file)return json(400,{error:'This route is not available in the lab.'});
      if(req.method!==(messages?'POST':'GET'))return json(405,{error:'This method is not available for the route.'});
      const allowedQuery=activity?new Set(['after','before','limit']):url.pathname==='/'?new Set(town?['demo']:['view','scenario']):new Set();
      if([...url.searchParams.keys()].some(key=>!allowedQuery.has(key)))return json(400,{error:'Unsupported query parameter.'});
      if(url.pathname==='/'&&[...url.searchParams].some(([key,value])=>url.searchParams.getAll(key).length!==1||!(key==='view'?['townwatch','dispatch','threads']:['0','1']).includes(value)))return json(400,{error:'Unsupported view selection.'});
      if(file||source||module||audio){
        const location=town&&url.pathname==='/'?new URL('../../src/town.html',import.meta.url):(module||audio)?new URL('../../src/'+url.pathname.slice(9),import.meta.url):source?new URL('../../src/'+url.pathname.slice(5),import.meta.url):new URL(file,import.meta.url);
        try{const contents=await readFile(location);res.writeHead(200,{'content-type':audio?'audio/mpeg':url.pathname.endsWith('.css')?'text/css; charset=utf-8':url.pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(contents);}catch(error){if(error.code==='ENOENT')return json(404,{error:'The lab asset is not available.'});throw error;}
      }
      let body;
      if(messages){
        if(req.headers.origin!==host.origin||req.headers['x-cottagecode-request']!=='user-message'||!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')||req.headers['sec-fetch-site']==='cross-site')return json(403,{ok:false,delivery:'not_sent',error:'Messages require an explicit local Send.'});
        if(Number(req.headers['content-length'])>MAX_BODY)return json(413,{ok:false,delivery:'not_sent',error:'The message payload is too large.'});
        let bytes=0;const chunks=[];
        for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_BODY)return json(413,{ok:false,delivery:'not_sent',error:'The message payload is too large.'});chunks.push(chunk);}
        body=Buffer.concat(chunks).toString('utf8');
        try{const parsed=JSON.parse(body);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();}catch{return json(400,{ok:false,delivery:'not_sent',error:'Send a JSON message object.'});}
      }
      const response=await fetchImpl(new URL(url.pathname+url.search,target),{method:req.method,redirect:'manual',signal:AbortSignal.timeout(15_000),headers:{accept:'application/json',...(messages?{'content-type':'application/json','origin':target.origin,'x-cottagecode-request':'user-message'}:{})},...(messages?{body}:{})});
      if(response.status>=300&&response.status<400)return json(502,{error:'The local source returned a redirect.'});
      const responseBody=await response.text();
      res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(responseBody);
    }catch{return json(502,{error:'The local source is unavailable. No illustrative data has been substituted.'});}
  });
  // Even an embedding caller cannot accidentally expose the proxy on the LAN.
  const listen=server.listen.bind(server);
  server.listen=(port=8790,host,callback)=>{
    if(typeof port==='object')throw new Error('Use a numeric port; this lab binds loopback only.');
    if(typeof host==='string'&&!localHosts.has(host))throw new Error('The lab binds loopback only.');
    return listen(port,'127.0.0.1',typeof host==='function'?host:callback);
  };
  return server;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const index=process.argv.indexOf('--port'),port=index<0?8790:Number(process.argv[index+1]);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Use --port with a port between 1 and 65535.');
  createLabServer({town:process.argv.includes('--town')}).listen(port,()=>process.stdout.write(`CottageCode command center: http://127.0.0.1:${port}\n`));
}

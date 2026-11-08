/** Small public telemetry facts only. Hub task inventory remains lifecycle authority. */
const states=new Set(['started','succeeded','failed','cancelled']);
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=120&&/^[a-zA-Z0-9_.:/@+-]+$/.test(value);
const tokenFields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'];
const measured=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function scopedUsage(scope,row,snapshot) {
  const usage=scope.usage;
  // An observed alias belongs to its managed task. Its retained meter details
  // are diagnostic, not a second billable usage source.
  if(row.ownedBy||usage?.supersededBy)return {usage:null,usageCoverage:{available:false,reason:'superseded'}};
  if(!usage||typeof usage!=='object')return {usage:null,usageCoverage:{available:false,reason:'missing_usage'}};
  const tokens=Object.fromEntries(tokenFields.map(key=>[key,measured(usage.tokens?.[key])]));
  const sources=Array.isArray(usage.cost?.sources)?usage.cost.sources.filter(source=>['vendor','estimate','unmetered'].includes(source)):[];
  const usd=sources.some(source=>['vendor','estimate'].includes(source))?measured(usage.cost?.usd):null;
  if(!Object.values(tokens).some(value=>value!==null)&&usd===null)return {usage:null,usageCoverage:{available:false,reason:'missing_usage'}};
  const incompleteFields=tokenFields.filter(key=>Array.isArray(usage.incompleteFields)&&usage.incompleteFields.includes(key)||snapshot.coverage?.complete===false&&tokens[key]!==null);
  const lowerBound=['input','output','cacheRead','cacheWrite','total'].filter(key=>Array.isArray(usage.lowerBound)&&usage.lowerBound.includes(key));
  return {usage:{source:'hub:agent-events',scope:scope.scope.startsWith('s:')?'session':'attempt',scopeId:scope.scope,
    tokens,incompleteFields,lowerBound,
    cost:{usd,sources,complete:usage.cost?.complete===true&&snapshot.coverage?.complete!==false},
    // No usage timestamp is exported by Hub's projection. A later tool event
    // must not make old cumulative usage look newly measured.
    measuredAt:null,coverageComplete:snapshot.coverage?.complete===true},
    usageCoverage:{available:true,reason:incompleteFields.length||lowerBound.length||snapshot.coverage?.complete===false?'partial':null}};
}
export function attachHubTelemetry(cottage,snapshot,now=Date.now()) {
  let result={...cottage,toolActivity:null,toolCoverage:{available:false,reason:'unavailable'},
    usage:null,usageCoverage:{available:false,reason:'unavailable'},contextUsage:null};
  if(!snapshot||!Array.isArray(snapshot.tasks))return result;
  const rows=snapshot.tasks.filter(row=>row?.taskId===cottage.taskId);
  const missing=reason=>({...result,toolCoverage:{available:false,reason},
    ...(result.usageCoverage.reason==='unavailable'?{usageCoverage:{available:false,reason}}:{})});
  if(rows.length!==1)return missing(rows.length?'ambiguous_task':'missing_task');
  const row=rows[0];let scope;
  if(row.currentAttempt!=null) {
    if(typeof row.currentAttempt!=='string'||!Array.isArray(row.attempts))return missing('ambiguous_scope');
    // A retained event window may name an attempt whose scope has no events.
    // Absence is not an identity conflict and must never enable session fallback.
    if(!row.attempts.length)return missing('missing_scope');
    const matches=row.attempts.filter(s=>s?.scope===row.currentAttempt&&s.current===true);
    if(matches.length!==1||row.attempts.some(s=>s?.current===true&&s.scope!==row.currentAttempt))return missing('ambiguous_scope');
    scope=matches[0];
  } else {
    // Never fall back from an ambiguous attempt to an observed session.
    if(Array.isArray(row.attempts)&&row.attempts.length)return missing('ambiguous_scope');
    if(!cottage.sessionId||!Array.isArray(row.observed))return missing('missing_scope');
    const matches=row.observed.filter(s=>Array.isArray(s?.sessionIds)&&s.sessionIds.includes(cottage.sessionId));
    if(!matches.length)return missing('missing_scope');
    if(matches.length!==1||matches[0].sessionIds.length!==1||matches[0].scope!==`s:${cottage.sessionId}`)return missing('ambiguous_scope');
    scope=matches[0];
  }
  if(scope.staleAttempt===true)return missing('stale_scope');
  result={...result,...scopedUsage(scope,row,snapshot)};
  const context=scope.context;
  const contextAt=typeof context?.at==='string'?Date.parse(context.at):NaN;
  if(!row.ownedBy&&!scope.usage?.supersededBy&&Number.isFinite(contextAt)&&contextAt>0&&contextAt<=now+30000){
    const usedTokens=measured(context.usedTokens),windowTokens=measured(context.windowTokens);
    if(usedTokens!==null||windowTokens!==null)result.contextUsage={source:'hub:agent-events',scope:scope.scope.startsWith('s:')?'session':'attempt',
      usedTokens,windowTokens,at:contextAt,usedRatio:usedTokens!==null&&windowTokens>0?usedTokens/windowTokens:null,
      stale:cottage.freshness?.isStale===true||now-contextAt>120000};
  }
  const call=scope.tool?.current?{...scope.tool.current,state:'started'}:scope.tool?.last;
  if(!call)return missing('missing_tool');
  const at=typeof call.at==='string'?Date.parse(call.at):NaN;
  if(!identifier(call.name)||!states.has(call.state)||!Number.isFinite(at)||at<=0||at>now+30000||
    (call.callId!=null&&!identifier(call.callId)))return missing('invalid_tool');
  const stale=cottage.freshness?.isStale===true||now-at>120000;
  return {...result,toolActivity:{name:call.name,state:call.state,at,callId:call.callId??null,source:'hub:agent-events',stale},
    toolCoverage:{available:true,reason:snapshot.coverage?.complete===false?'partial':null}};
}

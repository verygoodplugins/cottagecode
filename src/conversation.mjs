/** Browser-safe capability validation. A connected feed explicitly opts in to
 * messages on its own origin; observing a transcript never implies control. */
export const MAX_MESSAGE_LENGTH = 8000;
export function conversationCapability(agent, endpoint, {stale = false, now = Date.now()} = {}) {
  const capability = agent?.conversation;
  const unavailable = reason => ({available:false,reason});
  if (stale) return unavailable('The feed is stale. Reconnect before sending a message.');
  if (!capability?.available) return unavailable(capability?.reason || 'This source provides activity only. It has no connected route for messages.');
  if (typeof capability.messageUrl !== 'string' || !capability.messageUrl.trim()) return unavailable('The feed has not supplied a message route.');
  if (!agent.taskId || !['redirect','respond'].includes(capability.mode)) return unavailable('The feed has not identified a supported task conversation.');
  const checkedAt = typeof capability.checkedAt === 'number' ? capability.checkedAt : Date.parse(capability.checkedAt);
  if (!Number.isFinite(checkedAt) || now - checkedAt > 120000 || checkedAt > now + 30000) return unavailable('Message availability needs a fresh check from the task source.');
  try {
    const base = new URL(endpoint),url = new URL(capability.messageUrl,base);
    if (!['http:','https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) return unavailable('The message route must belong to the connected feed.');
    return {...capability,available:true,url:url.href};
  } catch { return unavailable('The feed has not supplied a valid message route.'); }
}

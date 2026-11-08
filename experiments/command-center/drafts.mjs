import {inputRequestVersion} from '../../src/input-request.mjs';
import {isTerminalForMessage} from '../../src/command-replies.mjs';

export function draftVersion(task) {
  const raw=task?.raw||{};
  return JSON.stringify([raw.taskId||task?.id||'',raw.status||'',isTerminalForMessage(raw),inputRequestVersion(raw.inputRequest)||'no-input',
    raw.conversation?.mode||task?.capability?.mode||'',raw.conversation?.messageUrl||task?.capability?.url||'']);
}

export function reconcileDraft(draft,task) {
  const version=draftVersion(task);
  if(draft.version!==version){draft.changed=true;return draft;}
  if(!draft.changed)draft.raw=structuredClone(task.raw);
  return draft;
}

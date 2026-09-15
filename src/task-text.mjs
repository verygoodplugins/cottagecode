/** Turn known task-routing wrappers into the text a person should read. */
function string(value) { return typeof value === "string" ? value : ""; }

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/gi, (_all, entity) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
  })[entity.toLowerCase()]);
}

function plain(value) {
  return decodeEntities(string(value).replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " "))
    .replace(/\s+/g, " ").trim();
}

function field(body, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(body);
  return match ? plain(match[1]) : "";
}

/**
 * Task notifications are transport envelopes, never work descriptions. Their
 * human summary is useful; task IDs and implementation event payloads are not.
 */
export function taskText(value) {
  const raw = string(value).trim();
  const notification = /^<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>$/i.exec(raw);
  // Preserve genuine requests verbatim. Angle brackets can be part of a real
  // code example and the renderer escapes them before putting them in HTML.
  if (!notification) return raw;
  for (const name of ["summary", "request", "prompt", "title"]) {
    const text = field(notification[1], name);
    if (text) return text;
  }
  return "";
}

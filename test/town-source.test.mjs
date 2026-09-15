import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function townFunction(name) {
  const source = await readFile(new URL("../src/town.mjs", import.meta.url), "utf8");
  const match = source.match(new RegExp(`export function ${name}\\([^]*?\\n}`));
  assert.ok(match, `${name} should remain a pure exported town helper`);
  return Function(`${match[0].replace("export ", "")}\nreturn ${name};`)();
}

test("custom feed namespace remains distinct when its payload calls itself demo", async () => {
  const feedNamespace = await townFunction("feedNamespace");
  assert.equal(feedNamespace(null, true), "demo");
  assert.equal(feedNamespace("https://cottage.example/agents", false), "feed:https://cottage.example/agents");
  assert.notEqual(
    feedNamespace("https://cottage.example/agents", false),
    feedNamespace(null, true),
    "a custom endpoint must not share demo journal/history storage",
  );
});

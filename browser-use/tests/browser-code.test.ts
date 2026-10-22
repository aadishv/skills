import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runScript } from "../extensions/browser-code-worker.ts";

async function texts(code: string, globals?: Record<string, unknown>): Promise<string[]> {
  const output = await runScript(code, globals);
  return output.map((item) => (item.type === "text" ? item.text : `[${item.mimeType}]`));
}

test("text() passes strings as is and other values as JSON", async () => {
  assert.deepEqual(await texts(`text("a\\nb"); text({ a: 1 }); text([1, "x"])`), ["a\nb", '{"a":1}', '[1,"x"]']);
});

test("console output and final expressions are dropped", async () => {
  assert.deepEqual(await texts(`console.log("hi"); const a = 1; a + 1`), []);
});

test("static, dynamic, and bare imports resolve", async () => {
  assert.deepEqual(await texts(`import { sep } from "node:path"; const { sep: s } = await import("node:path"); text(sep + s)`), ["//"]);
  assert.deepEqual(await texts(`import { WebSocket } from "ws"; text(typeof WebSocket)`), ["function"]);
});

test("globals can be shadowed by script declarations", async () => {
  assert.deepEqual(await texts(`const tabs = await browser.tabs(); text(tabs)`, { browser: { tabs: async () => [1] } }), ["[1]"]);
});

test("locals do not persist across scripts", async () => {
  await runScript(`const kept = 1;`);
  assert.deepEqual(await texts(`text(typeof kept)`), ["undefined"]);
});

test("image() sniffs the type", async () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  assert.deepEqual(await texts(`text("before"); image(globalThis.png)`, { png }), ["before", "[image/png]"]);
  await assert.rejects(runScript(`image(Buffer.from("nope"))`), /PNG, JPEG, GIF, or WebP/);
});

test("syntax errors carry a location", async () => {
  await assert.rejects(runScript(`const a = 1\nreturn a`), (error: Error) => {
    assert.match(error.stack ?? "", /Illegal return statement \(pass results to text\(\) instead\)/);
    assert.match(error.stack ?? "", /line:2\nreturn a/);
    return true;
  });
});

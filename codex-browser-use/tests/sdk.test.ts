import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import { connectBrowser } from "../sdk/index.ts";

let server: WebSocketServer;
let cdpUrl: string;
const methods: string[] = [];

before(async () => {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolvePromise) => server.once("listening", resolvePromise));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
  cdpUrl = `ws://127.0.0.1:${address.port}`;

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      };
      methods.push(request.method);
      let result: Record<string, unknown> = {};
      if (request.method === "Target.getTargets") {
        result = {
          targetInfos: [{ targetId: "target-123456", type: "page", title: "Example", url: "https://example.com" }],
        };
      } else if (request.method === "Target.attachToTarget") {
        result = { sessionId: "session-1" };
      } else if (request.method === "Runtime.evaluate") {
        const expression = String(request.params.expression);
        let value: unknown = null;
        if (expression === "document.title") value = "Example";
        else if (expression === "location.href") value = "https://example.com";
        else if (expression === "document.readyState") value = "complete";
        else if (expression.includes("getBoundingClientRect")) value = { x: 20, y: 30 };
        else if (expression.includes("textContent")) value = "Hello";
        result = { result: { type: typeof value, value } };
      } else if (request.method === "Accessibility.getFullAXTree") {
        result = {
          nodes: [
            { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example" } },
            { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Hello" } },
          ],
        };
      } else if (request.method === "Page.captureScreenshot") {
        result = { data: Buffer.from("png").toString("base64") };
      }
      socket.send(JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }));
    });
  });
});

after(async () => {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
});

test("high-level SDK emits flattened CDP requests against a raw endpoint", async () => {
  const browser = await connectBrowser({ backend: "cdp", cdpUrl });
  try {
    assert.equal(browser.backend, "cdp");
    const tabs = await browser.tabs();
    assert.equal(tabs[0]?.targetId, "target-123456");

    const page = await browser.page("target-1");
    assert.equal(await page.title(), "Example");
    assert.equal(await page.url(), "https://example.com");
    assert.equal(await page.locator("h1").text(), "Hello");
    await page.locator("button").click();
    const snapshot = await page.accessibilitySnapshot({ compact: true });
    assert.match(snapshot, /\[heading\] Hello/);
    assert.deepEqual(await page.screenshot(), Buffer.from("png"));
  } finally {
    await browser.close();
  }

  assert.ok(methods.includes("Target.getTargets"));
  assert.ok(methods.includes("Target.attachToTarget"));
  assert.ok(methods.includes("Runtime.evaluate"));
  assert.ok(methods.includes("Input.dispatchMouseEvent"));
  assert.ok(methods.includes("Accessibility.getFullAXTree"));
  assert.ok(methods.includes("Target.detachFromTarget"));
});

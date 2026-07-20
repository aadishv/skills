import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const token = "test-token-that-is-definitely-longer-than-thirty-two-characters";
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
let child: ChildProcess;
let url: string;
let extension: WebSocket;
let sdk: WebSocket;

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    socket.once("message", (data) => resolvePromise(data.toString()));
    socket.once("error", rejectPromise);
  });
}

async function open(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.once("open", resolvePromise);
    socket.once("error", rejectPromise);
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("Expected TCP address");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

before(async () => {
  const port = await freePort();
  url = `ws://127.0.0.1:${port}`;
  const root = await mkdtemp(resolve(tmpdir(), "codex-browser-bridge-"));
  const config = resolve(root, "config.json");
  await writeFile(config, JSON.stringify({ token, port, extensionId }));
  const script = resolve(fileURLToPath(new URL("..", import.meta.url)), "scripts/bridge.mjs");
  child = spawn(process.execPath, [script, "serve"], {
    env: { ...process.env, CODEX_BROWSER_CONFIG: config, CODEX_BROWSER_RUNTIME: resolve(root, "runtime") },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }

  extension = new WebSocket(url, { origin: `chrome-extension://${extensionId}` });
  await open(extension);
  const extensionHello = nextMessage(extension);
  extension.send(JSON.stringify({ type: "hello", role: "extension", token, protocolVersion: 1 }));
  assert.equal(JSON.parse(await extensionHello).ok, true);

  sdk = new WebSocket(url);
  await open(sdk);
  const sdkHello = nextMessage(sdk);
  sdk.send(JSON.stringify({ type: "hello", role: "sdk", token, protocolVersion: 1 }));
  assert.deepEqual(JSON.parse(await sdkHello), {
    type: "hello",
    ok: true,
    protocolVersion: 1,
    extensionConnected: true,
  });
});

after(async () => {
  extension?.close();
  sdk?.close();
  child?.kill("SIGTERM");
  await new Promise((resolvePromise) => child?.once("exit", resolvePromise));
});

test("bridge relays flattened CDP JSON without an RPC wrapper", async () => {
  const request = JSON.stringify({
    id: 42,
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    sessionId: "session-1",
  });
  const receivedByExtension = nextMessage(extension);
  sdk.send(request);
  assert.equal(await receivedByExtension, request);

  const response = JSON.stringify({
    id: 42,
    result: { result: { type: "string", value: "Example" } },
    sessionId: "session-1",
  });
  const receivedBySdk = nextMessage(sdk);
  extension.send(response);
  assert.equal(await receivedBySdk, response);
});

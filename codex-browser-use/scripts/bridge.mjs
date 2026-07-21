#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

if (process.platform !== "win32") process.umask(0o077);

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.CODEX_BROWSER_CONFIG ?? resolve(SKILL_DIR, ".bridge.json");
const RUNTIME_DIR = process.env.CODEX_BROWSER_RUNTIME ?? resolve(SKILL_DIR, ".runtime");
const PID_PATH = resolve(RUNTIME_DIR, "bridge.pid");
const LOG_PATH = resolve(RUNTIME_DIR, "bridge.log");
const DEFAULT_PORT = 32123;
const HOST = "127.0.0.1";

mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });

function readConfig({ create = false } = {}) {
  if (!existsSync(CONFIG_PATH)) {
    if (!create) throw new Error(`Missing ${CONFIG_PATH}. Run: node scripts/bridge.mjs setup`);
    const config = { token: randomBytes(32).toString("base64url"), port: DEFAULT_PORT };
    mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return config;
  }
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (typeof parsed.token !== "string" || parsed.token.length < 32) {
    throw new Error(`${CONFIG_PATH} must contain a token of at least 32 characters`);
  }
  const port = Number(process.env.BROWSER_BRIDGE_PORT ?? parsed.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Bridge port must be from 1 to 65535");
  return { token: parsed.token, port, extensionId: typeof parsed.extensionId === "string" ? parsed.extensionId : undefined };
}

function safeTokenEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(typeof message === "string" ? message : JSON.stringify(message));
}

async function health(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/status`, { signal: AbortSignal.timeout(500) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function setup() {
  const force = process.argv.includes("--force");
  if (force && existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  const config = readConfig({ create: true });
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Bridge URL: ws://${HOST}:${config.port}`);
  console.log(`Pairing token: ${config.token}`);
  console.log("Paste the bridge URL and pairing token into the Chrome extension options.");
}

async function start() {
  const config = readConfig({ create: true });
  const existing = await health(config.port);
  if (existing) {
    console.log(`Browser bridge already running (pid ${existing.pid}) at ws://${HOST}:${config.port}`);
    return;
  }
  const logFd = openSync(LOG_PATH, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const status = await health(config.port);
    if (status) {
      console.log(`Browser bridge started (pid ${status.pid}) at ws://${HOST}:${config.port}`);
      return;
    }
  }
  throw new Error(`Browser bridge did not start. See ${LOG_PATH}`);
}

async function status() {
  const config = readConfig({ create: true });
  const result = await health(config.port);
  if (!result) {
    console.log("Browser bridge is stopped");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function stop() {
  const config = readConfig({ create: true });
  const result = await health(config.port);
  if (!result) {
    rmSync(PID_PATH, { force: true });
    console.log("Browser bridge is already stopped");
    return;
  }
  try {
    process.kill(result.pid, "SIGTERM");
  } catch (error) {
    throw new Error(`Could not stop browser bridge pid ${result.pid}: ${error.message}`);
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    if (!(await health(config.port))) {
      console.log("Browser bridge stopped");
      return;
    }
  }
  throw new Error(`Browser bridge pid ${result.pid} did not stop`);
}

async function serve() {
  const config = readConfig({ create: true });
  let extension = null;
  let sdk = null;
  const connectedAt = new Map();

  const httpServer = createServer((request, response) => {
    if (request.url !== "/status") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      pid: process.pid,
      port: config.port,
      extensionConnected: extension?.readyState === WebSocket.OPEN,
      sdkConnected: sdk?.readyState === WebSocket.OPEN,
      uptimeSeconds: Math.round(process.uptime()),
    }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  httpServer.on("upgrade", (request, socket, head) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.bridgeOrigin = request.headers.origin;
      webSocket.bridgeRole = null;
      wss.emit("connection", webSocket, request);
    });
  });

  wss.on("connection", (socket) => {
    const helloTimer = setTimeout(() => socket.close(1008, "hello timeout"), 3_000);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "text messages only");
        return;
      }
      const raw = data.toString();
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        socket.close(1007, "invalid JSON");
        return;
      }

      if (!socket.bridgeRole) {
        if (
          message?.type !== "hello" ||
          message.protocolVersion !== 1 ||
          !safeTokenEquals(message.token, config.token) ||
          !["extension", "sdk"].includes(message.role)
        ) {
          send(socket, { type: "hello", ok: false, error: "Invalid bridge hello" });
          socket.close(1008, "invalid hello");
          return;
        }
        if (message.role === "extension") {
          const expectedOrigin = config.extensionId ? `chrome-extension://${config.extensionId}` : undefined;
          if (
            typeof socket.bridgeOrigin !== "string" ||
            !socket.bridgeOrigin.startsWith("chrome-extension://") ||
            (expectedOrigin && socket.bridgeOrigin !== expectedOrigin)
          ) {
            send(socket, { type: "hello", ok: false, error: "Unexpected extension origin" });
            socket.close(1008, "unexpected origin");
            return;
          }
          extension?.close(1012, "replaced by a new extension connection");
          extension = socket;
          socket.bridgeRole = "extension";
          send(socket, { type: "hello", ok: true, protocolVersion: 1 });
          send(sdk, { type: "status", extensionConnected: true });
        } else {
          if (socket.bridgeOrigin) {
            send(socket, { type: "hello", ok: false, error: "SDK clients must not send a browser Origin" });
            socket.close(1008, "unexpected SDK origin");
            return;
          }
          if (sdk?.readyState === WebSocket.OPEN) {
            send(socket, { type: "hello", ok: false, error: "Another SDK client is already connected" });
            socket.close(1013, "SDK busy");
            return;
          }
          sdk = socket;
          socket.bridgeRole = "sdk";
          send(socket, {
            type: "hello",
            ok: true,
            protocolVersion: 1,
            extensionConnected: extension?.readyState === WebSocket.OPEN,
          });
        }
        connectedAt.set(socket, Date.now());
        clearTimeout(helloTimer);
        return;
      }

      if (socket.bridgeRole === "extension") {
        if (message?.type === "keepalive") {
          send(socket, { type: "keepalive", ok: true });
          return;
        }
        const isCdpResponse = Number.isInteger(message?.id) && ("result" in message || "error" in message);
        const isCdpEvent = typeof message?.method === "string" && message.id === undefined;
        if (isCdpResponse || isCdpEvent) send(sdk, raw);
        return;
      }

      if (socket.bridgeRole === "sdk") {
        const isCdpRequest = Number.isInteger(message?.id) && typeof message?.method === "string" && message.params !== null;
        if (!isCdpRequest) return;
        if (extension?.readyState !== WebSocket.OPEN) {
          send(socket, { id: message.id, error: { code: -32001, message: "Chrome extension is not connected" } });
          return;
        }
        send(extension, raw);
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      connectedAt.delete(socket);
      if (socket === extension) {
        extension = null;
        send(sdk, { type: "status", extensionConnected: false });
      }
      if (socket === sdk) {
        sdk = null;
        send(extension, { type: "sdk-disconnected" });
      }
    });
  });

  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(config.port, HOST, resolvePromise);
  });
  writeFileSync(PID_PATH, `${process.pid}\n`, { mode: 0o600 });
  console.log(`[${new Date().toISOString()}] bridge pid=${process.pid} listening on ws://${HOST}:${config.port}`);

  const shutdown = () => {
    extension?.close(1001, "bridge stopping");
    sdk?.close(1001, "bridge stopping");
    wss.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", () => {
    try {
      if (readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) rmSync(PID_PATH, { force: true });
    } catch {}
  });
}

const command = process.argv[2] ?? "status";
try {
  if (command === "setup") await setup();
  else if (command === "start") await start();
  else if (command === "serve") await serve();
  else if (command === "status") await status();
  else if (command === "stop") await stop();
  else throw new Error("Usage: bridge.mjs setup|start|serve|status|stop");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import { Browser, connectBrowser, Locator, Page, type ConnectBrowserOptions } from "../sdk/index.ts";

interface ExecuteRequest {
  type: "execute";
  id: number;
  code: string;
  timeoutMs: number;
}

interface ShutdownRequest {
  type: "shutdown";
}

type WorkerRequest = ExecuteRequest | ShutdownRequest;

export type OutputItem = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Scripts are written next to this skill's node_modules so bare specifiers resolve from its dependencies.
const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".runtime");

let browser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;
let browserOptions: ConnectBrowserOptions = {};
let scriptCount = 0;

async function currentBrowser(timeoutMs: number): Promise<Browser> {
  if (browser) return browser;
  const pending = browserPromise ?? connectBrowser({ ...browserOptions, timeoutMs });
  browserPromise = pending;
  try {
    browser = await pending;
    return browser;
  } finally {
    if (browserPromise === pending) browserPromise = undefined;
  }
}

async function resetBrowser(options: ConnectBrowserOptions, timeoutMs: number): Promise<Browser> {
  const pending = browserPromise;
  if (pending) {
    try {
      await pending;
    } catch {
      // A failed default connection should not prevent switching backends.
    }
  }

  const previous = browser;
  browser = undefined;
  browserPromise = undefined;
  browserOptions = { ...options };
  await previous?.close();
  return currentBrowser(timeoutMs);
}

function browserFacade(timeoutMs: number): Browser {
  return new Proxy({} as Browser, {
    get(_target, property) {
      if (property === "backend") {
        if (!browser) throw new Error("Browser is not connected; call tabs(), page(), or resetBrowser() first");
        return browser.backend;
      }
      if (property === "then") return undefined;
      return async (...args: unknown[]) => {
        const active = await currentBrowser(timeoutMs);
        const value = Reflect.get(active, property, active) as unknown;
        if (typeof value !== "function") return value;
        return Reflect.apply(value, active, args);
      };
    },
  });
}

function sniffMimeType(bytes: Buffer): string {
  if (bytes.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("image() accepts PNG, JPEG, GIF, or WebP data");
}

/** Runs `code` as an ES module with `globals` installed, collecting what it passes to `text()` and `image()`. */
export async function runScript(code: string, globals: Record<string, unknown> = {}): Promise<OutputItem[]> {
  const output: OutputItem[] = [];
  const text = (value: unknown): void => {
    output.push({ type: "text", text: typeof value === "string" ? value : (JSON.stringify(value) ?? String(value)) });
  };
  const image = (source: Uint8Array | string): void => {
    const bytes = typeof source === "string" ? readFileSync(resolve(process.cwd(), source)) : Buffer.from(source);
    output.push({ type: "image", data: bytes.toString("base64"), mimeType: sniffMimeType(bytes) });
  };
  Object.assign(globalThis, globals, { text, image });

  mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = join(SCRIPT_DIR, `script-${process.pid}-${Date.now()}-${++scriptCount}.mjs`);
  writeFileSync(file, code);
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    // A module that fails to parse rejects without a location; `node --check` prints one.
    if (error instanceof SyntaxError && !error.stack?.includes(file)) {
      let location = "";
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      } catch (check) {
        location = String((check as { stderr?: Buffer }).stderr ?? "").split("\n\n")[0].replace(file, "line");
      }
      const hint = error.message.includes("Illegal return") ? " (pass results to text() instead)" : "";
      error.stack = `SyntaxError: ${error.message}${hint}\n${location}`.trim();
    }
    throw error;
  } finally {
    rmSync(file, { force: true });
  }
  return output;
}

if (parentPort) {
  const port = parentPort;

  port.on("message", async (request: WorkerRequest) => {
    if (request.type === "shutdown") {
      try {
        await browser?.close();
      } finally {
        port.close();
      }
      return;
    }

    try {
      const output = await runScript(request.code, {
        browser: browserFacade(request.timeoutMs),
        tabs: async () => (await currentBrowser(request.timeoutMs)).tabs(),
        page: async (targetIdOrPrefix: string) => (await currentBrowser(request.timeoutMs)).page(targetIdOrPrefix),
        resetBrowser: (options: ConnectBrowserOptions) => resetBrowser(options, request.timeoutMs),
        connectBrowser,
        Browser,
        Page,
        Locator,
      });
      port.postMessage({ type: "result", id: request.id, output });
    } catch (error) {
      port.postMessage({ type: "error", id: request.id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  });

  port.postMessage({ type: "ready" });
}

import { parse } from "acorn";
import { transform } from "esbuild";
import { parentPort } from "node:worker_threads";
import { inspect } from "node:util";
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

type ProgramNode = {
  body: Array<{
    type: string;
    start: number;
    end: number;
    expression?: { start: number; end: number };
  }>;
};

if (!parentPort) throw new Error("Browser code worker requires a parent port");
const port = parentPort;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

let browser: Browser | undefined;
let browserPromise: Promise<Browser> | undefined;
let browserOptions: ConnectBrowserOptions = {};

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

async function compile(code: string): Promise<(...args: unknown[]) => Promise<unknown>> {
  const transformed = await transform(code, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcefile: "browser_code.ts",
  });
  const javascript = transformed.code;
  const program = parse(javascript, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
  }) as unknown as ProgramNode;
  const last = program.body.at(-1);
  const body = last?.type === "ExpressionStatement" && last.expression
    ? `${javascript.slice(0, last.start)}return (${javascript.slice(last.expression.start, last.expression.end)});${javascript.slice(last.end)}`
    : `${javascript}\nreturn undefined;`;
  return new AsyncFunction("browser", "tabs", "page", "resetBrowser", "connectBrowser", "Browser", "Page", "Locator", `"use strict";\n${body}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

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
    const execute = await compile(request.code);
    const facade = browserFacade(request.timeoutMs);
    const tabs = async () => (await currentBrowser(request.timeoutMs)).tabs();
    const page = async (targetIdOrPrefix: string) => (await currentBrowser(request.timeoutMs)).page(targetIdOrPrefix);
    const reset = (options: ConnectBrowserOptions) => resetBrowser(options, request.timeoutMs);
    const value = await execute(facade, tabs, page, reset, connectBrowser, Browser, Page, Locator);
    const output = inspect(value, {
      depth: 6,
      maxArrayLength: 100,
      maxStringLength: 20_000,
      breakLength: 120,
    });
    port.postMessage({ type: "result", id: request.id, output });
  } catch (error) {
    port.postMessage({ type: "error", id: request.id, error: errorText(error) });
  }
});

port.postMessage({ type: "ready" });

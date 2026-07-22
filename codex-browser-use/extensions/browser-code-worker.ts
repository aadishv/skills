import { parse } from "acorn";
import { transform } from "esbuild";
import { parentPort } from "node:worker_threads";
import { inspect } from "node:util";
import { Browser, connectBrowser, Locator, Page } from "../sdk/index.ts";

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
  return new AsyncFunction("browser", "tabs", "page", "connectBrowser", "Browser", "Page", "Locator", `"use strict";\n${body}`);
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
    browser ??= await connectBrowser({ timeoutMs: request.timeoutMs });
    const tabs = () => browser!.tabs();
    const page = (targetIdOrPrefix: string) => browser!.page(targetIdOrPrefix);
    const value = await execute(browser, tabs, page, connectBrowser, Browser, Page, Locator);
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

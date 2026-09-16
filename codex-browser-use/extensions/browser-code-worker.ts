import { parse } from "acorn";
import { transform } from "esbuild";
import { parentPort } from "node:worker_threads";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

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

/**
 * Dynamic import inside an AsyncFunction has no referring module, so bare and relative specifiers
 * both fail to resolve. Importing from here instead gives bare specifiers this package's
 * node_modules, while relative specifiers resolve against the user's working directory.
 */
function hostImport(specifier: string): Promise<unknown> {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return import(pathToFileURL(resolve(process.cwd(), specifier)).href);
  }
  return import(specifier);
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const candidate = node as AstNode;
  if (typeof candidate.type === "string") visit(candidate);
  for (const key of Object.keys(candidate)) {
    if (key !== "type") walk(candidate[key], visit);
  }
}

function importedKey(imported: AstNode): string {
  return imported.type === "Identifier" ? String(imported.name) : JSON.stringify(imported.value);
}

/** Rewrites one top-level `import` declaration into the equivalent awaited dynamic import. */
function hoistImport(node: AstNode): string {
  const source = JSON.stringify((node.source as AstNode).value);
  const specifiers = (node.specifiers ?? []) as AstNode[];
  if (specifiers.length === 0) return `await __import(${source});`;

  const namespace = specifiers.find((specifier) => specifier.type === "ImportNamespaceSpecifier");
  const fallback = specifiers.find((specifier) => specifier.type === "ImportDefaultSpecifier");
  if (namespace) {
    const binding = `const ${(namespace.local as AstNode).name} = await __import(${source});`;
    if (!fallback) return binding;
    return `${binding} const ${(fallback.local as AstNode).name} = ${(namespace.local as AstNode).name}.default;`;
  }

  const properties = specifiers.map((specifier) => {
    const local = (specifier.local as AstNode).name;
    if (specifier.type === "ImportDefaultSpecifier") return `default: ${local}`;
    return `${importedKey(specifier.imported as AstNode)}: ${local}`;
  });
  return `const { ${properties.join(", ")} } = await __import(${source});`;
}

function applyEdits(source: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start >= cursor) output += source.slice(cursor, edit.start);
    output += edit.text;
    cursor = Math.max(cursor, edit.end);
  }
  return output + source.slice(cursor);
}

export async function compile(code: string): Promise<(...args: unknown[]) => Promise<unknown>> {
  const transformed = await transform(code, {
    loader: "ts",
    format: "esm",
    target: "es2022",
    sourcefile: "browser_code.ts",
  });
  const javascript = transformed.code;
  const program = parse(javascript, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
  }) as unknown as { body: AstNode[] };

  const edits: Edit[] = [];
  const hoisted: string[] = [];
  for (const statement of program.body) {
    if (statement.type.startsWith("Export")) {
      throw new Error("export is not supported here; end with an expression to return a value");
    }
    if (statement.type !== "ImportDeclaration") continue;
    hoisted.push(hoistImport(statement));
    edits.push({ start: statement.start, end: statement.end, text: "" });
  }

  walk(program, (node) => {
    if (node.type === "ImportExpression") {
      edits.push({ start: node.start, end: node.start + "import".length, text: "__import" });
    } else if (node.type === "MetaProperty" && (node.meta as AstNode)?.name === "import") {
      throw new Error("import.meta is not available here; use process.cwd() for paths");
    }
  });

  // Wrap the whole statement rather than its expression node, which excludes any enclosing
  // parentheses and would otherwise turn `({ a: 1 });` into `(return ({ a: 1 }));`.
  const last = [...program.body].reverse().find((statement) => statement.type !== "ImportDeclaration");
  const returned = last?.type === "ExpressionStatement" ? last : undefined;
  if (returned) {
    const semicolon = javascript[returned.end - 1] === ";" ? returned.end - 1 : returned.end;
    edits.push({ start: returned.start, end: returned.start, text: "return (" });
    edits.push({ start: semicolon, end: returned.end, text: ");" });
  }

  const body = applyEdits(javascript, edits);
  const prelude = hoisted.length > 0 ? `${hoisted.join("\n")}\n` : "";
  const epilogue = returned ? "" : "\nreturn undefined;";
  return new AsyncFunction(
    "browser",
    "tabs",
    "page",
    "resetBrowser",
    "connectBrowser",
    "Browser",
    "Page",
    "Locator",
    "__import",
    `"use strict";\n${prelude}${body}${epilogue}`,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
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
      const execute = await compile(request.code);
      const facade = browserFacade(request.timeoutMs);
      const tabs = async () => (await currentBrowser(request.timeoutMs)).tabs();
      const page = async (targetIdOrPrefix: string) => (await currentBrowser(request.timeoutMs)).page(targetIdOrPrefix);
      const reset = (options: ConnectBrowserOptions) => resetBrowser(options, request.timeoutMs);
      const value = await execute(facade, tabs, page, reset, connectBrowser, Browser, Page, Locator, hostImport);
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
}

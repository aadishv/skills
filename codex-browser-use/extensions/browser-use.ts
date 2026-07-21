import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, keyHint, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import repl from "node:repl";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { inspect } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(EXTENSION_DIR, "..", "SKILL.md");
const SDK_PATH = resolve(EXTENSION_DIR, "..", "sdk", "index.ts");
const SKILL_COMMAND = "/skill:codex-browser-use";

class SerialQueue {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function evaluate(server: repl.REPLServer, code: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    server.eval(code, server.context, "browser_repl", (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function formatResult(value: unknown): string {
  const output = inspect(value, {
    depth: 6,
    maxArrayLength: 100,
    maxStringLength: 20_000,
    breakLength: 120,
  });
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  if (!truncation.truncated) return truncation.content;
  return `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

function isSkillRead(input: unknown, cwd: string): boolean {
  if (!input || typeof input !== "object") return false;
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string") return false;
  return resolve(cwd, path.replace(/^@/, "")) === SKILL_PATH;
}

function toolResultText(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((item): item is { type: "text"; text: string } =>
      !!item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export default function browserUseExtension(pi: ExtensionAPI) {
  let enabled = false;
  let server: repl.REPLServer | undefined;

  const activate = async (ctx: ExtensionContext) => {
    if (enabled) return;

    const replServer = repl.start({
      input: new PassThrough(),
      output: new PassThrough(),
      terminal: false,
      prompt: "",
      useGlobal: false,
    });

    try {
      // Import into the REPL itself, so these globals are available to evaluated code.
      const sdkUrl = pathToFileURL(SDK_PATH).href;
      await evaluate(replServer, `const { connectBrowser, Browser, Page, Locator } = await import(${JSON.stringify(sdkUrl)});`);
      await evaluate(replServer, `
        let browser;
        const getBrowser = async () => browser ??= await connectBrowser();
        const tabs = async () => (await getBrowser()).tabs();
        const page = async (targetIdOrPrefix) => (await getBrowser()).page(targetIdOrPrefix);
      `);
    } catch (error) {
      replServer.close();
      throw error;
    }

    const queue = new SerialQueue();
    pi.registerTool({
      name: "browser_repl",
      label: "Browser REPL",
      description: "Evaluate JavaScript in a persistent Node REPL with the browser-use SDK pre-imported and connected",
      promptSnippet: "Evaluate persistent JavaScript against the browser-use SDK",
      promptGuidelines: [
        "Use browser_repl for browser work after loading the codex-browser-use skill.",
        "Use browser_repl to list tabs and deliberately select a target before attaching, and ask before consequential browser actions.",
      ],
      parameters: Type.Object({
        code: Type.String({ description: "JavaScript to evaluate in the persistent browser REPL. Top-level await is supported." }),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        return queue.run(async () => {
          if (signal?.aborted) throw new Error("Browser REPL evaluation cancelled before it started");
          onUpdate?.({ content: [{ type: "text", text: "Evaluating browser REPL code..." }], details: {} });

          // Connect before evaluating the caller's code, so `browser` is always ready.
          await evaluate(replServer, "await getBrowser()");
          const value = await evaluate(replServer, params.code);
          return {
            content: [{ type: "text", text: formatResult(value) }],
            details: {},
          };
        });
      },
      renderResult(result, { expanded }, theme) {
        const output = toolResultText(result);
        const lines = output.split("\n");
        if (expanded || lines.length <= 10) return new Text(output, 0, 0);

        const remaining = lines.length - 10;
        const hint = keyHint("app.tools.expand", "to show all output");
        return new Text(
          `${lines.slice(0, 10).join("\n")}\n${theme.fg("dim", `… ${remaining} more line${remaining === 1 ? "" : "s"} (${hint})`)}`,
          0,
          0,
        );
      },
    });

    server = replServer;
    enabled = true;
    ctx.ui.setStatus("browser-use", "browser use enabled");
  };

  // Skill commands are expanded after the input event, so enable the REPL before
  // Pi sends the expanded SKILL.md content to the model.
  pi.on("input", async (event, ctx) => {
    if (event.text === SKILL_COMMAND || event.text.startsWith(`${SKILL_COMMAND} `)) {
      await activate(ctx);
    }
  });

  // Normal skill loading is an ordinary read. Once its successful result reaches
  // the model, browser_repl is registered for the following agent turn.
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled && event.toolName === "read" && !event.isError && isSkillRead(event.input, ctx.cwd)) {
      await activate(ctx);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("browser-use", undefined);
    if (!server) return;
    try {
      await evaluate(server, "browser && await browser.close()");
    } finally {
      server.close();
      server = undefined;
      enabled = false;
    }
  });
}

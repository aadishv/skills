import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, highlightCode, keyHint, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { OutputItem } from "./browser-code-worker.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = resolve(EXTENSION_DIR, "..", "SKILL.md");
const WORKER_PATH = resolve(EXTENSION_DIR, "browser-code-worker.ts");
const SKILL_COMMANDS = ["/skill:browser-use", "$browser-use"];
const CALL_PREVIEW_LINES = 10;
const TOOL_NAME = "execute_browser_code";

interface WorkerResult {
  type: "result" | "error";
  id: number;
  output?: OutputItem[];
  error?: string;
}

interface PendingRequest {
  resolve: (result: OutputItem[]) => void;
  reject: (error: Error) => void;
}

class BrowserCodeWorker {
  #worker?: Worker;
  #startingWorker?: Worker;
  #starting?: Promise<Worker>;
  #rejectStarting?: (error: Error) => void;
  #nextId = 0;
  #pending = new Map<number, PendingRequest>();

  async execute(code: string, timeoutMs: number, signal?: AbortSignal): Promise<OutputItem[]> {
    if (signal?.aborted) throw new Error("Browser code execution cancelled before it started");

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const operation = (async () => {
      const worker = await this.#getWorker();
      const id = ++this.#nextId;
      const result = new Promise<OutputItem[]>((resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
      });
      worker.postMessage({ type: "execute", id, code, timeoutMs });
      return result;
    })();
    const interruption = new Promise<never>((_, reject) => {
      const interrupt = (error: Error) => {
        reject(error);
        void this.#reset(error);
      };
      timer = setTimeout(
        () => interrupt(new Error(`Browser code execution timed out after ${timeoutMs / 1_000} seconds`)),
        timeoutMs,
      );
      if (signal) {
        abortHandler = () => interrupt(new Error("Browser code execution cancelled"));
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    try {
      return await Promise.race([operation, interruption]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    if (!worker) {
      if (this.#startingWorker) await this.#reset(new Error("Browser code worker shut down"));
      return;
    }
    worker.postMessage({ type: "shutdown" });
    await Promise.race([
      new Promise<void>((resolvePromise) => worker.once("exit", () => resolvePromise())),
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000)),
    ]);
    if (this.#worker === worker) await this.#reset(new Error("Browser code worker shut down"));
  }

  async #getWorker(): Promise<Worker> {
    if (this.#worker) return this.#worker;
    if (this.#starting) return this.#starting;

    // Scripts' console output is not part of the result; drain it so it never reaches the TUI.
    const worker = new Worker(pathToFileURL(WORKER_PATH), { stdout: true, stderr: true });
    worker.stdout.resume();
    worker.stderr.resume();
    this.#startingWorker = worker;
    this.#starting = new Promise<Worker>((resolvePromise, rejectPromise) => {
      this.#rejectStarting = rejectPromise;
      const onMessage = (message: { type?: unknown }) => {
        if (message?.type !== "ready" || this.#startingWorker !== worker) return;
        worker.off("error", onStartupError);
        this.#worker = worker;
        this.#startingWorker = undefined;
        this.#starting = undefined;
        this.#rejectStarting = undefined;
        resolvePromise(worker);
      };
      const onStartupError = (error: Error) => {
        worker.off("message", onMessage);
        if (this.#startingWorker === worker) {
          this.#startingWorker = undefined;
          this.#starting = undefined;
          this.#rejectStarting = undefined;
        }
        rejectPromise(error);
      };
      worker.on("message", onMessage);
      worker.once("error", onStartupError);
    });

    worker.on("message", (message: WorkerResult) => {
      if (message.type !== "result" && message.type !== "error") return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.type === "error") pending.reject(new Error(message.error ?? "Browser code execution failed"));
      else pending.resolve(message.output ?? []);
    });
    worker.on("error", (error) => void this.#reset(error, worker));
    worker.on("exit", (code) => {
      if (this.#worker === worker || this.#startingWorker === worker) {
        void this.#reset(new Error(`Browser code worker exited with code ${code}`), worker);
      }
    });
    return this.#starting;
  }

  async #reset(error: Error, expectedWorker?: Worker): Promise<void> {
    const worker = this.#worker ?? this.#startingWorker;
    if (expectedWorker && worker !== expectedWorker) return;
    this.#worker = undefined;
    this.#startingWorker = undefined;
    this.#starting = undefined;
    const rejectStarting = this.#rejectStarting;
    this.#rejectStarting = undefined;
    rejectStarting?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (worker) await worker.terminate();
  }
}

class SerialBrowserExecutor {
  readonly #worker = new BrowserCodeWorker();
  #tail = Promise.resolve();

  run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<OutputItem[]> {
    const deadline = Date.now() + timeoutMs;
    const execution = this.#tail.then(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Browser code execution timed out after ${timeoutMs / 1_000} seconds`);
      return this.#worker.execute(code, remaining, signal);
    });
    this.#tail = execution.then(() => undefined, () => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Browser code execution timed out after ${timeoutMs / 1_000} seconds`)),
        timeoutMs,
      );
    });
    return Promise.race([execution, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  close(): Promise<void> {
    return this.#worker.close();
  }
}

function formatResult(output: string): string {
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
  let executor: SerialBrowserExecutor | undefined;

  // Deferred tools stay undeclared until activated. Pi records the active set in the session, so
  // resumed sessions get the tool back on their own.
  pi.registerTool({
    name: TOOL_NAME,
    exposure: "deferred",
    label: "Execute Browser Code",
    description: "Execute call-scoped JavaScript with the browser-use SDK over a persistent browser connection",
    promptSnippet: "Execute call-scoped JavaScript against the browser-use SDK",
    promptGuidelines: [
      "Use execute_browser_code for browser work after loading the browser-use skill.",
      "Every execute_browser_code call must include a concise intent and an explicit timeout in seconds (10 seconds is the default).",
      "Use resetBrowser(options) to switch the persistent worker between extension and CDP backends when needed.",
      "Use execute_browser_code to list tabs and deliberately select a target before attaching, and ask before consequential browser actions.",
      "Inside execute_browser_code, only text(value) and image(bufferOrPath) reach the result. return, console.log, and final expressions are discarded.",
    ],
    parameters: Type.Object({
      intent: Type.String({ minLength: 1, description: "Concise summary of the action, shown in the TUI (for example, 'Check open tabs')." }),
      timeout: Type.Number({ minimum: 0.1, maximum: 300, default: 10, description: "Required end-to-end timeout in seconds. Use 10 unless the action needs a different limit." }),
      code: Type.String({ description: "JavaScript run as an ES module (top-level await and import work, top-level return does not). Only text(value) and image(bufferOrPath) are passed back." }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      executor ??= new SerialBrowserExecutor();
      const timeoutMs = (params.timeout ?? 10) * 1_000;
      onUpdate?.({ content: [{ type: "text", text: `${params.intent}` }], details: {} });
      const output = await executor.run(params.code, timeoutMs, signal);
      const content = output.map((item) => (item.type === "text" ? { ...item, text: formatResult(item.text) } : item));
      if (content.length === 0) content.push({ type: "text", text: "No output. Pass results to text() or image()." });
      return { content, details: {} };
    },
    renderCall(args, theme, { expanded }) {
      let text = theme.fg("toolTitle", theme.bold("execute_browser_code"));
      if (args.intent) text += theme.fg("muted", ` ${args.intent}`);

      const code = typeof args.code === "string" ? args.code.replace(/\s+$/, "") : "";
      if (code) {
        const lines = highlightCode(code, "javascript");
        const shown = expanded ? lines : lines.slice(0, CALL_PREVIEW_LINES);
        text += `\n\n${shown.join("\n")}`;
        const remaining = lines.length - shown.length;
        if (remaining > 0) {
          const hint = keyHint("app.tools.expand", "to expand");
          text += theme.fg("muted", `\n… ${remaining} more line${remaining === 1 ? "" : "s"} (${lines.length} total, `) + hint + theme.fg("muted", ")");
        }
      }
      return new Text(text, 0, 0);
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

  const isActive = () => pi.getActiveTools().includes(TOOL_NAME);

  const activate = (ctx: ExtensionContext) => {
    if (isActive()) return;
    pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
    ctx.ui.setStatus("browser-use", "browser use enabled");
  };

  pi.on("session_start", async (_event, ctx) => {
    if (isActive()) ctx.ui.setStatus("browser-use", "browser use enabled");
  });

  pi.on("input", async (event, ctx) => {
    if (SKILL_COMMANDS.some(cmd => event.text.includes(cmd))) activate(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "read" && !event.isError && isSkillRead(event.input, ctx.cwd)) activate(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("browser-use", undefined);
    await executor?.close();
    executor = undefined;
  });
}

#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import process from "node:process";

type OutputFormat = "png" | "jpeg" | "webp";
type Quality = "low" | "medium" | "high" | "auto";
type Background = "transparent" | "opaque" | "auto";
type Moderation = "low" | "auto";
type CodexResponsesBody = {
	model: string;
	instructions: string;
	input: Array<{
		type: "message";
		role: "user";
		content: Array<{ type: "input_text"; text: string }>;
	}>;
	tools: Array<{ type: "image_generation"; output_format: OutputFormat }>;
	tool_choice: "auto";
	parallel_tool_calls: boolean;
	store: boolean;
	stream: boolean;
	include: string[];
};

type ImageGenerationItem = {
	type?: string;
	id?: string;
	status?: string;
	revised_prompt?: string;
	result?: string;
};

type CodexResponsesEvent = {
	type?: string;
	item?: ImageGenerationItem;
};

const DEFAULT_API_BASE = "https://chatgpt.com/backend-api/codex";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_OUT_DIR = join(process.cwd(), ".pi", "generated_images");

function printHelp(): void {
	console.log(`Usage:
  bun scripts/image-gen.ts --prompt "a red fox in snowfall"

Auth:
  Reads Codex's stored ChatGPT auth from ~/.codex/auth.json.
  Sends a Responses request to the Codex backend, with image_generation enabled.

Flags:
  --prompt <text>                 Required.
  --model <id>                    Default: ${DEFAULT_MODEL}
  --n <count>                     Default: 1
  --size <WxH|auto>
  --quality <low|medium|high|auto>
  --background <transparent|opaque|auto>
  --output-format <png|jpeg|webp> Default: png
  --output-compression <0-100>
  --moderation <low|auto>
  --user <string>
  --api-base <url>                Default: ${DEFAULT_API_BASE}
  --out-dir <path>                Default: ${DEFAULT_OUT_DIR}
  --no-show                       Save only, don't render.
  --help
`);
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

function getString(value: string | boolean | undefined, name: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") fail(`--${name} expects a value`);
	return value;
}

function parseIntFlag(value: string | boolean | undefined, name: string): number | undefined {
	const raw = getString(value, name);
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) fail(`--${name} must be an integer`);
	return parsed;
}

function oneOf<T extends string>(
	value: string | undefined,
	name: string,
	allowed: readonly T[],
): T | undefined {
	if (value === undefined) return undefined;
	if ((allowed as readonly string[]).includes(value)) return value as T;
	fail(`--${name} must be one of: ${allowed.join(", ")}`);
}

function inferFormatFromContentType(contentType: string | null): OutputFormat {
	if (contentType?.includes("webp")) return "webp";
	if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return "jpeg";
	return "png";
}

function outputExtension(format: OutputFormat): string {
	return format === "jpeg" ? ".jpg" : `.${format}`;
}

function sanitizeStem(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "image";
}

type CodexAuthFile = {
	auth_mode?: string;
	tokens?: {
		access_token?: string;
		refresh_token?: string;
	};
};

async function getCodexAccessToken(): Promise<string> {
	const authPath = join(process.env.HOME ?? ".", ".codex", "auth.json");
	const raw = await readFile(authPath, "utf8").catch(() => fail(`failed to read Codex auth at ${authPath}`));
	const auth = JSON.parse(raw) as CodexAuthFile;
	if (auth.auth_mode !== "chatgpt") {
		fail(`unsupported Codex auth_mode: ${auth.auth_mode ?? "missing"}`);
	}
	const token = auth.tokens?.access_token;
	if (!token) {
		fail("no access_token found in ~/.codex/auth.json");
	}
	return token;
}

async function callCodexResponsesApi(apiBase: string, token: string, body: CodexResponsesBody): Promise<string> {
	const response = await fetch(`${apiBase.replace(/\/+$/, "")}/responses`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});

	const text = await response.text();
	if (!response.ok) {
		fail(`responses request failed (${response.status}): ${text}`);
	}

	return text;
}

function collectImageGenerationItems(sseText: string): ImageGenerationItem[] {
	const items: ImageGenerationItem[] = [];
	for (const frame of sseText.split(/\r?\n\r?\n/)) {
		const dataLines = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim());
		if (dataLines.length === 0) continue;
		const payload = dataLines.join("\n");
		if (!payload || payload === "[DONE]") continue;
		try {
			const event = JSON.parse(payload) as CodexResponsesEvent;
			if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
				items.push(event.item);
			}
		} catch {
			continue;
		}
	}
	return items;
}

async function saveB64Image(b64: string, filePath: string): Promise<void> {
	await writeFile(filePath, Buffer.from(b64, "base64"));
}

async function renderWithKittyProtocol(filePath: string, format: OutputFormat): Promise<void> {
	const bytes = Buffer.from(await Bun.file(filePath).arrayBuffer());
	const fmt = format === "png" ? 100 : format === "jpeg" ? 200 : 500;
	const payload = bytes.toString("base64");
	const chunkSize = 4096;

	for (let i = 0; i < payload.length; i += chunkSize) {
		const chunk = payload.slice(i, i + chunkSize);
		const more = i + chunkSize < payload.length ? 1 : 0;
		const prefix = i === 0 ? `\u001b_Ga=T,f=${fmt},m=${more};` : `\u001b_Gm=${more};`;
		process.stdout.write(prefix + chunk + "\u001b\\");
	}
	process.stdout.write("\n");
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		allowPositionals: true,
		options: {
			help: { type: "boolean" },
			prompt: { type: "string" },
			model: { type: "string" },
			n: { type: "string" },
			size: { type: "string" },
			quality: { type: "string" },
			background: { type: "string" },
			"output-format": { type: "string" },
			"output-compression": { type: "string" },
			moderation: { type: "string" },
			user: { type: "string" },
			"api-base": { type: "string" },
			"out-dir": { type: "string" },
			"no-show": { type: "boolean" },
		},
	});

	if (values.help) {
		printHelp();
		return;
	}

	const prompt = values.prompt ?? positionals.join(" ");
	if (!prompt) {
		printHelp();
		fail("missing prompt");
	}

	const model = values.model ?? DEFAULT_MODEL;
	const n = parseIntFlag(values.n, "n") ?? 1;
	if (n < 1 || n > 10) fail("--n must be between 1 and 10");

	const outputCompression = parseIntFlag(values["output-compression"], "output-compression");
	if (outputCompression !== undefined && (outputCompression < 0 || outputCompression > 100)) {
		fail("--output-compression must be between 0 and 100");
	}

	const quality = oneOf(values.quality, "quality", ["low", "medium", "high", "auto"] as const);
	const background = oneOf(values.background, "background", ["transparent", "opaque", "auto"] as const);
	const outputFormat = oneOf(values["output-format"], "output-format", ["png", "jpeg", "webp"] as const);
	const moderation = oneOf(values.moderation, "moderation", ["low", "auto"] as const);
	const format = outputFormat ?? "png";
	const generationSpec = [
		`prompt=${JSON.stringify(prompt)}`,
		`n=${n}`,
		values.size ? `size=${values.size}` : undefined,
		quality ? `quality=${quality}` : undefined,
		background ? `background=${background}` : undefined,
		`output_format=${format}`,
		outputCompression !== undefined ? `output_compression=${outputCompression}` : undefined,
		moderation ? `moderation=${moderation}` : undefined,
		values.user ? `user=${JSON.stringify(values.user)}` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const exactCallPrompt = [
		"Immediately call the image_generation tool.",
		"Use the user's prompt exactly as the image prompt.",
		`Requested generation args: ${generationSpec}.`,
		"Do not ask follow-up questions.",
		"Generate the requested image output now.",
	].join(" ");
	const body: CodexResponsesBody = {
		model,
		instructions: exactCallPrompt,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: prompt }],
			},
		],
		tools: [{ type: "image_generation", output_format: format }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		store: false,
		stream: true,
		include: [],
	};

	const token = await getCodexAccessToken();
	const apiBase = values["api-base"] ?? DEFAULT_API_BASE;
	const outDir = values["out-dir"] ?? DEFAULT_OUT_DIR;
	await mkdir(outDir, { recursive: true });

	const sseText = await callCodexResponsesApi(apiBase, token, body);
	const items = collectImageGenerationItems(sseText);
	if (items.length === 0) {
		console.error(sseText);
		fail("Codex backend returned no image_generation_call items");
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const stem = sanitizeStem(prompt);
	const savedPaths: string[] = [];

	for (const [index, item] of items.entries()) {
		if (!item.result) {
			fail(`image item ${index + 1} had no base64 result`);
		}
		const filePath = join(outDir, `${stamp}-${stem}-${index + 1}${outputExtension(format)}`);
		await saveB64Image(item.result, filePath);
		savedPaths.push(filePath);
	}

	for (const path of savedPaths) {
		console.log(path);
	}

	if (!values["no-show"]) {
		for (const path of savedPaths) {
			const ext = extname(path).toLowerCase();
			const format: OutputFormat = ext === ".jpg" || ext === ".jpeg" ? "jpeg" : ext === ".webp" ? "webp" : "png";
			await renderWithKittyProtocol(path, format);
		}
	}
}

await main();

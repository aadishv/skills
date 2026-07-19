import { build } from "esbuild";
import { config } from "dotenv";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { mdxToJs } from "satteri";
import { codeToHtml, type BundledLanguage } from "shiki";
import { structuredPatch } from "diff";
import { extractCodeBlocks } from "./extract-code-blocks";
import { extractGitDiffBlocks } from "./extract-git-diff-blocks";
import { resolveGitDiffBlocks, splitFrontmatter, type ResolvedDiffBlock } from "./resolve-git-diffs";

config({ path: new URL(".env.local", import.meta.url).pathname, quiet: true });

type Frontmatter = Record<string, unknown>;

function parseArgs(argv: string[]) {
  let inputPath: string | undefined;
  let upload = false;
  for (const arg of argv) {
    if (arg === "--upload") { upload = true; continue; }
    if (arg.startsWith("-") || inputPath) throw new Error("Usage: pnpm tsx cli.ts [--upload] path/to/file.md");
    inputPath = arg;
  }
  if (!inputPath) throw new Error("Usage: pnpm tsx cli.ts [--upload] path/to/file.md");
  return { inputPath, upload };
}

function parseFrontmatter(markdown: string): Frontmatter | null {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const parsed = load(match[1]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Frontmatter : null;
}

function summary(blocks: ResolvedDiffBlock[]) {
  const files = new Set<string>(); let additions = 0; let deletions = 0;
  for (const block of blocks) for (const file of block.files) {
    files.add(file.newFile.name || file.oldFile.name);
    const patch = structuredPatch(file.oldFile.name || "/dev/null", file.newFile.name || "/dev/null", file.oldFile.contents, file.newFile.contents, "", "", { context: Number.MAX_SAFE_INTEGER });
    for (const hunk of patch.hunks) for (const line of hunk.lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  return { fileCount: files.size, additions, deletions };
}

function escapeMdxJson(value: unknown) {
  // JSON is valid in an MDX expression; escaping these prevents HTML/script boundary surprises.
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function prehighlightCodeBlocks(markdown: string) {
  const blocks = extractCodeBlocks(markdown);
  const replacements = await Promise.all(blocks.map(async (block) => {
    try {
      const html = await codeToHtml(block.value, {
        lang: block.language as BundledLanguage,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: "light",
      });
      return `<div className="code-block" dangerouslySetInnerHTML={{ __html: ${escapeMdxJson(html)} }} />`;
    } catch {
      return `<div className="code-block" dangerouslySetInnerHTML={{ __html: ${escapeMdxJson(`<pre><code>${escapeHtml(block.value)}</code></pre>`)} }} />`;
    }
  }));

  let result = markdown;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    result = result.slice(0, block.start) + replacements[index] + result.slice(block.end);
  }
  return result;
}

async function toMdx(markdown: string, blocks: ResolvedDiffBlock[], frontmatter: Frontmatter | null) {
  let index = 0;
  const body = (await prehighlightCodeBlocks(markdown)).replace(/```git-diff[^\n]*\n[\s\S]*?\n```/g, () => {
    const data = escapeMdxJson(JSON.stringify(blocks[index]));
    return `\n\n<GitDiff data={${data}} blockIndex={${index++}} />\n\n`;
  });
  const card = frontmatter ? `<FrontmatterCard data={${escapeMdxJson(frontmatter)}} summary={${escapeMdxJson(summary(blocks))}} />\n\n` : "";
  // Leave YAML in place: Sätteri consumes it as frontmatter and excludes it from MDX output.
  return body.replace(/^(---\n[\s\S]*?\n---\n?)/, "$1" + card);
}

function standaloneHtml(title: string, bundledJs: string) {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title></head><body><div id="root"></div><script type="module" src="data:text/javascript;base64,${Buffer.from(bundledJs).toString("base64")}"></script></body></html>`;
}

async function publish(html: string, fallback: string) {
  const url = process.env.WALKTHROUGH_PUBLISH_URL;
  if (!url) {
    console.error("Publish skipped: missing WALKTHROUGH_PUBLISH_URL in scripts/.env.local");
    return fallback;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(process.env.WALKTHROUGH_PUBLISH_TOKEN
        ? { Authorization: `Bearer ${process.env.WALKTHROUGH_PUBLISH_TOKEN}` }
        : {}),
    },
    body: html,
  });
  if (!response.ok) {
    throw new Error(`Publish failed (${response.status}): ${await response.text()}`);
  }

  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || typeof (result as { url?: unknown }).url !== "string") {
    throw new Error("Publisher returned an invalid response.");
  }
  return (result as { url: string }).url;
}

const options = parseArgs(process.argv.slice(2));
const input = path.resolve(process.cwd(), options.inputPath);
const markdown = readFileSync(input, "utf8");
const sources = extractGitDiffBlocks(markdown);
const { context } = splitFrontmatter(markdown);
const blocks = await resolveGitDiffBlocks(markdown, sources.map(({ source }) => source), context);
const result = await mdxToJs(await toMdx(markdown, blocks, parseFrontmatter(markdown)), { features: { gfm: true, frontmatter: true, math: true }, jsxImportSource: "react" });

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, ".dist-mdx");
rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir, { recursive: true });
writeFileSync(path.join(outdir, "content.mjs"), result.code);
writeFileSync(path.join(outdir, "content-meta.mjs"), `export const hasDiffs = ${blocks.length > 0};\n`);
await build({ entryPoints: [path.join(root, "app.tsx")], outfile: path.join(outdir, "app.js"), bundle: true, platform: "browser", target: "esnext", format: "esm", splitting: false, sourcemap: false, minify: true, define: { "process.env.NODE_ENV": "\"production\"" } });
const html = standaloneHtml(path.basename(input), readFileSync(path.join(outdir, "app.js"), "utf8"));
const output = path.join("/tmp", `${randomUUID()}.html`); writeFileSync(output, html); rmSync(outdir, { recursive: true, force: true });
console.log(options.upload ? await publish(html, output) : output);

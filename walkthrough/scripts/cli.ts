import { del, list, put } from '@vercel/blob';
import { build } from 'esbuild';
import { config } from 'dotenv';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractGitDiffBlocks } from './extract-git-diff-blocks';
import { resolveGitDiffBlocks, splitFrontmatter } from './resolve-git-diffs';

const INITIAL_DATA_SCRIPT_ID = 'glimpse-initial-data';
const PLAN_PREFIX = 'shares/plan-';

config({ path: new URL('.env.local', import.meta.url).pathname, quiet: true });

type CliOptions = {
  inputPath: string;
  upload: boolean;
};

type UploadConfig = {
  token: string;
  storeId: string;
};

function escapeInlineScript(value: string) {
  return value.replaceAll('</script>', '<\\/script>');
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildStandaloneHtml(params: {
  title: string;
  bundledJs: string;
  initialDataJson: string;
}) {
  const { title, bundledJs, initialDataJson } = params;
  const embeddedInitialData = `<script id="${INITIAL_DATA_SCRIPT_ID}" type="application/json">${escapeInlineScript(initialDataJson)}</script>`;
  const bundledJsDataUrl = `data:text/javascript;base64,${Buffer.from(bundledJs).toString('base64')}`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css" />
  </head>
  <body>
    <div id="root"></div>
    ${embeddedInitialData}
    <script type="module" src="${bundledJsDataUrl}"></script>
  </body>
</html>`;
}

function parseArgs(argv: string[]): CliOptions {
  let inputPath: string | undefined;
  let upload = false;

  for (const arg of argv) {
    if (arg === '--upload') {
      upload = true;
      continue;
    }

    if (arg.startsWith('-')) {
      console.error(`Unknown flag: ${arg}`);
      console.error('Usage: pnpm cli [--upload] path/to/walkthrough.md');
      process.exit(1);
    }

    if (inputPath !== undefined) {
      console.error('Specify exactly one walkthrough path');
      console.error('Usage: pnpm cli [--upload] path/to/walkthrough.md');
      process.exit(1);
    }

    inputPath = arg;
  }

  if (inputPath === undefined) {
    console.error('Usage: pnpm cli [--upload] path/to/walkthrough.md');
    process.exit(1);
  }

  return { inputPath, upload };
}

function formatDateStamp(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear() % 100).padStart(2, '0');
  return `${month}${day}${year}`;
}

function loadUploadConfig(): UploadConfig | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const storeId = process.env.BLOB_STORE_ID;

  if (!token || !storeId) {
    return null;
  }

  return { token, storeId };
}

async function deleteOldUploadedPlans(config: UploadConfig, todayStamp: string) {
  const stalePathnames = new Set<string>();
  let cursor: string | undefined;

  do {
    const result = await list({
      prefix: PLAN_PREFIX,
      cursor,
      token: config.token,
      storeId: config.storeId,
    });

    for (const blob of result.blobs) {
      const match = /^shares\/plan-(\d{6})-[^.]+\.html$/u.exec(blob.pathname);
      if (!match) {
        continue;
      }

      if (match[1] !== todayStamp) {
        stalePathnames.add(blob.pathname);
      }
    }

    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor !== undefined);

  if (stalePathnames.size === 0) {
    return;
  }

  console.log(`Pruning ${stalePathnames.size} stale plans.`)
  await del([...stalePathnames], {
    token: config.token,
    storeId: config.storeId,
  });
}

async function maybeUploadHtml(html: string, fallbackOutputPath: string) {
  const config = loadUploadConfig();
  if (config === null) {
    console.error(
      'Upload skipped: missing BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID in scripts/.env.local',
    );
    return fallbackOutputPath;
  }

  const todayStamp = formatDateStamp(new Date());
  await deleteOldUploadedPlans(config, todayStamp);

  const id = `plan-${todayStamp}-${randomUUID()}`;
  await put(`shares/${id}.html`, html, {
    access: 'public',
    contentType: 'text/html; charset=utf-8',
    token: config.token,
    storeId: config.storeId,
  });

  return `https://aadishv.dev/s/${id}`;
}

const options = parseArgs(process.argv.slice(2));
const absoluteInputPath = path.resolve(options.inputPath);
const markdown = readFileSync(absoluteInputPath, 'utf8');
const gitDiffBlocks = extractGitDiffBlocks(markdown);
const { context } = splitFrontmatter(markdown);
const resolvedBlocks = await resolveGitDiffBlocks(
  markdown,
  gitDiffBlocks.map((block) => block.source),
  context,
);

const root = path.dirname(fileURLToPath(import.meta.url));
const outdirs = [path.join(root, '.dist'), path.join(root, '.dist-glimpse')];
for (const dir of outdirs) {
  rmSync(dir, { recursive: true, force: true });
}
const outdir = outdirs[0];
mkdirSync(outdir, { recursive: true });

const initialDataJson = JSON.stringify({
  markdown,
  gitDiffBlocks,
  resolvedBlocks,
});

await build({
  entryPoints: [path.join(root, 'app.tsx')],
  outfile: path.join(outdir, 'app.js'),
  bundle: true,
  platform: 'browser',
  target: 'esnext',
  format: 'esm',
  splitting: false,
  sourcemap: false,
});

const bundledJs = readFileSync(path.join(outdir, 'app.js'), 'utf8');
const html = buildStandaloneHtml({
  title: path.basename(absoluteInputPath),
  bundledJs,
  initialDataJson,
});

const outputPath = path.join('/tmp', `${randomUUID()}.html`);
writeFileSync(outputPath, html);

for (const dir of outdirs) {
  rmSync(dir, { recursive: true, force: true });
}

const finalOutput = options.upload
  ? await maybeUploadHtml(html, outputPath)
  : outputPath;

console.log(finalOutput);

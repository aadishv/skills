import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.WALKTHROUGH_PORT ?? 1820);
const host = process.env.WALKTHROUGH_HOST ?? execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).trim();
const publicUrl = (process.env.WALKTHROUGH_PUBLIC_URL ?? `http://${host}:${port}`).replace(/\/$/, "");
const storageDir = path.resolve(process.env.WALKTHROUGH_STORAGE_DIR ?? path.join(scriptDir, ".storage"));
const manifestPath = path.join(storageDir, "manifest.json");
const token = process.env.WALKTHROUGH_PUBLISH_TOKEN;
const maxBytes = Number(process.env.WALKTHROUGH_MAX_BYTES ?? 50 * 1024 * 1024);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

mkdirSync(storageDir, { recursive: true });

function loadManifest() {
  if (!existsSync(manifestPath)) return {};
  try {
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error(`Could not parse ${manifestPath}`);
  }
}

let manifest = loadManifest();
let manifestWrite = Promise.resolve();

function persistManifest() {
  const temporaryPath = path.join(storageDir, `.manifest-${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, manifestPath);
}

function updateManifest(id) {
  const operation = manifestWrite.then(() => {
    manifest[id] = { uploadedAt: new Date().toISOString() };
    persistManifest();
  });
  manifestWrite = operation.catch(() => {});
  return operation;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

async function readHtml(request) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > maxBytes) throw new Error("Payload is too large.");

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Payload is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  if (request.method === "POST" && pathname === "/") {
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: "Unauthorized." });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("text/html")) {
      send(response, 415, { error: "Expected text/html." });
      return;
    }

    try {
      const html = await readHtml(request);
      const id = randomUUID();
      const temporaryPath = path.join(storageDir, `.${id}.tmp`);
      const outputPath = path.join(storageDir, `${id}.html`);
      writeFileSync(temporaryPath, html, { flag: "wx" });
      renameSync(temporaryPath, outputPath);
      await updateManifest(id);
      send(response, 201, { url: `${publicUrl}/${id}` });
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
    }
    return;
  }

  if (request.method === "GET" && uuidPattern.test(pathname.slice(1)) && pathname.length === 37) {
    const outputPath = path.join(storageDir, `${pathname.slice(1)}.html`);
    if (!existsSync(outputPath)) {
      send(response, 404, { error: "Not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    createReadStream(outputPath).pipe(response);
    return;
  }

  send(response, request.method === "GET" || request.method === "POST" ? 404 : 405, { error: "Not found." });
});

server.listen(port, host, () => {
  console.log(`Walkthrough publisher listening at ${publicUrl}`);
  console.log(`Storage: ${storageDir}`);
});

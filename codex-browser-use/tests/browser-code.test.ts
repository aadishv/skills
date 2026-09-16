import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const { compile } = await import("../extensions/browser-code-worker.ts");

const hostImport = (specifier: string) =>
  specifier.startsWith("./") || specifier.startsWith("../")
    ? import(pathToFileURL(resolve(process.cwd(), specifier)).href)
    : import(specifier);

async function run(code: string): Promise<unknown> {
  const execute = await compile(code);
  return execute(...Array(8).fill(undefined), hostImport);
}

test("named imports bind", async () => {
  assert.equal(await run(`import { sep } from "node:path"; sep`), "/");
});

test("default and namespace imports bind", async () => {
  assert.equal(await run(`import path from "node:path"; path.sep`), "/");
  assert.equal(await run(`import * as path from "node:path"; path.sep`), "/");
  assert.equal(await run(`import path, * as ns from "node:path"; [path.sep, ns.sep].join("")`), "//");
});

test("renamed and side-effect imports work", async () => {
  assert.equal(await run(`import { sep as s } from "node:path"; s`), "/");
  assert.equal(await run(`import "node:path"; 1 + 1`), 2);
});

test("imports hoist above earlier statements", async () => {
  assert.equal(await run(`const first = sep; import { sep } from "node:path"; first`), "/");
});

test("bare specifiers resolve from this package", async () => {
  assert.equal(await run(`import { transform } from "esbuild"; typeof transform`), "function");
});

test("dynamic import still works", async () => {
  assert.equal(await run(`const { sep } = await import("node:path"); sep`), "/");
  assert.equal(await run(`import { sep } from "node:path"; const d = await import("node:path"); d.sep + sep`), "//");
});

test("trailing expression is returned, other statements are not", async () => {
  assert.equal(await run(`const a = 41; a + 1`), 42);
  assert.equal(await run(`const a = 41;`), undefined);
  assert.equal(await run(`import { sep } from "node:path";`), undefined);
});

test("parenthesized and semicolon-terminated final expressions are returned", async () => {
  assert.deepEqual(await run(`({ a: 1 })`), { a: 1 });
  assert.deepEqual(await run(`import { sep } from "node:path"; ({ sep });`), { sep: "/" });
  assert.equal(await run(`const a = 1; a + 1;`), 2);
});

test("typescript is stripped", async () => {
  assert.equal(await run(`const a: number = 1; interface Foo { b: string } a`), 1);
});

test("export and import.meta report clear errors", async () => {
  await assert.rejects(run(`export const a = 1;`), /export is not supported/);
  await assert.rejects(run(`import.meta.url`), /import\.meta is not available/);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveGitDiffBlocks } from './resolve-git-diffs';

function runGit(dir: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-resolver-'));
  runGit(dir, 'init', '-q');
  runGit(dir, 'config', 'user.email', 'test@example.com');
  runGit(dir, 'config', 'user.name', 'Walkthrough Test');
  return dir;
}

function commitAll(dir: string, message: string) {
  runGit(dir, 'add', '-A');
  runGit(dir, 'commit', '-qm', message);
  return runGit(dir, 'rev-parse', 'HEAD');
}

function numberedLines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
}

async function resolve(dir: string, range: string, block: string) {
  return resolveGitDiffBlocks('', [block], { directory: dir, range });
}

test('accepts multiline wildcard selectors and abbreviated commit IDs', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'file.txt'), 'before\n');
  commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'after\n');
  const commit = commitAll(dir, 'change');

  const blocks = await resolve(dir, commit.slice(0, 8), 'file.txt:\n  *');
  assert.equal(blocks[0].files.length, 1);
  assert.equal(blocks[0].files[0].newFile.contents, 'after\n');
});

test('supports triple-dot, staged, working-tree, and unstaged ranges', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\nsecond\nthird\n');
  const base = commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'committed\nsecond\nthird\n');
  const head = commitAll(dir, 'committed change');

  const triple = await resolve(dir, `${base}...${head}`, 'file.txt: *');
  assert.match(triple[0].files[0].newFile.contents, /^committed/m);

  fs.writeFileSync(path.join(dir, 'file.txt'), 'committed\nstaged\nthird\n');
  runGit(dir, 'add', 'file.txt');
  const staged = await resolve(dir, 'staged', 'file.txt: *');
  assert.match(staged[0].files[0].newFile.contents, /staged/);

  fs.writeFileSync(path.join(dir, 'file.txt'), 'committed\nstaged\nworking\n');
  const unstaged = await resolve(dir, 'unstaged', 'file.txt: *');
  assert.match(unstaged[0].files[0].oldFile.contents, /third/);
  assert.match(unstaged[0].files[0].newFile.contents, /working/);

  const workingTree = await resolve(dir, 'working-tree', 'file.txt: *');
  assert.match(workingTree[0].files[0].newFile.contents, /staged\nworking/);
});

test('coalesces duplicate selectors that identify the same native Git hunk', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'file.txt'), numberedLines(12));
  commitAll(dir, 'initial');
  const changed = numberedLines(12).replace('line 6', 'changed 6');
  fs.writeFileSync(path.join(dir, 'file.txt'), changed);
  const commit = commitAll(dir, 'change');
  const header = runGit(dir, 'diff', `${commit}^`, commit, '--', 'file.txt')
    .split('\n')
    .find((line) => line.startsWith('@@'))!;

  const blocks = await resolve(dir, commit, `file.txt:\n  ${header}\n  ${header}`);
  assert.equal(blocks[0].files.length, 1);
  assert.equal(blocks[0].files[0].newFile.contents, changed);
});

test('uses the sole remaining hunk for an inexact but valid selector', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'file.txt'), 'before\n');
  commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'after\n');
  const commit = commitAll(dir, 'change');

  const blocks = await resolve(dir, commit, 'file.txt:\n  @@ -900,2 +950,3 @@');
  assert.equal(blocks[0].files[0].newFile.contents, 'after\n');
});

test('does not guess between multiple plausible remaining hunks', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'file.txt'), numberedLines(30));
  commitAll(dir, 'initial');
  const changed = numberedLines(30).replace('line 2', 'changed 2').replace('line 29', 'changed 29');
  fs.writeFileSync(path.join(dir, 'file.txt'), changed);
  const commit = commitAll(dir, 'change');

  await assert.rejects(
    resolve(dir, commit, 'file.txt:\n  @@ -900,2 +950,3 @@'),
    /Missing hunk.*remaining hunks:/s,
  );
});

test('rejects walkthroughs that omit a hunk in a selected file', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'file.txt'), numberedLines(30));
  commitAll(dir, 'initial');
  const changed = numberedLines(30).replace('line 2', 'changed 2').replace('line 29', 'changed 29');
  fs.writeFileSync(path.join(dir, 'file.txt'), changed);
  const commit = commitAll(dir, 'change');
  const firstHeader = runGit(dir, 'diff', `${commit}^`, commit, '--', 'file.txt')
    .split('\n')
    .find((line) => line.startsWith('@@'))!;

  await assert.rejects(
    resolve(dir, commit, `file.txt:\n  ${firstHeader}`),
    /does not cover all changed hunks:\n- file\.txt:/,
  );
});

test('rejects walkthroughs that omit changed files or hunks', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'before a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'before b\n');
  commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'after a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'after b\n');
  const commit = commitAll(dir, 'change');

  await assert.rejects(resolve(dir, commit, 'a.txt: *'), /does not cover all changed hunks:\n- b\.txt:/);
});

test('renders explicitly selected untracked working-tree files', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'tracked\n');
  commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new file\n');

  const blocks = await resolve(dir, 'working-tree', 'untracked.txt: *');
  assert.equal(blocks[0].files[0].oldFile.contents, '');
  assert.equal(blocks[0].files[0].newFile.contents, 'new file\n');
});

test('ignores binary changes during text-hunk coverage validation', async () => {
  const dir = createRepo();
  const before = Buffer.alloc(1024, 0);
  const after = Buffer.from(before);
  after[500] = 9;
  fs.writeFileSync(path.join(dir, 'binary.dat'), before);
  commitAll(dir, 'initial');
  fs.writeFileSync(path.join(dir, 'binary.dat'), after);
  const commit = commitAll(dir, 'binary change');

  const blocks = await resolve(dir, commit, 'binary.dat: *');
  assert.equal(blocks[0].files.length, 0);
});

test('uses native Git rename paths when rendering a rename', async () => {
  const dir = createRepo();
  fs.writeFileSync(path.join(dir, 'old.txt'), numberedLines(20));
  commitAll(dir, 'initial');
  runGit(dir, 'mv', 'old.txt', 'new.txt');
  fs.appendFileSync(path.join(dir, 'new.txt'), 'added\n');
  const commit = commitAll(dir, 'rename');

  const blocks = await resolve(dir, commit, 'new.txt: *');
  assert.equal(blocks[0].files[0].oldFile.name, 'old.txt');
  assert.equal(blocks[0].files[0].newFile.name, 'new.txt');
  assert.match(blocks[0].files[0].newFile.contents, /added/);
});

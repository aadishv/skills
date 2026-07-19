import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import git from 'isomorphic-git';
import { load } from 'js-yaml';
import { applyPatch, structuredPatch } from 'diff';

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 100 * 1024 * 1024;

export type FrontmatterContext = {
  directory?: string;
  range?: string;
};

type RangeTarget =
  | { kind: 'ref'; ref: string }
  | { kind: 'stage' }
  | { kind: 'workdir' };

type ResolvedRange = {
  oldTarget: RangeTarget;
  newTarget: RangeTarget;
};

type GitDiffFileSelection = {
  path: string;
  mode: 'all' | 'hunks';
  hunkHeaders: string[];
};

type ParsedGitDiffBlock = {
  files: GitDiffFileSelection[];
};

type ParsedHunkHeader = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

export type ResolvedDiffFile = {
  oldFile: { name: string; contents: string };
  newFile: { name: string; contents: string };
};

export type ResolvedDiffBlock = {
  files: ResolvedDiffFile[];
};

type HunkState = {
  id: number;
  originalHeader: string;
  lines: string[];
  oldLines: number;
  newLines: number;
  currentOldStart: number;
  consumed: boolean;
};

type FileState = {
  path: string;
  oldPath: string;
  newPath: string;
  currentContent: string;
  hunks: HunkState[];
};

type NativePatch = {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: Array<{
    header: string;
    lines: string[];
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  }>;
};

export function splitFrontmatter(markdown: string): { context: FrontmatterContext; body: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { context: {}, body: markdown };
  }

  const parsed = load(match[1]);
  const context = parsed && typeof parsed === 'object' ? (parsed as FrontmatterContext) : {};
  return {
    context,
    body: markdown.slice(match[0].length),
  };
}

function parseGitDiffBlock(source: string): ParsedGitDiffBlock {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const files: GitDiffFileSelection[] = [];
  let current: GitDiffFileSelection | null = null;

  for (const line of lines) {
    const fileMatch = line.match(/^([^\s].*?):(?:\s*(\*))?\s*$/);
    if (fileMatch) {
      current = {
        path: fileMatch[1].trim(),
        mode: fileMatch[2] === '*' ? 'all' : 'hunks',
        hunkHeaders: [],
      };
      files.push(current);
      continue;
    }

    const trimmed = line.trim();
    // Accept both `path: *` and the natural multiline form:
    // path:
    //   *
    if (trimmed === '*' && current) {
      current.mode = 'all';
      continue;
    }
    if (trimmed.startsWith('@@') && current) {
      current.hunkHeaders.push(trimmed);
    }
  }

  return { files };
}

async function resolveCommitish(dir: string, ref: string): Promise<string> {
  const parentMatch = ref.match(/^(.*)\^(\d+)?$/);
  if (parentMatch) {
    const baseRef = await resolveCommitish(dir, parentMatch[1]);
    const parentIndex = parentMatch[2] ? Number(parentMatch[2]) - 1 : 0;
    const { commit } = await git.readCommit({ fs, dir, oid: baseRef });
    const parent = commit.parent.at(parentIndex);
    if (!parent) {
      throw new Error(`Commit ${parentMatch[1]} does not have parent ${parentIndex + 1}.`);
    }
    return parent;
  }

  try {
    return await git.resolveRef({ fs, dir, ref });
  } catch {
    // Native Git accepts abbreviated object IDs; isomorphic-git's resolveRef does not.
    if (/^[0-9a-f]{4,39}$/i.test(ref)) {
      try {
        return await git.expandOid({ fs, dir, oid: ref });
      } catch {
        // Let the eventual object read report the unknown ref.
      }
    }
    return ref;
  }
}

async function getRangeTargets(dir: string, range: string): Promise<ResolvedRange> {
  const normalizedRange = range.trim();
  if (normalizedRange === 'staged') {
    return {
      oldTarget: { kind: 'ref', ref: await resolveCommitish(dir, 'HEAD') },
      newTarget: { kind: 'stage' },
    };
  }
  if (normalizedRange === 'working-tree' || normalizedRange === 'worktree') {
    return {
      oldTarget: { kind: 'ref', ref: await resolveCommitish(dir, 'HEAD') },
      newTarget: { kind: 'workdir' },
    };
  }
  if (normalizedRange === 'unstaged') {
    return {
      oldTarget: { kind: 'stage' },
      newTarget: { kind: 'workdir' },
    };
  }

  if (normalizedRange.includes('...')) {
    const [leftRef, rightRef] = normalizedRange.split('...', 2);
    if (!leftRef || !rightRef) {
      throw new Error(`Invalid git range: ${normalizedRange}`);
    }
    const left = await resolveCommitish(dir, leftRef);
    const right = await resolveCommitish(dir, rightRef);
    const mergeBases = await git.findMergeBase({ fs, dir, oids: [left, right] });
    const mergeBase = mergeBases.at(0);
    if (!mergeBase) {
      throw new Error(`Could not find a merge base for ${normalizedRange}.`);
    }
    return {
      oldTarget: { kind: 'ref', ref: mergeBase },
      newTarget: { kind: 'ref', ref: right },
    };
  }

  if (normalizedRange.includes('..')) {
    const [oldRef, newRef] = normalizedRange.split('..', 2);
    if (!oldRef || !newRef) {
      throw new Error(`Invalid git range: ${normalizedRange}`);
    }

    return {
      oldTarget: { kind: 'ref', ref: await resolveCommitish(dir, oldRef) },
      newTarget: { kind: 'ref', ref: await resolveCommitish(dir, newRef) },
    };
  }

  const newRef = await resolveCommitish(dir, normalizedRange);
  const { commit } = await git.readCommit({ fs, dir, oid: newRef });
  const parent = commit.parent.at(0);
  if (!parent) {
    throw new Error(`Commit ${normalizedRange} has no parent.`);
  }

  return {
    oldTarget: { kind: 'ref', ref: parent },
    newTarget: { kind: 'ref', ref: newRef },
  };
}

function gitDiffArgs(range: ResolvedRange, options: { filePath?: string; namesOnly?: boolean } = {}) {
  const args = [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-ext-diff',
    '--no-color',
    options.namesOnly ? '--name-only' : '--unified=3',
  ];
  if (options.namesOnly) args.push('-z');

  if (range.oldTarget.kind === 'ref' && range.newTarget.kind === 'ref') {
    args.push(range.oldTarget.ref, range.newTarget.ref);
  } else if (range.oldTarget.kind === 'ref' && range.newTarget.kind === 'stage') {
    args.push('--cached', range.oldTarget.ref);
  } else if (range.oldTarget.kind === 'ref' && range.newTarget.kind === 'workdir') {
    args.push(range.oldTarget.ref);
  } else if (range.oldTarget.kind === 'stage' && range.newTarget.kind === 'workdir') {
    // No refs: this is the index-to-working-tree diff.
  } else {
    throw new Error(`Unsupported resolved range: ${range.oldTarget.kind}..${range.newTarget.kind}`);
  }

  if (options.filePath) args.push('--', options.filePath);
  return args;
}

async function runNativeGitDiff(
  dir: string,
  range: ResolvedRange,
  options: { filePath?: string; namesOnly?: boolean } = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', gitDiffArgs(range, options), {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

async function listChangedFilePaths(dir: string, range: ResolvedRange): Promise<string[]> {
  const output = await runNativeGitDiff(dir, range, { namesOnly: true });
  return [...new Set(output.split('\0').filter(Boolean))];
}

function decodePatchPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '/dev/null') return null;
  return trimmed.replace(/^[ab]\//, '');
}

function parseHunkHeader(header: string): ParsedHunkHeader | null {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? 1),
  };
}

function parseNativePatch(source: string): NativePatch {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let binary = false;
  const hunks: NativePatch['hunks'] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const diffHeader = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (diffHeader) {
      oldPath = diffHeader[1];
      newPath = diffHeader[2];
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = decodePatchPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = decodePatchPath(line.slice(4));
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
      continue;
    }
    if (!line.startsWith('@@')) continue;

    const parsed = parseHunkHeader(line);
    if (!parsed) continue;
    const hunkLines: string[] = [];
    for (index += 1; index < lines.length; index++) {
      const hunkLine = lines[index];
      if (hunkLine.startsWith('@@') || hunkLine.startsWith('diff --git ')) {
        index -= 1;
        break;
      }
      // split() contributes one synthetic final empty line; it is not patch data.
      if (index === lines.length - 1 && hunkLine === '') break;
      hunkLines.push(hunkLine);
    }
    hunks.push({ header: line.trim(), lines: hunkLines, ...parsed });
  }

  return { oldPath, newPath, binary, hunks };
}

function parseNativePatches(source: string): NativePatch[] {
  return source
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map(parseNativePatch);
}

async function readFileAtRef(dir: string, ref: string, filePath: string): Promise<string | null> {
  const oid = await resolveCommitish(dir, ref);

  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: filePath });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

async function readBlobByOid(dir: string, oid: string): Promise<string> {
  const object = await git.readObject({ fs, dir, oid, format: 'content' });
  if (object.format !== 'content' || object.type !== 'blob') {
    throw new Error(`Expected ${oid} to resolve to a blob.`);
  }

  return new TextDecoder().decode(object.object);
}

function collectRequestedDirectoryPrefixes(filePaths: string[]): Set<string> {
  const prefixes = new Set<string>();

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let current = '';

    for (const part of parts.slice(0, -1)) {
      current = current ? `${current}/${part}` : part;
      prefixes.add(current);
    }
  }

  return prefixes;
}

async function readFilesFromStage(dir: string, filePaths: string[]): Promise<Map<string, string | null>> {
  const uniqueFilePaths = [...new Set(filePaths)];
  const requestedPaths = new Set(uniqueFilePaths);
  const requestedDirectoryPrefixes = collectRequestedDirectoryPrefixes(uniqueFilePaths);
  const stageFiles = new Map<string, string | null>(
    uniqueFilePaths.map((filePath) => [filePath, null] as const),
  );

  if (uniqueFilePaths.length === 0) {
    return stageFiles;
  }

  await git.walk({
    fs,
    dir,
    trees: [git.STAGE()],
    map: async (filepath, [stage]) => {
      if (!stage) {
        return undefined;
      }

      const type = await stage.type();
      if (type === 'tree') {
        if (filepath && filepath !== '.' && !requestedDirectoryPrefixes.has(filepath)) {
          return null;
        }
        return undefined;
      }

      if (type !== 'blob' || !requestedPaths.has(filepath)) {
        return undefined;
      }

      const oid = await stage.oid();
      if (!oid) {
        return undefined;
      }

      stageFiles.set(filepath, await readBlobByOid(dir, oid));
      return undefined;
    },
  });

  return stageFiles;
}

async function readFileAtTarget(
  dir: string,
  target: RangeTarget,
  filePath: string,
  stageFiles: Map<string, string | null> | null,
): Promise<string | null> {
  if (target.kind === 'ref') {
    return readFileAtRef(dir, target.ref, filePath);
  }
  if (target.kind === 'workdir') {
    const absolutePath = path.resolve(dir, filePath);
    const relativePath = path.relative(dir, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`File path escapes repository: ${filePath}`);
    }
    try {
      return await fs.promises.readFile(absolutePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  if (stageFiles?.has(filePath)) return stageFiles.get(filePath) ?? null;
  return (await readFilesFromStage(dir, [filePath])).get(filePath) ?? null;
}

function formatGitHunkHeader(oldStart: number, oldLines: number, newStart: number, newLines: number) {
  // `diff` represents zero-length sides with a one-based insertion point;
  // native patch headers represent them with the preceding zero-based line.
  if (oldLines === 0) oldStart -= 1;
  if (newLines === 0) newStart -= 1;

  const oldCount = oldLines === 1 ? '' : `,${oldLines}`;
  const newCount = newLines === 1 ? '' : `,${newLines}`;
  return `@@ -${oldStart}${oldCount} +${newStart}${newCount} @@`;
}

function scoreHunkHeaderMatch(requestedHeader: string, actualHeader: string): number {
  if (requestedHeader === actualHeader) {
    return 100;
  }

  const requested = parseHunkHeader(requestedHeader);
  const actual = parseHunkHeader(actualHeader);
  if (!requested || !actual) {
    return -1;
  }

  if (requested.newStart === actual.newStart && requested.newLines === actual.newLines) return 90;
  if (requested.oldStart === actual.oldStart && requested.oldLines === actual.oldLines) return 80;
  if (requested.oldStart === actual.oldStart && requested.newStart === actual.newStart) return 75;

  const requestedNewEnd = requested.newStart + requested.newLines;
  const actualNewEnd = actual.newStart + actual.newLines;
  if (requested.newStart >= actual.newStart && requestedNewEnd <= actualNewEnd) return 70;
  if (actual.newStart >= requested.newStart && actualNewEnd <= requestedNewEnd) return 65;

  const requestedOldEnd = requested.oldStart + requested.oldLines;
  const actualOldEnd = actual.oldStart + actual.oldLines;
  if (requested.oldStart >= actual.oldStart && requestedOldEnd <= actualOldEnd) return 60;
  if (actual.oldStart >= requested.oldStart && actualOldEnd <= requestedOldEnd) return 55;
  if (requested.newStart === actual.newStart) return 50;
  if (requested.oldStart === actual.oldStart) return 45;

  return -1;
}

function buildPatchFromHunks(
  filePath: string,
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>,
) {
  const headerLines = [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`];
  const hunkLines = hunks.flatMap((hunk) => [
    formatGitHunkHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines),
    ...hunk.lines,
  ]);
  return `${headerLines.join('\n')}\n${hunkLines.join('\n')}\n`;
}

async function createFileState(
  dir: string,
  range: ResolvedRange,
  filePath: string,
  stageFiles: Map<string, string | null> | null,
  nativePatch: NativePatch | undefined,
): Promise<FileState> {
  const patch = nativePatch ?? { oldPath: null, newPath: null, binary: false, hunks: [] };
  const oldPath = patch.oldPath ?? filePath;
  const newPath = patch.newPath ?? filePath;
  if (patch.binary) {
    return { path: filePath, oldPath, newPath, currentContent: '', hunks: [] };
  }
  const oldSource = patch.oldPath === null && patch.newPath !== null
    ? null
    : await readFileAtTarget(dir, range.oldTarget, oldPath, stageFiles);
  const newSource = patch.newPath === null && patch.oldPath !== null
    ? null
    : await readFileAtTarget(dir, range.newTarget, newPath, stageFiles);

  if (oldSource === null && newSource === null && patch.hunks.length === 0) {
    // Binary/submodule changes have no text hunks and therefore need no walkthrough selector.
    return { path: filePath, oldPath, newPath, currentContent: '', hunks: [] };
  }
  if (oldSource === null && newSource === null) {
    throw new Error(`Could not find ${filePath} in requested range.`);
  }

  let hunks = patch.hunks;
  if (hunks.length === 0 && (oldSource ?? '') !== (newSource ?? '')) {
    // Native `git diff` intentionally omits untracked files. If one is explicitly
    // selected for a working-tree range, synthesize its all-new patch as a fallback.
    const fallback = structuredPatch(
      oldSource === null ? '/dev/null' : `a/${oldPath}`,
      newSource === null ? '/dev/null' : `b/${newPath}`,
      oldSource ?? '',
      newSource ?? '',
      '',
      '',
      { context: 3 },
    );
    hunks = fallback.hunks.map((hunk) => ({
      header: formatGitHunkHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines),
      lines: [...hunk.lines],
      oldStart: hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart,
      newLines: hunk.newLines,
    }));
  }

  return {
    path: filePath,
    oldPath,
    newPath,
    currentContent: oldSource ?? '',
    hunks: hunks.map((hunk, index) => ({
      id: index,
      originalHeader: hunk.header,
      lines: [...hunk.lines],
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      // Keep the internal insertion point one-based so incremental application
      // remains compatible with the `diff` package.
      currentOldStart: hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart,
      consumed: false,
    })),
  };
}

function selectHunks(fileState: FileState, file: GitDiffFileSelection) {
  if (file.mode === 'all') {
    return fileState.hunks.filter((hunk) => !hunk.consumed);
  }

  const selected: HunkState[] = [];
  for (const requestedHeader of file.hunkHeaders) {
    let bestMatch: { hunk: HunkState; score: number } | undefined;

    for (const candidate of fileState.hunks) {
      const score = scoreHunkHeaderMatch(requestedHeader, candidate.originalHeader);
      if (score < 0) continue;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { hunk: candidate, score };
      }
    }

    if (!bestMatch) {
      const remaining = fileState.hunks.filter((hunk) => !hunk.consumed && !selected.includes(hunk));
      if (remaining.length === 1 && parseHunkHeader(requestedHeader)) {
        bestMatch = { hunk: remaining[0], score: 0 };
        console.warn(
          `Warning: treating ${requestedHeader} as ${remaining[0].originalHeader} for ${file.path}; it is the only remaining hunk.`,
        );
      } else {
        const candidates = remaining.map((hunk) => hunk.originalHeader).join(', ');
        throw new Error(
          `Missing hunk for ${file.path}: ${requestedHeader}` +
            (candidates ? ` (remaining hunks: ${candidates})` : ''),
        );
      }
    }

    if (bestMatch.hunk.consumed || selected.includes(bestMatch.hunk)) {
      console.warn(
        `Warning: skipping duplicate hunk ${requestedHeader} for ${file.path}; it maps to ${bestMatch.hunk.originalHeader}, which is already included.`,
      );
      continue;
    }

    selected.push(bestMatch.hunk);
  }

  return selected;
}

function applySelectedHunks(fileState: FileState, selected: HunkState[]) {
  const ordered = [...selected].sort((a, b) => a.currentOldStart - b.currentOldStart);
  const patch = buildPatchFromHunks(
    fileState.path,
    ordered.map((hunk, index) => {
      const priorDelta = ordered
        .slice(0, index)
        .reduce((sum, entry) => sum + (entry.newLines - entry.oldLines), 0);
      return {
        oldStart: hunk.currentOldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.currentOldStart + priorDelta,
        newLines: hunk.newLines,
        lines: hunk.lines,
      };
    }),
  );

  const nextContent = applyPatch(fileState.currentContent, patch);
  if (nextContent === false) {
    throw new Error(`Failed to apply selected hunks for ${fileState.path}.`);
  }

  for (const selectedHunk of ordered) {
    const delta = selectedHunk.newLines - selectedHunk.oldLines;
    selectedHunk.consumed = true;

    for (const remaining of fileState.hunks) {
      if (!remaining.consumed && remaining.currentOldStart > selectedHunk.currentOldStart) {
        remaining.currentOldStart += delta;
      }
    }
  }

  const previousContent = fileState.currentContent;
  fileState.currentContent = nextContent;
  return { previousContent, nextContent };
}

function formatUncoveredHunks(fileStates: Map<string, FileState>): string[] {
  const uncovered: string[] = [];
  const seen = new Set<FileState>();
  for (const state of fileStates.values()) {
    if (seen.has(state)) continue;
    seen.add(state);
    const headers = state.hunks.filter((hunk) => !hunk.consumed).map((hunk) => hunk.originalHeader);
    if (headers.length > 0) uncovered.push(`${state.newPath || state.oldPath}: ${headers.join(', ')}`);
  }
  return uncovered;
}

export async function resolveGitDiffBlocks(
  markdown: string,
  blocks: string[],
  context: FrontmatterContext = splitFrontmatter(markdown).context,
): Promise<ResolvedDiffBlock[]> {
  if (blocks.length === 0) {
    return [];
  }

  if (!context.directory || !context.range) {
    throw new Error('git-diff blocks require `directory` and `range` in YAML frontmatter.');
  }

  const dir = path.resolve(context.directory);
  const range = await getRangeTargets(dir, context.range);
  const parsedBlocks = blocks.map((source) => {
    const parsed = parseGitDiffBlock(source);
    if (parsed.files.length === 0) {
      throw new Error('git-diff block did not contain any file selections.');
    }
    return parsed;
  });
  const nativePatches = parseNativePatches(await runNativeGitDiff(dir, range));
  const nativePatchByPath = new Map<string, NativePatch>();
  for (const patch of nativePatches) {
    if (patch.oldPath) nativePatchByPath.set(patch.oldPath, patch);
    if (patch.newPath) nativePatchByPath.set(patch.newPath, patch);
  }
  const changedFilePaths = await listChangedFilePaths(dir, range);
  const requestedFilePaths = parsedBlocks.flatMap((block) => block.files.map((file) => file.path));
  const allFilePaths = [...new Set([...changedFilePaths, ...requestedFilePaths])];
  const stageFiles =
    range.oldTarget.kind === 'stage' || range.newTarget.kind === 'stage'
      ? await readFilesFromStage(dir, allFilePaths)
      : null;
  const fileStates = new Map<string, FileState>();
  const getFileState = async (filePath: string) => {
    let state = fileStates.get(filePath);
    if (state) return state;

    const nativePatch = nativePatchByPath.get(filePath);
    const aliases = [nativePatch?.oldPath, nativePatch?.newPath].filter(
      (candidate): candidate is string => Boolean(candidate),
    );
    state = aliases.map((alias) => fileStates.get(alias)).find(Boolean);
    if (!state) {
      state = await createFileState(dir, range, filePath, stageFiles, nativePatch);
    }
    fileStates.set(filePath, state);
    for (const alias of aliases) fileStates.set(alias, state);
    return state;
  };
  const resolvedBlocks: ResolvedDiffBlock[] = [];

  for (const parsed of parsedBlocks) {
    const files: ResolvedDiffFile[] = [];

    for (const file of parsed.files) {
      const fileState = await getFileState(file.path);
      const selected = selectHunks(fileState, file);
      if (selected.length === 0) continue;
      const { previousContent, nextContent } = applySelectedHunks(fileState, selected);

      files.push({
        oldFile: { name: fileState.oldPath, contents: previousContent },
        newFile: { name: fileState.newPath, contents: nextContent },
      });
    }

    resolvedBlocks.push({ files });
  }

  // Instantiate every changed text file so omitted files are caught too.
  for (const filePath of changedFilePaths) await getFileState(filePath);
  const uncovered = formatUncoveredHunks(fileStates);
  if (uncovered.length > 0) {
    throw new Error(`Walkthrough does not cover all changed hunks:\n${uncovered.map((line) => `- ${line}`).join('\n')}`);
  }

  return resolvedBlocks;
}

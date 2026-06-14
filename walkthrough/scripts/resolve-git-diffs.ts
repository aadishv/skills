import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { load } from 'js-yaml';
import { applyPatch, structuredPatch } from 'diff';

export type FrontmatterContext = {
  directory?: string;
  range?: string;
};

type RangeTarget =
  | { kind: 'ref'; ref: string }
  | { kind: 'stage' };

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
  currentContent: string;
  hunks: HunkState[];
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
    return ref;
  }
}

async function getRangeTargets(dir: string, range: string): Promise<ResolvedRange> {
  const normalizedRange = range.trim();
  if (normalizedRange === 'staged') {
    return {
      oldTarget: { kind: 'ref', ref: 'HEAD' },
      newTarget: { kind: 'stage' },
    };
  }

  if (normalizedRange.includes('...')) {
    throw new Error('Triple-dot ranges are not supported yet. Use `staged`, a single commit, or A..B.');
  }

  if (normalizedRange.includes('..')) {
    const [oldRef, newRef] = normalizedRange.split('..', 2);
    if (!oldRef || !newRef) {
      throw new Error(`Invalid git range: ${normalizedRange}`);
    }

    return {
      oldTarget: { kind: 'ref', ref: oldRef },
      newTarget: { kind: 'ref', ref: newRef },
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

  return stageFiles?.get(filePath) ?? null;
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

function formatGitHunkHeader(oldStart: number, oldLines: number, newStart: number, newLines: number) {
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

  const requestedNewEnd = requested.newStart + requested.newLines;
  const actualNewEnd = actual.newStart + actual.newLines;
  if (requested.newStart >= actual.newStart && requestedNewEnd <= actualNewEnd) return 70;

  const requestedOldEnd = requested.oldStart + requested.oldLines;
  const actualOldEnd = actual.oldStart + actual.oldLines;
  if (requested.oldStart >= actual.oldStart && requestedOldEnd <= actualOldEnd) return 60;

  return -1;
}

function buildPatchFromHunks(filePath: string, hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>) {
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
): Promise<FileState> {
  const oldSource = await readFileAtTarget(dir, range.oldTarget, filePath, stageFiles);
  const newSource = await readFileAtTarget(dir, range.newTarget, filePath, stageFiles);

  if (oldSource === null && newSource === null) {
    throw new Error(`Could not find ${filePath} in requested range.`);
  }

  const patch = structuredPatch(
    oldSource === null ? '/dev/null' : `a/${filePath}`,
    newSource === null ? '/dev/null' : `b/${filePath}`,
    oldSource ?? '',
    newSource ?? '',
    '',
    '',
    { context: 3 },
  );

  return {
    path: filePath,
    currentContent: oldSource ?? '',
    hunks: patch.hunks.map((hunk, index) => ({
      id: index,
      originalHeader: formatGitHunkHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines),
      lines: [...hunk.lines],
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      currentOldStart: hunk.oldStart,
      consumed: false,
    })),
  };
}

function selectHunks(fileState: FileState, file: GitDiffFileSelection) {
  if (file.mode === 'all') {
    const remaining = fileState.hunks.filter((hunk) => !hunk.consumed);
    if (remaining.length === 0) {
      throw new Error(`No remaining hunks for ${file.path}.`);
    }
    return remaining;
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
      throw new Error(`Missing hunk for ${file.path}: ${requestedHeader}`);
    }
    if (bestMatch.hunk.consumed) {
      throw new Error(
        `Hunk already consumed for ${file.path}: ${requestedHeader} matched ${bestMatch.hunk.originalHeader}`,
      );
    }
    if (selected.includes(bestMatch.hunk)) {
      throw new Error(
        `Requested hunk ${requestedHeader} for ${file.path} resolves to the same actual hunk ${bestMatch.hunk.originalHeader}. The walkthrough is likely stale; update the hunk headers or use '*' for the file.`,
      );
    }

    selected.push(bestMatch.hunk);
  }

  if (selected.length === 0) {
    throw new Error(`No hunks selected for ${file.path}.`);
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
  const stageFiles =
    range.newTarget.kind === 'stage'
      ? await readFilesFromStage(
          dir,
          parsedBlocks.flatMap((block) => block.files.map((file) => file.path)),
        )
      : null;
  const fileStates = new Map<string, FileState>();
  const resolvedBlocks: ResolvedDiffBlock[] = [];

  for (const parsed of parsedBlocks) {
    const files: ResolvedDiffFile[] = [];

    for (const file of parsed.files) {
      let fileState = fileStates.get(file.path);
      if (!fileState) {
        fileState = await createFileState(dir, range, file.path, stageFiles);
        fileStates.set(file.path, fileState);
      }

      const selected = selectHunks(fileState, file);
      const { previousContent, nextContent } = applySelectedHunks(fileState, selected);

      files.push({
        oldFile: { name: file.path, contents: previousContent },
        newFile: { name: file.path, contents: nextContent },
      });
    }

    resolvedBlocks.push({ files });
  }

  return resolvedBlocks;
}

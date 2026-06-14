import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export type GitDiffBlockSource = {
  source: string;
  offset: number;
};

export function extractGitDiffBlocks(markdown: string): GitDiffBlockSource[] {
  const tree = unified().use(remarkParse).parse(markdown);
  const blocks: GitDiffBlockSource[] = [];

  visit(tree, 'code', (node) => {
    if (node.lang === 'git-diff') {
      blocks.push({
        source: String(node.value ?? ''),
        offset: node.position?.start.offset ?? -1,
      });
    }
  });

  return blocks;
}

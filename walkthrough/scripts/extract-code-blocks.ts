import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

export type CodeBlockSource = {
  value: string;
  language: string;
  start: number;
  end: number;
};

export function extractCodeBlocks(markdown: string): CodeBlockSource[] {
  const tree = unified().use(remarkParse).parse(markdown);
  const blocks: CodeBlockSource[] = [];

  visit(tree, 'code', (node) => {
    if (node.lang === 'git-diff' || node.position?.start.offset === undefined || node.position.end.offset === undefined) {
      return;
    }

    blocks.push({
      value: String(node.value ?? ''),
      language: node.lang ?? 'text',
      start: node.position.start.offset,
      end: node.position.end.offset,
    });
  });

  return blocks;
}

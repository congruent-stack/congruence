import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const parser = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MarkdownNode[];
};
const separatedChildren = new Set(['root', 'blockquote', 'list', 'listItem', 'table', 'tableRow']);

function textContent(node: MarkdownNode): string {
  if (['html', 'definition', 'footnoteDefinition', 'footnoteReference'].includes(node.type))
    return '';
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break' || node.type === 'thematicBreak') return ' ';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textContent).join(separatedChildren.has(node.type) ? ' ' : '');
}

/** A text-only excerpt, so the collapsed activity button contains no nested controls. */
export function markdownPreview(markdown: string): string {
  return textContent(parser.parse(markdown)).replace(/\s+/g, ' ').trim();
}

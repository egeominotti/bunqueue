import { describe, expect, test } from 'bun:test';
import { rehypeTableLabels } from '../docs/src/lib/rehypeTableLabels';

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const el = (tagName: string, children: Node[] = []): Node => ({
  type: 'element',
  tagName,
  properties: {},
  children,
});
const text = (value: string): Node => ({ type: 'text', value });

function table(headers: string[], rows: string[][]): Node {
  return el('table', [
    el('thead', [
      el(
        'tr',
        headers.map((header) => el('th', [text(header)]))
      ),
    ]),
    el(
      'tbody',
      rows.map((row) =>
        el(
          'tr',
          row.map((cell) => el('td', [text(cell)]))
        )
      )
    ),
  ]);
}

const cells = (node: Node): Node[] =>
  node.tagName === 'td' ? [node] : (node.children ?? []).flatMap(cells);

describe('rehypeTableLabels', () => {
  test('labels each cell with its column and keeps table roles', () => {
    const tree = el('root', [table(['Variable', 'Default'], [['TCP_PORT', '6789']])]);
    rehypeTableLabels()(tree);

    const [labelled] = tree.children ?? [];
    expect(labelled.properties?.role).toBe('table');
    expect(cells(labelled).map((td) => [td.properties?.role, td.properties?.dataLabel])).toEqual([
      ['cell', 'Variable'],
      ['cell', 'Default'],
    ]);
  });

  test('leaves long index tables as tables: no labels, so phones scroll them', () => {
    const rows = Array.from({ length: 41 }, (_, i) => [`CMD${i}`, 'description']);
    const tree = el('root', [table(['Command', 'Description'], rows)]);
    rehypeTableLabels()(tree);

    const [long] = tree.children ?? [];
    expect(cells(long).some((td) => td.properties?.dataLabel !== undefined)).toBe(false);
  });

  test('skips tables without a header row', () => {
    const tree = el('root', [el('table', [el('tbody', [el('tr', [el('td', [text('x')])])])])]);
    rehypeTableLabels()(tree);

    expect(cells(tree)[0].properties?.dataLabel).toBeUndefined();
  });
});

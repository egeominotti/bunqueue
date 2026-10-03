/**
 * Rehype plugin for Markdown tables: copies each column header's text onto the cells
 * below it as `data-label`, and gives the table explicit ARIA roles.
 *
 * Below 600px, docs-tables.css lays every body row out as a card and prints the label
 * above each value, so a phone reader never scrolls sideways through a reference table.
 * Changing a table's `display` makes browsers drop its implicit table semantics; the
 * explicit roles keep rows, cells and column headers announced. Wider screens render
 * the table exactly as before: the attributes are inert there.
 *
 * Long index tables (more than MAX_CARD_ROWS rows, such as the TCP command summary) get
 * no labels: a hundred cards would be far longer to scroll than one table read sideways.
 */

const MAX_CARD_ROWS = 40;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const textOf = (node: HastNode): string =>
  node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

const childElements = (node: HastNode, tagName: string): HastNode[] =>
  (node.children ?? []).filter((child) => child.type === 'element' && child.tagName === tagName);

function setRole(node: HastNode, role: string): void {
  node.properties = { ...node.properties, role };
}

function labelTable(table: HastNode): void {
  const head = childElements(table, 'thead')[0];
  const headerRow = head ? childElements(head, 'tr')[0] : undefined;
  if (!head || !headerRow) return;
  const headers = childElements(headerRow, 'th');
  const labels = headers.map((th) => textOf(th).replace(/\s+/g, ' ').trim());

  setRole(table, 'table');
  setRole(head, 'rowgroup');
  setRole(headerRow, 'row');
  for (const th of headers) setRole(th, 'columnheader');

  const bodies = childElements(table, 'tbody');
  const rowCount = bodies.reduce((count, body) => count + childElements(body, 'tr').length, 0);
  const asCards = rowCount <= MAX_CARD_ROWS;
  for (const body of bodies) {
    setRole(body, 'rowgroup');
    for (const row of childElements(body, 'tr')) {
      setRole(row, 'row');
      childElements(row, 'td').forEach((td, index) => {
        td.properties = asCards
          ? { ...td.properties, role: 'cell', dataLabel: labels[index] ?? '' }
          : { ...td.properties, role: 'cell' };
      });
    }
  }
}

function visit(node: HastNode): void {
  if (node.type === 'element' && node.tagName === 'table') labelTable(node);
  for (const child of node.children ?? []) visit(child);
}

export function rehypeTableLabels() {
  return (tree: HastNode): void => {
    visit(tree);
  };
}

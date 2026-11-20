// Column widths: a short value is never cut while a number column keeps room only its header uses (review round,
// 'Table columns cut short words while number columns have spare room'). The header of a number gives way first:
// it is the same for every row and its full text is the tooltip; the value is what the row says.
import type {DataRow} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import type {Column} from '../../src/components/table/rows.ts';
import {columnBoxFrom, columnWidths, contentChars, contentWidth, floorWidth, isContentSized, measureColumns} from '../../src/components/table/widths.ts';

const col = (key: string, kind: Column['kind'], label = key): Column => ({key, label, kind, priority: 2});

function layout(columns: Column[], rows: DataRow[], width: number) {
  const needs = measureColumns(rows, columns);
  const boxes = columns.map(column => columnBoxFrom(column, needs));
  const widths = columnWidths(boxes, width);
  return {boxes, widths, by: Object.fromEntries(columns.map((column, i) => [column.key, widths[i]!])) as Record<string, number>};
}

// Widths of 12.5 px IBM Plex Sans 400 as Chromium draws them in the viewer (measured on the bundled font).
const DRAWN: Record<string, number> = {
  medium: 46.2, warning: 44.7, blocked: 44.4, illicit: 26.8, MMMMMMMM: 81.2, indexer: 41.8,
  'Lena Marquez': 78, 'Ines + reviewer': 86.8, 'Schema change': 88.6, 'Incident review': 87, 'ledger-workspace': 100.9,
  'Rosalind Okafor': 89, 'ledger-repo (requirements-docs.txt)': 202.7, 'ledger-conformance-tests': 146.8,
};
/** Whether `text` is drawn whole in a track `width` px wide (cells have no padding: the 12 px gap lies between tracks). */
const fits = (width: number, text: string) => width >= DRAWN[text]!;

describe('text widths follow the face the cells are drawn in', () => {
  it('never under the width the browser draws, and close to it', () => {
    for (const [text, drawn] of Object.entries(DRAWN)) {
      const estimate = contentWidth(text, col('t', 'text'));
      // before: 6.7 px a character, so 'medium' (46.2 px) was estimated at 40.2 and drawn as 'medi…'
      expect(estimate, text).toBeGreaterThanOrEqual(drawn - 0.3);
      expect(estimate, text).toBeLessThanOrEqual(drawn * 1.04 + 1);
    }
  });
});

describe('a short value is never cut while a number column has room it does not need', () => {
  // The shape of the history preset's 'Most changed files' at span 6 (616 px): before, OWNER held 12-character names
  // at its 64 px floor ('Lena Mar…') while AUTHORS (2-digit values) kept 62 px for its header and its sort glyph.
  const HISTORY: Column[] = [col('path', 'path', 'File'), col('commits', 'bar'), col('authors', 'num'), col('owner', 'author'), col('ownership', 'pct'), col('last', 'date')];
  const dirs = ['core', 'site', 'cli', 'docs', 'server', 'client', 'shared', 'tools', 'bench', 'specs'];
  const roles = ['handler', 'store', 'queue', 'loader', 'stream', 'parser', 'client', 'router', 'cache', 'writer'];
  // file names of 18 to 24 characters, each once: `…/message_handler.test.ts` is what tells a row apart
  const HISTORY_ROWS: DataRow[] = Array.from({length: 50}, (_, i) => ({
    path: `packages/${dirs[i % 10]}/src/${['message', 'session', 'render', 'schema', 'event'][i % 5]}_${roles[Math.floor(i / 5)]}${i % 2 ? '.test' : ''}.ts`,
    commits: 80 - i,
    authors: 4 + (i % 9),
    owner: i % 3 === 0 ? 'Bo Chen' : 'Lena Marquez',
    ownership: 30 + ((i * 7) % 40) + 0.5,
    last: '2026-11-0' + (1 + (i % 9)),
  }));

  it('the owner name is whole at 616 px; the number headers keep their text', () => {
    const {by} = layout(HISTORY, HISTORY_ROWS, 616);
    expect(fits(by.owner!, 'Lena Marquez')).toBe(true);
    // AUTHORS and OWNERSHIP keep their whole label (only the room kept for a sort glyph gives way first)
    expect(by.authors).toBeGreaterThanOrEqual(7 * 7.04);
    expect(by.ownership).toBeGreaterThanOrEqual(9 * 7.04);
  });

  // The shape of a hand-written table at 760 px (694 px plate): before, RISK drew 'medi…' and AUTHOR 'Ines + re…'
  // while PHASE (one digit) kept 48 px.
  const KINDS: Column[] = [col('kind', 'text'), col('built', 'text'), col('author', 'author'), col('risk', 'text'), col('phase', 'num'), col('question', 'text')];
  const KIND_ROWS: DataRow[] = [
    {kind: 'Release notes', built: 'from the merged pull requests and their labels', author: 'bot', risk: 'low', phase: 1, question: 'What changed for users since the last tag?'},
    {kind: 'Schema change', built: 'from the migration files: tables, columns, indexes', author: 'bot', risk: 'low', phase: 3, question: 'Which services read the renamed column?'},
    {kind: 'Incident review', built: 'timeline and decisions, at most 20 steps', author: 'Lena', risk: 'medium', phase: 4, question: 'What do we check first next time?'},
    {kind: 'Load test', built: 'targets, rates and limits from the bench config, source cited', author: 'Ines + reviewer', risk: 'high', phase: 5, question: 'Show the slowest path under load'},
  ];

  it('short words and names are whole at 694 px; the long sentences share what is left', () => {
    const {by} = layout(KINDS, KIND_ROWS, 694);
    expect(fits(by.risk!, 'medium')).toBe(true);
    expect(fits(by.author!, 'Ines + reviewer')).toBe(true);
    expect(fits(by.kind!, 'Schema change')).toBe(true);
    // the long columns still get most of the row
    expect(by.built! + by.question!).toBeGreaterThan(260);
  });

  it('when even that does not fit, a number header is cut before a name is, down to five letters and never under its values', () => {
    const columns = [col('owner', 'author'), col('contributors', 'num'), col('ownership', 'pct'), col('status', 'text')];
    const rows: DataRow[] = [
      {owner: 'Lena Marquez', contributors: 3, ownership: 41.5, status: 'blocked'},
      {owner: 'Bo Chen', contributors: 12, ownership: 9, status: 'warning'},
    ];
    const {boxes, by} = layout(columns, rows, 300);
    expect(fits(by.owner!, 'Lena Marquez')).toBe(true);
    expect(fits(by.status!, 'blocked') && fits(by.status!, 'warning')).toBe(true);
    // CONTRIBUTORS (12 letters) is cut, but keeps 'CONTR…' (six characters with the ellipsis) and the width of '12'
    expect(by.contributors).toBeLessThan(12 * 7.04);
    expect(by.contributors).toBeGreaterThanOrEqual(6 * 7.04);
    expect(by.ownership).toBeGreaterThanOrEqual(6 * 7.04);
    expect(floorWidth(boxes)).toBeLessThanOrEqual(300);
  });

  it('at every width, a short word or name is cut only when no number column has room to give', () => {
    const columns = [col('name', 'text'), col('state', 'text'), col('owner', 'author'), col('builds', 'num', 'Builds per day'), col('share', 'pct', 'Share of runs'), col('age', 'date', 'Last run')];
    const rows: DataRow[] = [
      {name: 'indexer', state: 'MMMMMMMM', owner: 'Lena Marquez', builds: 4, share: 12.5, age: '2026-11-18'},
      {name: 'illicit', state: 'warning', owner: 'Ines + reviewer', builds: 17, share: 3, age: '2026-11-02'},
      {name: 'blocked', state: 'medium', owner: 'Lena Marquez', builds: 9, share: 40, age: '2026-10-02'},
    ];
    const needs = measureColumns(rows, columns);
    const boxes = columns.map(column => columnBoxFrom(column, needs));
    // Room a number column does not need: wider than its widest value and the first five letters of its header and
    // the ellipsis after them.
    const spare = (column: Column, width: number) => {
      const values = Math.max(...rows.map(row => contentChars(row[column.key], column))) * 7.25 + 2;
      return width > Math.max(values, Math.min(column.label.length, 6) * 7.1) + 1;
    };
    const words = columns.filter(column => column.kind === 'text' || column.kind === 'author');
    let cutSomewhere = false;
    for (let width = 160; width <= 900; width += 7) {
      const widths = columnWidths(boxes, width);
      const slack = columns.some((column, i) => isContentSized(column) && spare(column, widths[i]!));
      const cut = words.some(column => {
        const i = columns.indexOf(column);
        return rows.some(row => widths[i]! < DRAWN[String(row[column.key])]!);
      });
      cutSomewhere ||= cut;
      expect(cut && slack, `at ${width} px`).toBe(false);
    }
    // the narrow widths do cut a word: the test looks at the case it is about
    expect(cutSomewhere).toBe(true);
  });
});

describe('a long name in a few rows is whole before a path shows more of its directories', () => {
  // With widths estimated at 6.7 px a character these names happened to be over-estimated and were whole; measured
  // truly, the outlier gave way while the path column grew past what its labels need (stack 'Packages' at 760 px,
  // hotspots 'Ranking' at 1440 px). A path gives way at its directories by design (D12); a name is just cut.
  it('the longest package name is whole beside a dir column (694 px)', () => {
    const columns = [col('name', 'text', 'Package'), col('ecosystem', 'chip'), col('version', 'code'), col('dir', 'path'), col('deps', 'num')];
    const names = ['ledger-core', 'ledger-site', 'ledger-cli', 'ledger-conformance-tests', 'ledger-web', 'ledger-agent', 'ledger-docs', 'ledger-repo (requirements-docs.txt)', 'ledger-bench', 'ledger-tools', 'ledger-schema', 'ledger-server'];
    const rows: DataRow[] = names.map((name, i) => ({
      name, ecosystem: i % 3 ? 'npm' : 'pypi', version: i % 2 ? '0.4.1' : null, deps: 3 + i,
      dir: i === 7 ? '' : `packages/${['web', 'agent', 'python'][i % 3]}/${name.replace(/^ledger-/, '')}_${['client', 'server'][i % 2]}/src`,
    }));
    const {boxes, by} = layout(columns, rows, 694);
    expect(fits(by.name!, 'ledger-repo (requirements-docs.txt)')).toBe(true);
    // the dir column still tells its rows apart
    expect(by.dir).toBeGreaterThanOrEqual(boxes[3]!.label!);
  });

  it('an owner of fifteen letters is whole beside a path column (722 px)', () => {
    const columns = [col('path', 'path', 'File'), col('commits', 'bar'), col('indent', 'heat', 'Indentation'), col('lines', 'num'), col('score', 'bar'), col('owner', 'author')];
    const rows: DataRow[] = Array.from({length: 30}, (_, i) => ({
      path: `services/${['billing', 'ledger', 'search', 'notify', 'gateway'][i % 5]}/internal/${['store', 'queue', 'router', 'worker', 'client', 'parser'][i % 6]}_${i}.go`,
      commits: 60 - i, indent: 4 + (i % 7), lines: 200 + i * 37, score: 900 - i * 20,
      owner: i === 4 ? 'Rosalind Okafor' : i % 2 ? 'Lena Marquez' : 'Bo Chen',
    }));
    const {by} = layout(columns, rows, 722);
    expect(fits(by.owner!, 'Rosalind Okafor')).toBe(true);
  });
});

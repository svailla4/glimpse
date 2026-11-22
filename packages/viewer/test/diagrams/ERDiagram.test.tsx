import {cleanSchema} from '@glimpse/catalog';
import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {VISIBLE_COLUMNS} from '../../src/components/diagrams/ERDiagram.tsx';
import {POSITIONS_KEY, configurePositionStorage} from '../../src/components/diagrams/flowkit/index.ts';
import {datasetFixture, errorDataset, pendingDataset, renderExpress} from '../harness.tsx';
import {click, drag, drawn, edgeOf, elk, fakeStorage, focus, inside, key, lineOf, nodeIds, nodeOf, pointsOf, positionOf, sizeOf, stageOf, viewOf, type FakeStorage} from './util.tsx';

const SCHEMA = {
  tables: [
    {name: 'users', file: 'src/auth/schema.sql#L1', columns: [{name: 'id', type: 'uuid', pk: true}, {name: 'email', type: 'text'}, {name: 'created_at', type: 'timestamptz'}]},
    {name: 'sessions', columns: [{name: 'id', type: 'uuid', pk: true}, {name: 'user_id', type: 'uuid', fk: true}, {name: 'expires_at', type: 'timestamptz', nullable: true}]},
  ],
  relations: [{from: 'sessions.user_id', to: 'users.id', card: 'n-1', label: 'belongs to'}],
};
const SPEC = `root=Page('T',[e])\ne=ERDiagram($/schema,title='Schema',size='l')`;
const ready = async (schema: unknown = SCHEMA, spec = SPEC) => {
  const view = renderExpress(spec, {data: {'/schema': schema}});
  await screen.findByRole('img', {name: /^Entity-relationship diagram/});
  await drawn(view, 'e');
  return view;
};
/** A route's point is within a pixel of (x, y): ELK puts a 1 px port just outside the table's side. */
const near = (point: readonly [number, number] | undefined, x: number, y: number) => {
  expect(point).toBeDefined();
  expect(Math.abs(point![0] - x)).toBeLessThanOrEqual(1);
  expect(Math.abs(point![1] - y)).toBeLessThanOrEqual(1);
};
const wide = (columns: number) => ({name: 'wide', columns: Array.from({length: columns}, (_, i) => ({name: `c${i}`, type: 'int', pk: i === 0}))});

let storage: FakeStorage;
beforeEach(() => {
  storage = fakeStorage();
  configurePositionStorage(storage);
});
afterEach(() => configurePositionStorage(undefined));

describe('ERDiagram', () => {
  it('draws tables with column rows, types and key glyphs', async () => {
    const view = await ready();
    expect(nodeIds(view, 'e')).toEqual(['users', 'sessions']);
    const sessions = nodeOf(view, 'e', 'sessions');
    const rows = [...sessions.querySelectorAll('[data-column]')];
    expect(rows.map(row => row.getAttribute('data-column'))).toEqual(['id', 'user_id', 'expires_at']);
    expect(rows.map(row => row.querySelector('[data-key]')?.getAttribute('data-key') ?? null)).toEqual(['pk', 'fk', null]);
    // a nullable column carries a question mark after its type
    expect([...rows[2]!.querySelectorAll('text')].map(t => t.textContent)).toEqual(['expires_at', 'timestamptz?']);
    expect(inside(sessions).getByText('sessions')).toBeTruthy();
    // header 26 px, rows 22 px
    expect(sessions.querySelector('rect')!.getAttribute('height')).toBe(String(26 + 3 * 22));
    expect(sessions.querySelector('[data-more]')).toBeNull();
    expect(stageOf(view, 'e').getAttribute('aria-label')).toBe('Entity-relationship diagram, 2 tables, 1 relation: users, sessions');
    expect(view.errors).toEqual([]);
  });

  // diagram-engine-in-worker: a relation is an ELK edge between two ports, one on the row of each column.
  it('joins tables at the related columns, through ports on their sides, with crow\'s-foot ends and a label', async () => {
    const view = await ready();
    const edge = edgeOf(view, 'e', 'sessions->users');
    const line = pointsOf(lineOf(edge));
    const sessions = positionOf(nodeOf(view, 'e', 'sessions'));
    const users = positionOf(nodeOf(view, 'e', 'users'));
    const sessionsWidth = sizeOf(nodeOf(view, 'e', 'sessions')).w;
    // from the user_id row (second) of sessions to the id row (first) of users
    near(line[0], sessions.x + sessionsWidth, sessions.y + 26 + 22 + 11);
    near(line.at(-1), users.x, users.y + 26 + 11);
    // what the worker was asked: fixed ports on the two tables, the edge between them
    const graph = elk.requests.at(-1)!.graph;
    const table = (name: string) => graph.children!.find(child => child.id === name)!;
    expect(table('sessions').layoutOptions).toEqual({'elk.portConstraints': 'FIXED_POS'});
    expect(table('sessions').ports).toEqual([expect.objectContaining({y: 26 + 22 + 11 - 0.5, layoutOptions: {'elk.port.side': 'EAST'}})]);
    expect(table('users').ports).toEqual([expect.objectContaining({y: 26 + 11 - 0.5, layoutOptions: {'elk.port.side': 'WEST'}})]);
    expect(graph.edges![0]!.sources).toEqual([table('sessions').ports![0]!.id]);
    // many at the sessions end (three prongs), one at the users end (a bar)
    const marks = edge.querySelectorAll('path')[2]!.getAttribute('d')!;
    expect(marks.match(/M/g)).toHaveLength(2);
    expect(marks).toMatch(/^M[-\d. ]+L[-\d. ]+L[-\d. ]+M[-\d. ]+L[-\d. ]+$/);
    expect(view.cell('e').querySelector('[data-edge-label]')!.textContent).toBe('belongs to');
  });

  it.each([
    ['1-1', 2, 2],
    ['1-n', 2, 3],
    ['n-n', 3, 3],
  ])('draws cardinality %s', async (card, startPoints, endPoints) => {
    const view = await ready({...SCHEMA, relations: [{from: 'sessions', to: 'users', card}]});
    const marks = edgeOf(view, 'e', 'sessions->users').querySelectorAll('path')[2]!.getAttribute('d')!.split('M').filter(Boolean);
    expect(marks.map(mark => mark.split('L').length)).toEqual([startPoints, endPoints]);
  });

  it('draws a plain arrow for a relation without cardinality, between table centres', async () => {
    const view = await ready({...SCHEMA, relations: [{from: 'sessions', to: 'users'}]});
    const edge = edgeOf(view, 'e', 'sessions->users');
    expect(edge.querySelectorAll('path')[2]!.getAttribute('d')!.match(/M/g)).toHaveLength(1);
    const sessions = positionOf(nodeOf(view, 'e', 'sessions'));
    expect(pointsOf(lineOf(edge))[0]![1]).toBeCloseTo(sessions.y + (26 + 3 * 22) / 2, 0);
  });

  it('folds a table over 12 columns and unfolds it on a click or Shift+Enter', async () => {
    const view = await ready({tables: [wide(20), {name: 'other', columns: [{name: 'wide_id', fk: true}]}], relations: [{from: 'other.wide_id', to: 'wide.c17', card: 'n-1'}]});
    const table = () => nodeOf(view, 'e', 'wide');
    expect(table().querySelectorAll('[data-column]')).toHaveLength(VISIBLE_COLUMNS);
    expect(table().querySelector('[data-more]')!.textContent).toBe('+ 8 more');
    // a relation to a folded column attaches to the fold row
    const end = () => pointsOf(lineOf(edgeOf(view, 'e', 'other->wide'))).at(-1)![1] - positionOf(table()).y;
    expect(end()).toBeCloseTo(26 + 12 * 22 + 11, 0);

    click(table().querySelector('[data-more] rect')!);
    await waitFor(() => expect(table().querySelectorAll('[data-column]')).toHaveLength(20));
    expect(table().querySelector('[data-more]')!.textContent).toBe('show fewer');
    await waitFor(() => expect(end()).toBeCloseTo(26 + 17 * 22 + 11, 0));
    // unfolding is not a selection
    expect(view.getData('/ui/sel')).toBeNull();

    const stage = stageOf(view, 'e');
    focus(stage);
    key(stage, 'Enter', {shiftKey: true});
    await waitFor(() => expect(table().querySelectorAll('[data-column]')).toHaveLength(VISIBLE_COLUMNS));
  });

  it('does not fold a table of exactly 12 columns', async () => {
    const view = await ready({tables: [wide(12)]});
    expect(nodeOf(view, 'e', 'wide').querySelectorAll('[data-column]')).toHaveLength(12);
    expect(nodeOf(view, 'e', 'wide').querySelector('[data-more]')).toBeNull();
  });

  // Decision links-through-node-ids: a table always selects itself as a node; its file adds the place (/ui/file follows it).
  it('selects a table as a node; one with a file carries that file', async () => {
    const view = await ready();
    click(nodeOf(view, 'e', 'users'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'users', label: 'users', path: 'src/auth/schema.sql', line: 1});
    expect(view.getData('/ui/file')).toBe('src/auth/schema.sql#L1');
    expect(nodeOf(view, 'e', 'users').hasAttribute('data-selected')).toBe(true);
    expect(edgeOf(view, 'e', 'sessions->users').hasAttribute('data-hot')).toBe(true);
    click(nodeOf(view, 'e', 'sessions'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'sessions', label: 'sessions'});
    expect(view.cell('e').querySelectorAll('[data-node][data-selected]')).toHaveLength(1);
  });

  it('shows drafting, redline and empty states', async () => {
    const view = renderExpress(SPEC);
    await waitFor(() => expect(view.cell('e').querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/schema', pendingDataset('repo.packages', 'reading migrations'));
    await waitFor(() => expect(view.cell('e').querySelector('[data-gl-state="drafting"]')!.textContent).toContain('reading migrations'));
    view.setData('/schema', errorDataset('repo.packages', 'E_TARGET', 'no schema found'));
    await waitFor(() => expect(view.cell('e').querySelector('[data-code="E_TARGET"]')!.textContent).toContain('no schema found'));
    view.setData('/schema', {tables: []});
    await waitFor(() => expect(view.cell('e').querySelector('[data-gl-state="empty"]')!.textContent).toBe('no tables to draw'));
    view.setData('/schema', {...datasetFixture('repo.packages'), kind: 'record', data: SCHEMA});
    await waitFor(() => expect(nodeIds(view, 'e')).toEqual(['users', 'sessions']));
    expect(stageOf(view, 'e')).toBeTruthy();
  });

  it.each([
    ['a list of things that are not tables', [1, 'x'], /expected tables \[\{name, columns\}\], but none of the 2 entries have a name/],
    ['a string', 'users', /expected tables \[\{name, columns\}\] or \{tables, relations\}, received a string/],
    ['tables that are not a list', {tables: {users: {}}}, /expected tables to be an array, received an object/],
  ])('shows an E_SHAPE redline for %s', async (_name, data, message) => {
    const view = renderExpress(SPEC, {data: {'/schema': data}});
    await waitFor(() => expect(view.cell('e').querySelector('[data-code="E_SHAPE"]')!.textContent).toMatch(message));
  });

  it('coerces malformed tables and drops relations to tables that do not exist', async () => {
    const schema = {
      tables: [
        {name: 'a', columns: ['bare', {name: 'ok', type: 7}, {type: 'nameless'}, null]},
        {name: 'a', columns: []},
        {columns: [{name: 'x'}]},
        {name: 'b.c', columns: 'none'},
        'junk',
      ],
      relations: [{from: 'a.ok', to: 'b.c'}, {from: 'a', to: 'ghost'}, {from: 'a.nope', to: 'a.bare', card: 'weird'}, 'junk', {to: 'a'}],
    };
    const view = await ready(schema);
    expect(nodeIds(view, 'e')).toEqual(['a', 'b.c']);
    expect([...nodeOf(view, 'e', 'a').querySelectorAll('[data-column]')].map(row => row.getAttribute('data-column'))).toEqual(['bare', 'ok']);
    // a table without columns is still a box with one empty row
    expect(nodeOf(view, 'e', 'b.c').querySelector('rect')!.getAttribute('height')).toBe(String(26 + 22));
    expect(sizeOf(nodeOf(view, 'e', 'b.c')).h).toBe(26 + 22);
    expect([...view.cell('e').querySelectorAll('[data-edge]')].map(e => e.getAttribute('data-edge')).sort()).toEqual(['a->a', 'a->b.c']);
    // Decision links-through-node-ids: the catalog's cleanSchema names each entry it left out; the tab tells the model (W_DROPPED).
    expect(view.cell('e').querySelector('[data-gl-note]')!.textContent).toBe('9 not drawn');
    await waitFor(() => expect(view.stateOf('e')).toBe('W_DROPPED'));
    const message = view.reports.findLast(report => report.code === 'W_DROPPED')!.message;
    expect(message).toMatch(/^ERDiagram#e: not drawn: table a column 3: no name; /);
    for (const part of ['table a: repeated', 'table 3: no name', "relation 2: unknown table 'ghost'", 'and 1 more']) expect(message).toContain(part);
    const clean = cleanSchema(schema);
    expect(clean.ok && clean.ast.relations[0]).toMatchObject({from: 'a', fromColumn: 'ok', to: 'b.c'});
  });

  it('reports unknown keys and an unreadable node of data a patch wrote (W_DROPPED)', async () => {
    const view = await ready({tables: [{name: 'users', colour: 'red', node: {}, columns: [{name: 'id', unique: true}]}]});
    await waitFor(() => expect(view.stateOf('e')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toBe(
      "ERDiagram#e: not drawn: table users: node: expected 'ID' or ['ID', ...], received an object; ignored table key colour; ignored column key unique",
    );
    expect(nodeIds(view, 'e')).toEqual(['users']);
    // the node link is left out; the unknown keys leave nothing out
    expect(view.cell('e').querySelector('[data-gl-note]')!.textContent).toBe('1 not drawn');
    view.setData('/schema', SCHEMA);
    await waitFor(() => expect(view.stateOf('e')).toBe('OK'));
    expect(view.cell('e').querySelector('[data-gl-note]')).toBeNull();
  });

  // Decision links-through-node-ids: tables that name node PG light with it; the tables of one file stay apart by their lines.
  it('lights the tables linked to a selected node, and a table with its own lines alone', async () => {
    const tables = [
      {name: 'orders', file: 'db/schema.sql#L10-30', node: 'PG', columns: [{name: 'id', pk: true}, {name: 'payment_id', fk: 'payments.id'}]},
      {name: 'payments', file: 'db/schema.sql#L31-50', node: 'PG', columns: [{name: 'id', pk: true}]},
      {name: 'audit', file: 'db/audit.sql', columns: [{name: 'id', pk: true}]},
    ];
    const view = await ready({tables});
    const lit = () => nodeIds(view, 'e').filter(name => nodeOf(view, 'e', name).hasAttribute('data-selected'));
    view.setData('/ui/sel', {type: 'node', id: 'PG', label: 'Postgres'});
    await waitFor(() => expect(lit()).toEqual(['orders', 'payments']));
    // a relation between two linked tables is hot; a table linked to nothing dims
    expect(edgeOf(view, 'e', 'orders->payments').hasAttribute('data-hot')).toBe(true);
    expect(nodeOf(view, 'e', 'audit').hasAttribute('data-dim')).toBe(true);

    click(nodeOf(view, 'e', 'orders'));
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'orders', label: 'orders', path: 'db/schema.sql', line: 10, endLine: 30, nodes: ['PG']});
    expect(view.getData('/ui/file')).toBe('db/schema.sql#L10-30');
    // payments shares the file, not the lines, and stands for PG but not for orders: it lights as orders' neighbour only
    expect(lit()).toEqual(['orders']);
    // a file selected elsewhere, without lines, is the place of both tables
    view.setData('/ui/sel', {type: 'file', id: 'db/schema.sql', path: 'db/schema.sql'});
    await waitFor(() => expect(lit()).toEqual(['orders', 'payments']));
  });

  it('cuts 500-character names to the table', async () => {
    const long = 'n'.repeat(500);
    const view = await ready({tables: [{name: long, columns: [{name: long, type: long}]}]});
    const node = nodeOf(view, 'e', long);
    expect(Number(node.querySelector('rect')!.getAttribute('width'))).toBeLessThanOrEqual(320);
    for (const text of node.querySelectorAll('text')) {
      expect(text.textContent!.length).toBeLessThan(50);
      expect(text.textContent!.endsWith('…')).toBe(true);
    }
  });

  it('lays out top to bottom with dir=TB, the relation still between the two rows', async () => {
    const view = await ready(SCHEMA, `root=Page('T',[e])\ne=ERDiagram($/schema,dir='TB',title='Schema',size='l')`);
    const sessions = positionOf(nodeOf(view, 'e', 'sessions'));
    const users = positionOf(nodeOf(view, 'e', 'users'));
    expect(sessions.y).toBeLessThan(users.y);
    const line = pointsOf(lineOf(edgeOf(view, 'e', 'sessions->users')));
    expect(Math.abs(line[0]![1] - (sessions.y + 26 + 22 + 11))).toBeLessThanOrEqual(1);
    expect(Math.abs(line.at(-1)![1] - (users.y + 26 + 11))).toBeLessThanOrEqual(1);
  });

  it('lets tables be dragged: relations follow, the position is stored, Re-layout brings the layout back', async () => {
    const view = await ready();
    const before = positionOf(nodeOf(view, 'e', 'users'));
    const edgeBefore = lineOf(edgeOf(view, 'e', 'sessions->users'));
    expect(within(view.cell('e')).queryByRole('button', {name: /Re-layout/})).toBeNull();

    const {k} = viewOf(stageOf(view, 'e'));
    await drag(nodeOf(view, 'e', 'users'), 80, 120);
    const after = positionOf(nodeOf(view, 'e', 'users'));
    expect(after.x).toBeCloseTo(before.x + 80 / k, -0.5);
    expect(after.y).toBeCloseTo(before.y + 120 / k, -0.5);
    expect(lineOf(edgeOf(view, 'e', 'sessions->users'))).not.toBe(edgeBefore);
    expect(Object.keys(JSON.parse(storage.items.get(POSITIONS_KEY)!)['demo/test/e'])).toEqual(['users']);

    fireEvent.click(within(view.cell('e')).getByRole('button', {name: /Re-layout/}));
    expect(positionOf(nodeOf(view, 'e', 'users'))).toEqual(before);
    expect(lineOf(edgeOf(view, 'e', 'sessions->users'))).toBe(edgeBefore);
    expect(JSON.parse(storage.items.get(POSITIONS_KEY)!)).toEqual({});
  });

  it('reads a bare list of tables and draws the relation a string fk or ref names (accept-familiar-variants, F033)', async () => {
    const tables = [
      {name: 'users', columns: [{name: 'id', type: 'uuid', pk: true}, 'email']},
      {name: 'orders', columns: [{name: 'id', pk: true}, {name: 'user_id', fk: 'users.id'}, {name: 'shop', ref: 'shops'}]},
      {name: 'shops', columns: [{name: 'id', pk: true}]},
    ];
    // (Read by the catalog's cleanSchema since decision links-through-node-ids; its own tests cover every case.)
    const clean = cleanSchema(tables);
    if (!clean.ok) throw new Error(clean.error);
    expect(clean.ast.tables.map(table => table.name)).toEqual(['users', 'orders', 'shops']);
    expect(clean.ast.relations).toEqual([
      {from: 'orders', fromColumn: 'user_id', to: 'users', toColumn: 'id', card: 'n-1'},
      {from: 'orders', fromColumn: 'shop', to: 'shops', card: 'n-1'},
    ]);
    // a column that points somewhere is marked as a foreign key
    expect(clean.ast.tables[1]!.columns.filter(column => column.fk).map(column => column.name)).toEqual(['user_id', 'shop']);
    // written out in relations as well: drawn once
    const both = cleanSchema({tables, relations: [{from: 'users.id', to: 'orders.user_id'}]});
    if (!both.ok) throw new Error(both.error);
    expect(both.ast.relations.filter(rel => [rel.from, rel.to].sort().join() === 'orders,users')).toHaveLength(1);
    // a pointer at a table that is not there is named, not drawn
    const ghost = cleanSchema([{name: 'a', columns: [{name: 'b_id', fk: 'b.id'}]}]);
    if (!ghost.ok) throw new Error(ghost.error);
    expect(ghost.ast.relations).toEqual([]);
    expect(ghost.dropped).toEqual(["column a.b_id: fk 'b.id' names no table"]);

    const view = await ready(tables);
    expect(nodeIds(view, 'e').sort()).toEqual(['orders', 'shops', 'users']);
    expect(edgeOf(view, 'e', 'orders->users')).toBeTruthy();
    expect(edgeOf(view, 'e', 'orders->shops')).toBeTruthy();
    expect(view.cell('e').querySelector('[data-gl-state="redline"]')).toBeNull();
  });
});

describe('ERDiagram: opens readable (design rule diagrams-open-readable)', () => {
  it('grows its plate to show three tables whole at 100%, where it opened at 72% with 8 px column types', async () => {
    const orders = {name: 'orders', columns: [
      {name: 'id', type: 'uuid', pk: true}, {name: 'user_id', type: 'uuid', fk: 'users.id'}, ...['status', 'currency', 'coupon', 'placed_at', 'paid_at', 'shipped_at', 'cancelled_at', 'ship_to', 'bill_to', 'total_cents'].map(name => ({name, type: 'timestamptz'})),
    ]};
    const view = renderExpress(`root=Page('T',[e])\ne=ERDiagram($/schema,title='Schema')`, {data: {'/schema': [...SCHEMA.tables, orders]}, size: {width: 724, height: 600}});
    await screen.findByRole('img', {name: /^Entity-relationship diagram/});
    await drawn(view, 'e', 3);
    const zoom = Number.parseInt(view.cell('e').querySelector('[data-zoom]')!.textContent!, 10);
    expect(zoom).toBeGreaterThanOrEqual(91);
  });
});


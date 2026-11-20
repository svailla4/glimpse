import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {VISIBLE_COLUMNS, cleanSchema} from '../../src/components/diagrams/ERDiagram.tsx';
import {POSITIONS_KEY, configurePositionStorage} from '../../src/components/diagrams/edgekit/index.ts';
import {datasetFixture, errorDataset, pendingDataset, renderExpress} from '../harness.tsx';
import {click, drag, edgeOf, fakeStorage, focus, inside, key, lineOf, nodeIds, nodeOf, pointsOf, positionOf, stageOf, type FakeStorage} from './util.tsx';

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
  return view;
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

  it('joins tables at the related columns with crow\'s-foot ends and a label', async () => {
    const view = await ready();
    const edge = edgeOf(view, 'e', 'sessions->users');
    const line = pointsOf(lineOf(edge));
    const sessions = positionOf(nodeOf(view, 'e', 'sessions'));
    const users = positionOf(nodeOf(view, 'e', 'users'));
    const sessionsWidth = Number(nodeOf(view, 'e', 'sessions').querySelector('rect')!.getAttribute('width'));
    // from the user_id row (second) of sessions to the id row (first) of users
    expect(line[0]).toEqual([sessions.x + sessionsWidth, sessions.y + 26 + 22 + 11]);
    expect(line.at(-1)).toEqual([users.x, users.y + 26 + 11]);
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
    expect(pointsOf(lineOf(edge))[0]![1]).toBe(sessions.y + (26 + 3 * 22) / 2);
  });

  it('folds a table over 12 columns and unfolds it on a click or Shift+Enter', async () => {
    const view = await ready({tables: [wide(20), {name: 'other', columns: [{name: 'wide_id', fk: true}]}], relations: [{from: 'other.wide_id', to: 'wide.c17', card: 'n-1'}]});
    const table = () => nodeOf(view, 'e', 'wide');
    expect(table().querySelectorAll('[data-column]')).toHaveLength(VISIBLE_COLUMNS);
    expect(table().querySelector('[data-more]')!.textContent).toBe('+ 8 more');
    // a relation to a folded column attaches to the fold row
    const end = () => pointsOf(lineOf(edgeOf(view, 'e', 'other->wide'))).at(-1)![1] - positionOf(table()).y;
    expect(end()).toBe(26 + 12 * 22 + 11);

    click(table().querySelector('[data-more] rect')!);
    await waitFor(() => expect(table().querySelectorAll('[data-column]')).toHaveLength(20));
    expect(table().querySelector('[data-more]')!.textContent).toBe('show fewer');
    expect(end()).toBe(26 + 17 * 22 + 11);
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

  it('selects a table; one with a file selects that file', async () => {
    const view = await ready();
    click(nodeOf(view, 'e', 'users'));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/schema.sql', path: 'src/auth/schema.sql', line: 1, label: 'users'});
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
  });

  it.each([
    ['a list', [1], /expected \{tables, relations\}, received an array/],
    ['a string', 'users', /received a string/],
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
    expect([...view.cell('e').querySelectorAll('[data-edge]')].map(e => e.getAttribute('data-edge')).sort()).toEqual(['a->a', 'a->b.c']);
    expect(view.cell('e').querySelector('[data-gl-note]')!.textContent).toBe('3 relations to unknown tables dropped · 3 unnamed or repeated tables dropped');
    const clean = cleanSchema(schema);
    expect(typeof clean !== 'string' && clean.relations[0]).toMatchObject({from: 'a', fromColumn: 'ok', to: 'b.c'});
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

  it('lays out top to bottom with dir=TB', async () => {
    const view = await ready(SCHEMA, `root=Page('T',[e])\ne=ERDiagram($/schema,dir='TB',title='Schema',size='l')`);
    expect(positionOf(nodeOf(view, 'e', 'sessions')).y).toBeLessThan(positionOf(nodeOf(view, 'e', 'users')).y);
    const line = pointsOf(lineOf(edgeOf(view, 'e', 'sessions->users')));
    expect(line.at(-1)![1]).toBe(positionOf(nodeOf(view, 'e', 'users')).y);
  });

  it('lets tables be dragged: relations follow, the position is stored, Re-layout brings the layout back', async () => {
    const view = await ready();
    const stage = stageOf(view, 'e');
    const before = positionOf(nodeOf(view, 'e', 'users'));
    const edgeBefore = lineOf(edgeOf(view, 'e', 'sessions->users'));
    expect(within(view.cell('e')).queryByRole('button', {name: /Re-layout/})).toBeNull();

    drag(stage, nodeOf(view, 'e', 'users'), 80, 120);
    const after = positionOf(nodeOf(view, 'e', 'users'));
    expect(after).toEqual({x: before.x + 80, y: before.y + 120});
    const edgeAfter = lineOf(edgeOf(view, 'e', 'sessions->users'));
    expect(edgeAfter).not.toBe(edgeBefore);
    // still from the user_id row to the id row
    expect(pointsOf(edgeAfter)[0]).toEqual(pointsOf(edgeBefore)[0]);
    expect(pointsOf(edgeAfter).at(-1)).toEqual([after.x, after.y + 26 + 11]);
    expect(Object.keys(JSON.parse(storage.items.get(POSITIONS_KEY)!)['demo/test/e'])).toEqual(['users']);

    fireEvent.click(within(view.cell('e')).getByRole('button', {name: /Re-layout/}));
    expect(positionOf(nodeOf(view, 'e', 'users'))).toEqual(before);
    expect(lineOf(edgeOf(view, 'e', 'sessions->users'))).toBe(edgeBefore);
    expect(JSON.parse(storage.items.get(POSITIONS_KEY)!)).toEqual({});
  });
});

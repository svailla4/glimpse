// Regression tests for the review findings in the content family: Steps `current` and status words (F034), exact
// figures in Stat (F042), the wrapped KPI strip (F015), tooltips on sparklines and list bars, category colours
// without a session slot (F006, stable-category-colours), a session that has ended (F024) and the one plate of a titled list (F081).
import type {LinkStatus} from '@glimpse/catalog';
import {act, fireEvent, screen, waitFor, within} from '@testing-library/react';
import {useSyncExternalStore, type ReactNode} from 'react';
import {afterEach, describe, expect, it} from 'vitest';
import {toStatus} from '../../src/components/content/Steps.tsx';
import {stripColumns} from '../../src/components/content/Stats.tsx';
import {nearestPoint} from '../../src/components/content/shared/Spark.tsx';
import {LinkContext} from '../../src/kit/index.ts';
import {renderExpress} from '../harness.tsx';

const value = (cell: HTMLElement) => cell.querySelector('[data-gl-stat-value]')?.textContent;
const queued = (cell: HTMLElement) => cell.querySelector('[role="status"]') as HTMLElement;

describe('Steps (F034, accept-familiar-variants)', () => {
  it('counts `current` the way the numerals on screen do: 1 is the first step', async () => {
    const view = renderExpress(`$/plan=['Plan','Build','Ship']\nroot=Page('T',[a,b,c])\na=Steps($/plan,current=2)\nb=Steps($/plan,1)\nc=Steps($/plan,0)`);
    const current = (id: string) => [...view.cell(id).querySelectorAll('ol > li')].map(step => step.getAttribute('aria-current'));
    // "current=2" means the step numbered 2
    expect(current('a')).toEqual([null, 'step', null]);
    expect(view.cell('a').querySelector('[aria-current="step"]')!.textContent).toBe('2Build');
    expect(current('b')).toEqual(['step', null, null]);
    // 0 is no step, not the first
    expect(current('c')).toEqual([null, null, null]);
    view.send({version: '1.0', updateDataModel: {surfaceId: view.surfaceId, path: '/plan', value: ['Plan', 'Build', 'Ship', 'Rest']}});
    await waitFor(() => expect(current('a')).toEqual([null, 'step', null, null]));
  });

  it('reads the status words writers reach for', async () => {
    expect(['in progress', 'in_progress', 'In-Progress', 'active', 'WIP'].map(toStatus)).toEqual(['doing', 'doing', 'doing', 'doing', 'doing']);
    expect(['complete', 'completed', 'DONE', ' done '].map(toStatus)).toEqual(['done', 'done', 'done', 'done']);
    expect(['pending', 'to do', 'not_started'].map(toStatus)).toEqual(['todo', 'todo', 'todo']);
    expect(['failed', 'cancelled'].map(toStatus)).toEqual(['blocked', 'skipped']);
    expect([toStatus('whenever'), toStatus(3), toStatus(undefined)]).toEqual([undefined, undefined, undefined]);

    const view = renderExpress(`$/plan=[{title:'A',status:'completed'},{title:'B',status:'in progress'},{title:'C',status:'in_progress'},{title:'D',status:'pending'},{title:'E',status:'someday'}]\nroot=Page('T',[p])\np=Steps($/plan,title='Plan')`);
    const cell = view.cell('p');
    expect([...cell.querySelectorAll('ol > li')].map(step => step.getAttribute('data-status'))).toEqual(['done', 'doing', 'doing', 'todo', null]);
    // a status that was read counts: the plate header no longer says nothing is done
    expect(cell.querySelector('[data-gl-steps-count]')?.textContent).toBe('1 / 5 done');
  });
});

describe('Stat (F042)', () => {
  it('prints a supplied integer below 10,000 in full, and goes compact from there or when told to', async () => {
    const view = renderExpress(
      `root=Page('T',[a,b,c,d,e,f])\na=Stat(1866,'Tests')\nb=Stat(9999,'Edge')\nc=Stat(10000,'Round')\nd=Stat(1866,'Short',format='compact')\ne=Stat(41,'Commits',delta=1866)\nf=Stat(-4210,'Debt')`,
    );
    expect(value(view.cell('a'))).toBe('1,866');
    expect(view.cell('a').textContent).toBe('Tests1,866');
    expect(value(view.cell('b'))).toBe('9,999');
    expect(view.cell('c').textContent).toBe('Round10k');
    // an explicit format is obeyed
    expect(view.cell('d').textContent).toBe('Short1.9k');
    // the delta follows the same rule
    expect(view.cell('e').textContent).toContain('+1,866');
    expect(value(view.cell('f'))).toBe('−4,210');
  });
});

describe('Stats: a strip that wraps (F015)', () => {
  it('spreads the cells over rows of equal length instead of leaving an orphan', () => {
    // 7 cells: one row when they fit, else 4 + 3, never 6 + 1
    expect(stripColumns(7, 1208)).toBe(7);
    expect(stripColumns(7, 1000)).toBe(4);
    expect(stripColumns(7, 728)).toBe(4);
    expect(stripColumns(7, 400)).toBe(2);
    expect(stripColumns(5, 728)).toBe(3);
    expect(stripColumns(3, 100)).toBe(1);
    // before it is measured the strip is one row
    expect(stripColumns(4, 0)).toBe(4);
  });

  it('tells every cell its column and row, completes the last row with a blank, and keeps the rows equally tall', async () => {
    const kpis = Array.from({length: 7}, (_, i) => ({label: `K${i}`, value: i + 1, ...(i === 5 ? {delta: 161} : {})}));
    const view = renderExpress(`$/k=[]\nroot=Page('T',[s])\ns=Stats($/k)`, {data: {'/k': kpis}, size: {width: 728, height: 600}});
    const strip = view.cell('s').querySelector<HTMLElement>('[data-gl-stats]')!;
    expect(strip.getAttribute('data-cols')).toBe('4');
    expect(strip.style.getPropertyValue('--stats-cols')).toBe('4');
    const cells = [...strip.children] as HTMLElement[];
    // 4 + 3 and one blank: 8 grid cells, each drawing the same rules (left unless first column, top unless first row)
    expect(cells).toHaveLength(8);
    expect(cells.map(cell => `${cell.getAttribute('data-row')}:${cell.getAttribute('data-col')}`)).toEqual(['0:0', '0:1', '0:2', '0:3', '1:0', '1:1', '1:2', '1:3']);
    expect(cells.map(cell => cell.hasAttribute('data-blank'))).toEqual([false, false, false, false, false, false, false, true]);
    expect(cells[7]!.getAttribute('aria-hidden')).toBe('true');
    expect(cells.filter(cell => cell.hasAttribute('data-last-row'))).toHaveLength(4);
    // one cell has a delta line: the others reserve it, so both rows have the same height
    const feet = cells.slice(0, 7).map(cell => cell.querySelector('[data-gl-stat]')!.children.length);
    expect(new Set(feet).size).toBe(1);
    expect(view.cell('s').querySelectorAll('[data-gl-stat]')).toHaveLength(7);
  });
});

describe('tooltips on sparklines and list bars', () => {
  it('finds the point under the pointer, skipping gaps', () => {
    expect(nearestPoint([3, 5, 2, 8], 0)).toBe(0);
    expect(nearestPoint([3, 5, 2, 8], 0.5)).toBe(2);
    expect(nearestPoint([3, 5, 2, 8], 2)).toBe(3);
    expect(nearestPoint([3, undefined, undefined, 8], 0.4)).toBe(0);
    expect(nearestPoint([undefined, undefined], 0.5)).toBeUndefined();
    expect(nearestPoint([], 0.5)).toBeUndefined();
  });

  it('shows the value of the sparkline point under the pointer and marks it', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=Stat(41,'Commits',unit='per week',spark=[3,5,2,8,13,9,41])`);
    const spark = within(view.cell('a')).getByRole('img', {name: 'Trend of Commits'});
    // the fake layout puts the box at x 0 with the harness width; the last point is at its right edge
    fireEvent.pointerMove(spark, {clientX: 960, clientY: 10});
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Commits41 per weekpoint 7 of 7');
    expect(spark.querySelector('[data-gl-spark-cursor]')).not.toBeNull();
    fireEvent.pointerMove(spark, {clientX: 0, clientY: 10});
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Commits3 per weekpoint 1 of 7'));
    fireEvent.pointerLeave(spark);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(spark.querySelector('[data-gl-spark-cursor]')).toBeNull();
  });

  it('shows what a list bar measures: the value and its share of the largest', async () => {
    const view = renderExpress(`$/rows=[{title:'core',value:200},{title:'docs',value:50},{title:'notes'}]\nroot=Page('T',[l])\nl=List($/rows)`);
    const values = [...view.cell('l').querySelectorAll<HTMLElement>('[data-gl-list-value]')];
    expect(values).toHaveLength(2);
    fireEvent.pointerMove(values[1]!, {clientX: 30, clientY: 30});
    expect((await screen.findByRole('tooltip')).textContent).toBe('docs5025% of the largest');
    fireEvent.pointerLeave(values[1]!);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

describe('category colours without a session slot (F006, stable-category-colours)', () => {
  const segments = (cell: HTMLElement) => [...cell.querySelectorAll<HTMLElement>('[data-segment]')];
  const SLOTS = {lang: {TypeScript: 1, CSS: 2}, module: {}, author: {}};

  it('SegmentedBar: adjacent categories never share the grey; a session ink is kept and the free inks follow in order', async () => {
    const rows = [{lang: 'TypeScript', loc: 50}, {lang: 'Go', loc: 20}, {lang: 'SQL', loc: 15}, {lang: 'CSS', loc: 10}, {lang: 'Astro', loc: 5}];
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[a])\na=SegmentedBar($/rows)`, {data: {'/rows': rows, '/meta/slots': SLOTS}});
    const cell = view.cell('a');
    expect(segments(cell).map(segment => `${segment.getAttribute('data-segment')} ${segment.style.background}`)).toEqual([
      'TypeScript var(--gl-cat-1)', 'Go var(--gl-cat-3)', 'SQL var(--gl-cat-4)', 'CSS var(--gl-cat-2)', 'Astro var(--gl-cat-5)',
    ]);
    // the legend swatches are the same inks
    expect([...cell.querySelectorAll<HTMLElement>('ul button > span[aria-hidden="true"]')].map(swatch => swatch.style.background)).toEqual(segments(cell).map(segment => segment.style.background));
    expect(segments(cell).some(segment => segment.hasAttribute('data-other'))).toBe(false);
  });

  it('SegmentedBar: categories no table knows (ecosystems) are coloured too, and a row called "Other" stays grey', async () => {
    const rows = [{name: 'npm', n: 21}, {name: 'pypi', n: 9}, {name: 'Other', n: 6}, {name: 'pub', n: 7}];
    const view = renderExpress(`$/rows=[]\nroot=Page('T',[a])\na=SegmentedBar($/rows)`, {data: {'/rows': rows}});
    expect(segments(view.cell('a')).map(segment => `${segment.getAttribute('data-segment')} ${segment.style.background}`)).toEqual([
      'npm var(--gl-cat-1)', 'pypi var(--gl-cat-2)', 'pub var(--gl-cat-3)', 'Other var(--gl-cat-other)',
    ]);
    // "Other" joins the small categories, so there is one grey segment at most
    view.setData('/rows', [...rows, {name: 'tiny', n: 0.2}, {name: 'tinier', n: 0.1}]);
    await waitFor(() => expect(segments(view.cell('a')).map(segment => segment.getAttribute('data-segment'))).toEqual(['npm', 'pypi', 'pub', 'other (3)']));
    expect(segments(view.cell('a')).filter(segment => segment.hasAttribute('data-other'))).toHaveLength(1);
  });

  it('Chips: a slot key the session does not know takes a free ink instead of the grey every other one has', async () => {
    const chips = [{label: 'TypeScript', slotKey: 'TypeScript'}, {label: 'npm', slotKey: 'npm'}, {label: 'pypi', slotKey: 'pypi'}, {label: 'npm again', slotKey: 'npm'}, {label: 'plain'}];
    const view = renderExpress(`$/c=[]\nroot=Page('T',[a])\na=Chips($/c)`, {data: {'/c': chips, '/meta/slots': SLOTS}});
    const dots = [...view.cell('a').querySelectorAll('li')].map(item => (item.querySelector('[aria-hidden="true"]') as HTMLElement | null)?.style.background ?? null);
    expect(dots).toEqual(['var(--gl-cat-1)', 'var(--gl-cat-2)', 'var(--gl-cat-3)', 'var(--gl-cat-2)', null]);
  });
});

describe('Button and Ask after the session has ended (F024)', () => {
  // The link status as the shell provides it (KitProvider `link`, read with useLinkStatus()); ended mid-test here.
  let link: LinkStatus = 'live';
  const listeners = new Set<() => void>();
  const endSession = () => act(() => {
    link = 'ended';
    for (const listener of listeners) listener();
  });
  function Link(p: {children: ReactNode}) {
    const status = useSyncExternalStore(notify => { listeners.add(notify); return () => void listeners.delete(notify); }, () => link);
    return <LinkContext.Provider value={status}>{p.children}</LinkContext.Provider>;
  }
  const wrapper = (node: ReactNode) => <Link>{node}</Link>;
  afterEach(() => {
    link = 'live';
    listeners.clear();
  });

  it('Button: says the press was not sent, and dispatches nothing', async () => {
    const view = renderExpress(`root=Page('T',[go])\ngo=Button('Approve plan',Event('approve'))`, {wrapper});
    const button = within(view.cell('go')).getByRole('button', {name: 'Approve plan'});
    expect(button.getAttribute('aria-disabled')).toBeNull();
    endSession();
    // no DOM banner is needed: the view reads the link status itself
    expect(document.querySelector('[data-gl-banner]')).toBeNull();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toContain('session has ended');
    fireEvent.click(button);
    await act(async () => {});
    expect(queued(view.cell('go')).textContent).toBe('not sent · session ended');
    expect(queued(view.cell('go')).getAttribute('data-gl-queued')).toBe('ended');
    expect(view.actions).toEqual([]);
  });

  it('Button: rendered into an ended session, it says so on the first press', async () => {
    const view = renderExpress(`root=Page('T',[go])\ngo=Button('Approve plan',Event('approve'))`, {link: 'ended'});
    fireEvent.click(within(view.cell('go')).getByRole('button', {name: 'Approve plan'}));
    await act(async () => {});
    expect(queued(view.cell('go')).getAttribute('data-gl-queued')).toBe('ended');
    expect(view.actions).toEqual([]);
  });

  it('Button: still says "queued for the agent" while the session is live, once the action was handed over', async () => {
    const view = renderExpress(`root=Page('T',[go])\ngo=Button('Approve plan',Event('approve'))`, {wrapper});
    fireEvent.click(within(view.cell('go')).getByRole('button', {name: 'Approve plan'}));
    await waitFor(() => expect(queued(view.cell('go')).textContent).toBe('queued for the agent'));
    expect(view.actions.map(action => action.name)).toEqual(['approve']);
  });

  it('Ask: a pick made after the end is not marked as chosen or queued; one made before keeps its mark', async () => {
    const view = renderExpress(`root=Page('T',[q])\nq=Ask('Ship it?',['Yes','No','Later'])`, {wrapper});
    const option = (name: string) => within(view.cell('q')).getByRole('button', {name});
    fireEvent.click(option('Later'));
    expect(option('Later').getAttribute('aria-pressed')).toBe('true');
    endSession();
    expect(queued(view.cell('q')).getAttribute('data-gl-queued')).toBe('queued');
    fireEvent.click(option('Yes'));
    expect(option('Yes').getAttribute('aria-pressed')).toBe('false');
    expect(option('Yes').getAttribute('aria-disabled')).toBe('true');
    expect(option('Later').getAttribute('aria-pressed')).toBe('true');
    expect(queued(view.cell('q')).textContent).toBe('not sent · session ended');
    expect(view.actions.map(action => action.context)).toEqual([{choice: 'Later'}]);
  });
});

describe('titled KeyValue, Steps and List (F081)', () => {
  it('get exactly one plate, drawn by the kit like any other component, with the view content in its header', async () => {
    const view = renderExpress(
      `$/plan=[{title:'A',status:'done'},{title:'B'}]\n$/kv={a:1}\n$/rows=[{title:'core',value:2}]\nroot=Page('T',[s,k,l,bare])\ns=Steps($/plan,title='Plan')\nk=KeyValue($/kv,title='Facts')\nl=List($/rows,title='Top',note='by size')\nbare=List($/rows,note='no plate here')`,
    );
    for (const id of ['s', 'k', 'l']) {
      const cell = view.cell(id);
      expect(cell.getAttribute('data-framed')).toBe('true');
      expect(cell.querySelectorAll('.gl-frame')).toHaveLength(1);
    }
    // what the view owns in the header still gets there: the Steps count
    await waitFor(() => expect(view.cell('s').querySelector('.gl-frame-head [data-gl-steps-count]')?.textContent).toBe('1 / 2 done'));
    // the caption of a titled list is the plate's, written once
    expect(view.cell('l').textContent!.split('by size')).toHaveLength(2);
    // without a title there is no plate, and the view draws its own caption
    expect(view.cell('bare').querySelector('.gl-frame')).toBeNull();
    expect(view.cell('bare').textContent).toContain('no plate here');
  });
});

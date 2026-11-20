// Stat, Stats and Sparkline: hero numerals, deltas, sparklines and the shared state matrix.
import {waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset, pendingDataset, renderExpress} from '../harness.tsx';

const value = (cell: HTMLElement) => cell.querySelector('[data-gl-stat-value]')?.textContent;
const state = (cell: HTMLElement) => cell.querySelector('[data-gl-state]')?.getAttribute('data-gl-state');

describe('Stat', () => {
  it('formats the numeral (compact by default), splits the unit, and shows label, delta and sparkline', async () => {
    const view = renderExpress(
      `root=Page('T',[a,b,c,d,e,f])
a=Stat(1284,'files',delta=38)
b=Stat(212400,'lines of code',spark=[3100,3300,3500,3900,4210])
c=Stat(131072,'size',format='bytes',delta=-2048)
d=Stat(60.14,'coverage',format='pct',unit='of lines',delta=0)
e=Stat('TS','main language')
f=Stat(12840,'exact',format='num')`,
    );
    const a = view.cell('a');
    expect(value(a)).toBe('1.3');
    expect(a.textContent).toContain('k');
    expect(a.textContent).toContain('files');
    expect(a.textContent).toContain('+38');
    expect(within(a).getByText('up 38')).toBeTruthy();
    expect(a.querySelector('svg[role="img"]')).toBeNull();

    const b = view.cell('b');
    expect(value(b)).toBe('212');
    expect(b.textContent).toContain('k');
    const spark = within(b).getByRole('img', {name: 'Trend of lines of code'});
    expect(spark.getAttribute('width')).toBe('72');
    expect(spark.getAttribute('height')).toBe('20');
    expect(spark.querySelector('path')?.getAttribute('d')).toMatch(/^M[\d. ]+(L[\d. ]+){4}$/);
    expect(spark.querySelector('circle')).not.toBeNull();

    expect(value(view.cell('c'))).toBe('131');
    expect(view.cell('c').textContent).toContain('kB');
    expect(view.cell('c').textContent).toContain('−2 kB');
    expect(within(view.cell('c')).getByText('down 2 kB')).toBeTruthy();
    expect(value(view.cell('d'))).toBe('60.1');
    expect(view.cell('d').textContent).toContain('% of lines');
    expect(within(view.cell('d')).getByText('no change')).toBeTruthy();
    // a word is set smaller than a numeral and never reformatted
    expect(value(view.cell('e'))).toBe('TS');
    expect(view.cell('e').querySelector('[data-gl-stat-value]')?.className).not.toBe(a.querySelector('[data-gl-stat-value]')?.className);
    expect(value(view.cell('f'))).toBe('12,840');
    expect(view.errors).toEqual([]);
  });

  it('covers pending, error, missing, malformed and updated values', async () => {
    const view = renderExpress(`$/v=7\nroot=Page('T',[a,b])\na=Stat($/v,'bound')\nb=Stat($/nothing,'unbound',spark=$/alsoNothing)`);
    expect(value(view.cell('a'))).toBe('7');
    // an unbound value is a missing cell: the label stays and the numeral is a dash
    expect(value(view.cell('b'))).toBe('—');
    expect(state(view.cell('b'))).toBe('empty');
    expect(view.cell('b').textContent).toContain('unbound');

    view.setData('/v', 4210);
    await waitFor(() => expect(value(view.cell('a'))).toBe('4.2'));
    // numeric text is an identifier unless a format says otherwise
    view.setData('/v', '8080');
    await waitFor(() => expect(value(view.cell('a'))).toBe('8080'));
    view.setData('/v', Number.NaN);
    await waitFor(() => expect(value(view.cell('a'))).toBe('—'));
    view.setData('/v', pendingDataset('repo.kpis', 'counting files'));
    await waitFor(() => expect(state(view.cell('a'))).toBe('drafting'));
    expect(view.cell('a').textContent).toContain('counting files');
    view.setData('/v', errorDataset('repo.kpis', 'E_NO_GIT', 'not a git repository'));
    await waitFor(() => expect(view.cell('a').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_NO_GIT'));
    view.setData('/v', {nested: true});
    await waitFor(() => expect(view.cell('a').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_SHAPE'));
    expect(view.cell('a').textContent).toContain('expected a number or a short string, received object');
    view.setData('/v', 3);
    await waitFor(() => expect(value(view.cell('a'))).toBe('3'));
  });

  it('ignores a sparkline or a delta that is not numeric', async () => {
    const view = renderExpress(`$/s='oops'\n$/d='n/a'\nroot=Page('T',[a])\na=Stat(5,'x',delta=$/d,spark=$/s)`);
    expect(value(view.cell('a'))).toBe('5');
    expect(view.cell('a').querySelector('svg')).toBeNull();
    view.setData('/s', [1, 'two', null, '4', 9]);
    await waitFor(() => expect(view.cell('a').querySelector('svg[role="img"]')).not.toBeNull());
    // the gap breaks the line instead of drawing through it
    expect(view.cell('a').querySelector('svg path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
  });
});

describe('Stats', () => {
  it('draws one cell per KPI from the default source, pending first', async () => {
    const view = renderExpress(`root=Page('T',[kpis])\nkpis=Stats()`);
    const cell = view.cell('kpis');
    expect(cell.getAttribute('data-gl')).toBe('Stats');
    expect(state(cell)).toBe('drafting');
    expect(cell.textContent).toContain('running repo.kpis');

    view.setData('/ds/repo_kpis', datasetFixture('repo.kpis'));
    await waitFor(() => expect(cell.querySelectorAll('[data-gl-stat]')).toHaveLength(7));
    expect([...cell.querySelectorAll('[data-gl-stat-value]')].map(node => node.textContent)).toEqual(['9', '4.2', '6', '3', '1', '38', '3']);
    expect(cell.textContent).toContain('Commits (30d)');
    expect(within(cell).getByRole('img', {name: 'Trend of Lines'})).toBeTruthy();
    // tone is a labelled mark, never colour alone
    expect(within(cell).getByRole('img', {name: 'warning'})).toBeTruthy();
    expect(within(cell).getByText('up 6')).toBeTruthy();
    expect(cell.querySelector('ul')?.children).toHaveLength(7);
  });

  it('shows the error, empty and wrong-shape states', async () => {
    const view = renderExpress(`$/k=[]\nroot=Page('T',[a,b])\na=Stats('diff.stats main..HEAD')\nb=Stats($/k)`);
    view.setData('/ds/' + pendingDataset('diff.stats main..HEAD').$ds, errorDataset('diff.stats main..HEAD', 'E_NO_GIT', 'not a git repository'));
    await waitFor(() => expect(view.cell('a').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_NO_GIT'));
    expect(view.cell('a').textContent).toContain('Stats#a');
    expect(state(view.cell('b'))).toBe('empty');
    view.setData('/k', 'seven');
    await waitFor(() => expect(view.cell('b').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_SHAPE'));
    view.setData('/k', [null, 4, {nothing: 'useful'}, []]);
    await waitFor(() => expect(view.cell('b').querySelectorAll('[data-gl-stat]')).toHaveLength(1));
    expect(value(view.cell('b'))).toBe('4');
    view.setData('/k', [{nothing: 'useful'}]);
    await waitFor(() => expect(state(view.cell('b'))).toBe('empty'));
  });

  it('coerces malformed items and caps a very long strip', async () => {
    const items = [
      {label: 'Null', value: null},
      {label: 'Text', value: 'n/a'},
      {label: 'Numeric text', value: '1500', format: 'compact'},
      {label: 'Bad format', value: 12, format: 'roman'},
      {label: 'Object', value: {a: 1}},
      {value: 3},
      ...Array.from({length: 80}, (_, i) => ({label: `K${i}`, value: i})),
    ];
    const view = renderExpress(`$/k=[]\nroot=Page('T',[a])\na=Stats($/k)`, {data: {'/k': items}});
    const values = [...view.cell('a').querySelectorAll('[data-gl-stat-value]')].map(node => node.textContent);
    expect(values.slice(0, 6)).toEqual(['—', 'n/a', '1.5', '12', '{"a":1}', '3']);
    expect(values).toHaveLength(48);
    expect(view.cell('a').textContent).toContain('showing 48 of 86');
    expect(view.container.querySelector('[data-gl-state="redline"]')).toBeNull();
  });
});

describe('Sparkline', () => {
  it('draws a line with an end dot at the width of its box, and describes itself', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=Sparkline([3,5,4,9,12,7])`, {size: {width: 240, height: 20}});
    const svg = await within(view.cell('a')).findByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('Sparkline, 6 points, 3 to 12, last 7');
    await waitFor(() => expect(svg.getAttribute('width')).toBe('240'));
    expect(svg.getAttribute('height')).toBe('20');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    const circle = svg.querySelector('circle')!;
    expect(Number(circle.getAttribute('cx'))).toBe(237);
    expect(Number(circle.getAttribute('r'))).toBe(1.5);
  });

  it('draws bars and areas, and takes the value column of rows', async () => {
    const view = renderExpress(`root=Page('T',[a,b,c])\na=Sparkline([2,-1,3],'bar')\nb=Sparkline([1,2,3],'area')\nc=Sparkline('git.activity')`, {datasets: 'ready'});
    const bars = (await within(view.cell('a')).findByRole('img')).querySelectorAll('rect');
    expect(bars).toHaveLength(3);
    // the negative bar hangs below the zero line the positive ones stand on
    expect(Number(bars[1]!.getAttribute('y'))).toBeGreaterThan(Number(bars[0]!.getAttribute('y')));
    const area = await within(view.cell('b')).findByRole('img');
    expect(area.getAttribute('data-kind')).toBe('area');
    expect(area.querySelectorAll('path')).toHaveLength(2);
    expect(area.querySelector('path')?.getAttribute('d')).toMatch(/Z$/);
    const rows = await within(view.cell('c')).findByRole('img');
    expect(rows.getAttribute('aria-label')).toMatch(/^Sparkline, \d+ points/);
  });

  it('covers pending, empty, error, malformed and huge data', async () => {
    const view = renderExpress(`$/n=[]\nroot=Page('T',[a,b])\na=Sparkline('git.activity')\nb=Sparkline($/n)`);
    expect(state(view.cell('a'))).toBe('drafting');
    expect(state(view.cell('b'))).toBe('empty');
    view.setData('/ds/git_activity', errorDataset('git.activity', 'E_SHALLOW', 'history is incomplete'));
    await waitFor(() => expect(view.cell('a').querySelector('[data-code]')?.getAttribute('data-code')).toBe('E_SHALLOW'));
    view.setData('/n', {a: 1});
    await waitFor(() => expect(view.cell('b').querySelector('[data-code]')?.getAttribute('data-code')).toBe('E_SHAPE'));
    view.setData('/n', ['x', null, {}]);
    await waitFor(() => expect(state(view.cell('b'))).toBe('empty'));
    expect(view.cell('b').textContent).toContain('no numbers to plot');
    view.setData('/n', [5]);
    const one = await within(view.cell('b')).findByRole('img');
    expect(one.querySelector('circle')).not.toBeNull();
    // 200k points are reduced to a path the size of the box, not one segment per point
    view.setData('/n', Array.from({length: 200_000}, (_, i) => Math.sin(i / 50) * 100));
    await waitFor(() => expect(within(view.cell('b')).getByRole('img').getAttribute('aria-label')).toContain('200,000 points'));
    const d = within(view.cell('b')).getByRole('img').querySelector('path')?.getAttribute('d') ?? '';
    expect(d.split('L').length).toBeLessThan(2100);
  });
});

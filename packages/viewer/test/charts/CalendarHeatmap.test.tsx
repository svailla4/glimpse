import {fireEvent} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {errorDataset} from '../harness.tsx';
import {chart} from './util.tsx';

const day = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

describe('CalendarHeatmap', () => {
  it('draws the default source as one cell per day between the first and the last date', async () => {
    const view = await chart(`CalendarHeatmap(title='Commits per day')`);
    expect(view.svg.getAttribute('aria-label')).toBe('Calendar heatmap, 10 active days of 16 from 2 Nov 2026 to 17 Nov 2026, 40 commits, busiest 10 Nov 2026 with 9');
    const cells = view.all('rect[data-i]');
    expect(cells).toHaveLength(16);
    expect(cells.filter(el => el.getAttribute('data-step') === '0')).toHaveLength(6);
    expect(cells.filter(el => el.getAttribute('data-step') === '4').length).toBeGreaterThan(0);
    // two and a half weeks of history on a 960 px plate: as much of the year before them as fills it, at 18 px
    expect(new Set(cells.map(el => el.getAttribute('width')))).toEqual(new Set(['18']));
    expect(view.all('svg text').map(el => el.textContent)).toEqual(['2026', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'M', 'W', 'F']);
    expect(view.all('[data-chart-ramp] span')).toHaveLength(7);
    // the key says which period its totals cover (V050)
    expect(view.root.querySelector('[data-chart-summary]')?.textContent).toBe('40 commits · 10 active days · Nov 2026');
    expect(view.errors).toEqual([]);
  });

  it('counts rows per day when there is no value field and adds up repeated days', async () => {
    const commits = await chart('CalendarHeatmap($/d)', {rows: [{date: '2026-11-02T08:00:00Z'}, {date: '2026-11-02T17:30:00Z'}, {date: '2026-11-04'}]});
    expect(commits.svg.getAttribute('aria-label')).toContain('2 active days of 3');
    expect(commits.svg.getAttribute('aria-label')).toContain('busiest 2 Nov 2026 with 2');
    commits.unmount();
    const summed = await chart(`CalendarHeatmap($/d,'when','n')`, {rows: [{when: '2026-11-02', n: 3}, {when: '2026-11-02', n: 4}]});
    expect(summed.svg.getAttribute('aria-label')).toContain('busiest 2 Nov 2026 with 7');
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart('CalendarHeatmap()', {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('CalendarHeatmap($/d)', {rows: []});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart('CalendarHeatmap()', {data: {'/ds/git_activity': errorDataset('git.activity', 'E_NO_GIT', 'not a repository')}});
    expect(failed.code()).toBe('E_NO_GIT');
    failed.unmount();
    const shape = await chart('CalendarHeatmap($/d)', {rows: {date: '2026-11-02'}});
    expect(shape.code()).toBe('E_SHAPE');
    shape.unmount();
    const noDates = await chart('CalendarHeatmap($/d)', {rows: [{name: 'x', n: 4}]});
    expect(noDates.state()).toBe('empty');
  });

  it('skips rows without a usable date and survives one day and all zeros', async () => {
    const view = await chart(`CalendarHeatmap($/d,'date','n')`, {rows: [{date: '2026-11-02', n: 1}, {date: 'soon', n: 2}, {date: null, n: 3}, {date: '2026-11-03', n: 'x'}]});
    expect(view.all('rect[data-i]')).toHaveLength(1);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('3 rows without a date or value');
    view.unmount();
    const zeros = await chart(`CalendarHeatmap($/d,'date','n')`, {rows: [{date: '2026-11-02', n: 0}, {date: '2026-11-05', n: 0}]});
    expect(zeros.all('rect[data-i]').map(el => el.getAttribute('data-step'))).toEqual(['0', '0', '0', '0']);
    expect(zeros.svg.innerHTML).not.toContain('NaN');
  });

  it('drops the oldest weeks instead of shrinking cells below 9 px', async () => {
    const rows = Array.from({length: 365}, (_, i) => ({date: day(i), n: i % 5}));
    const wide = await chart(`CalendarHeatmap($/d,'date','n')`, {rows});
    expect(wide.all('rect[data-i]')).toHaveLength(365);
    expect(wide.all('[data-chart-note]')).toHaveLength(0);
    wide.unmount();
    const narrow = await chart(`CalendarHeatmap($/d,'date','n')`, {rows, size: {width: 300, height: 600}});
    const cells = narrow.all('rect[data-i]');
    expect(cells.length).toBeLessThan(365);
    expect(Number(cells[0]!.getAttribute('width'))).toBe(9);
    expect(narrow.root.querySelector('[data-chart-note]')?.textContent).toMatch(/^\d+ earlier weeks not shown$/);
    // the newest day is kept
    expect(narrow.svg.getAttribute('aria-label')).toContain('to 31 Dec 2026');
  });

  it('moves by day and by week with the arrow keys; days are not selectable', async () => {
    const view = await chart('CalendarHeatmap()');
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Monday 2 Nov 2026, 3 commits');
    view.key('ArrowDown');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Tuesday 3 Nov 2026, 1 commits');
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toBe('Tuesday 10 Nov 2026, 9 commits');
    expect(view.tooltip()).toContain('Tue 10 Nov 2026');
    view.key('Enter');
    fireEvent.click(view.all('rect[data-i]')[3]!);
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('grows the cells with the width and keeps the key under the grid (F009)', async () => {
    const rows = Array.from({length: 365}, (_, i) => ({date: day(i), n: i % 5}));
    const cellAt = async (width: number) => {
      const view = await chart(`CalendarHeatmap($/d,'date','n')`, {rows, size: {width, height: 600}});
      const size = Number(view.all('rect[data-i]')[0]!.getAttribute('width'));
      const key = view.root.querySelector<HTMLElement>('[data-chart-key]')!;
      const out = {size, key: Number.parseFloat(key.style.maxWidth), summary: view.root.querySelector('[data-chart-summary]')?.textContent};
      view.unmount();
      return out;
    };
    // 53 weeks: 11 px cells need 711 px, 24 px cells 1,400 px
    expect((await cellAt(720)).size).toBe(11);
    expect((await cellAt(960)).size).toBe(15);
    // a full-width plate at 1440 px is used to its end (the integrator's 1440 px history)
    const desk = await cellAt(1240);
    expect(desk.size).toBe(20);
    expect(desk.key).toBe(22 + 53 * 22 - 2);
    const wide = await cellAt(1700);
    expect(wide.size).toBe(24);
    // the legend ends at the last week column, not at the far side of the plate
    expect(wide.key).toBe(22 + 53 * 26 - 2);
    expect(wide.summary).toBe('730 n · 292 active days · Jan – Dec 2026');
  });

  it('draws a short history on a quarter of calendar: the days before it are outlines, not zeros (F009)', async () => {
    const rows = [{date: '2026-11-18', n: 3}, {date: '2026-11-20', n: 5}];
    const view = await chart(`CalendarHeatmap($/d,'date','n')`, {rows, size: {width: 300, height: 600}});
    // only the days of the data are marks
    expect(view.all('rect[data-i]')).toHaveLength(3);
    const before = view.root.querySelector('[data-before]')!;
    // 13 weeks end on Saturday 21 Nov: 91 days less the three of the data and the one after them
    expect(before.getAttribute('d')!.match(/M/g)).toHaveLength(87);
    expect(view.svg.getAttribute('aria-label')).toContain('2 active days of 3');
    view.unmount();
    // a plate with room for more shows more of the year before, so it is not left half blank (integrator, 1440 px)
    const wide = await chart(`CalendarHeatmap($/d,'date','n')`, {rows, size: {width: 960, height: 600}});
    const gridRight = Number.parseFloat(wide.root.querySelector<HTMLElement>('[data-chart-key]')!.style.maxWidth);
    expect(gridRight).toBeGreaterThan(960 - 30);
    expect(wide.all('rect[data-i]')).toHaveLength(3);
    // and never more than a year of calendar
    const huge = await chart(`CalendarHeatmap($/d,'date','n')`, {rows, size: {width: 4000, height: 600}});
    expect(huge.root.querySelector('[data-before]')!.getAttribute('d')!.match(/M/g)!.length).toBeLessThanOrEqual(53 * 7);
    huge.unmount();
    wide.unmount();
    const year = await chart(`CalendarHeatmap($/d,'date','n')`, {rows: Array.from({length: 365}, (_, i) => ({date: day(i), n: 1}))});
    // 1 January 2026 is a Thursday: the four days of its week before it
    expect(year.root.querySelector('[data-before]')!.getAttribute('d')!.match(/M/g)).toHaveLength(4);
  });

  it('holds its height while the dataset is pending in a cell without a size (F016)', async () => {
    const pending = await chart(`CalendarHeatmap('git.activity')`, {datasets: 'pending'});
    expect(pending.root.querySelector<HTMLElement>('[data-chart-reserve]')?.style.height).toBe('182px');
    pending.unmount();
    const sized = await chart(`CalendarHeatmap('git.activity',size='m')`, {datasets: 'pending'});
    expect(sized.all('[data-chart-reserve]')).toHaveLength(0);
    expect(sized.state()).toBe('drafting');
  });

  it('follows a binding update', async () => {
    const view = await chart(`CalendarHeatmap($/d,'date','n')`, {rows: [{date: '2026-11-02', n: 1}]});
    view.setData('/d', [{date: '2026-11-02', n: 1}, {date: '2026-11-08', n: 5}]);
    expect(view.all('rect[data-i]')).toHaveLength(7);
  });
});

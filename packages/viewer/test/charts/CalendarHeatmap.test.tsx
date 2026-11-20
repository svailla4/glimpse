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
    expect(new Set(cells.map(el => el.getAttribute('width')))).toEqual(new Set(['11']));
    expect(view.all('svg text').map(el => el.textContent)).toEqual(['Nov', 'M', 'W', 'F']);
    expect(view.all('[data-chart-ramp] span')).toHaveLength(7);
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

  it('follows a binding update', async () => {
    const view = await chart(`CalendarHeatmap($/d,'date','n')`, {rows: [{date: '2026-11-02', n: 1}]});
    view.setData('/d', [{date: '2026-11-02', n: 1}, {date: '2026-11-08', n: 5}]);
    expect(view.all('rect[data-i]')).toHaveLength(7);
  });
});

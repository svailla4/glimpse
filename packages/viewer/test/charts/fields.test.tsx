// Field names a spec gives a chart (decisions D14, D15; V001, V012): a name the data has is drawn, in any case or by
// its label; a name it does not have is dropped for the chart's default encoding, named in the plate header and
// reported once as W_FIELD with the fields the data does have. A guess never leaves an empty plate.
import {describe, expect, it} from 'vitest';
import {chart} from './util.tsx';

const note = (view: Awaited<ReturnType<typeof chart>>) => view.root.querySelector('[data-chart-note]')?.textContent ?? '';
const fieldReports = (view: Awaited<ReturnType<typeof chart>>) => view.reports.filter(report => report.code === 'W_FIELD').map(report => report.message);
/** What the chart told the host other than OK (a cell that draws normally says OK, decision D14). */
const problems = (view: Awaited<ReturnType<typeof chart>>) => view.reports.filter(report => report.code !== 'OK');

describe('chart field names', () => {
  it('draws a scatter whose x is a guess on the default axis and names only the missing field (V001, V012)', async () => {
    const view = await chart(`ScatterPlot('git.hotspots',x='churn',y='complexity')`);
    expect(view.state()).toBeNull();
    expect(view.svg.getAttribute('aria-label')).toContain('commits against Indentation');
    expect(note(view)).toBe('no field "churn"');
    expect(fieldReports(view)).toEqual(['ScatterPlot#c: no field "churn" (x) in git.hotspots; fields: path commits complexity sloc score owner isTest']);
    expect(problems(view).map(report => report.code)).toEqual(['W_FIELD']);
    // the component draws, and its state stays W_FIELD while it draws that way
    expect(view.stateOf('c')).toBe('W_FIELD');
  });

  it('blames x, not y, when only x is missing from a line chart (V012)', async () => {
    const view = await chart(`LineChart('git.timeline',x='date',y='commits')`);
    expect(view.all('path').length).toBeGreaterThan(0);
    const [message] = fieldReports(view);
    expect(message).toBe('LineChart#c: no field "date" (x) in git.timeline; fields: week module commits');
    expect(message).not.toContain('"commits"');
  });

  it('lists every missing name of inline rows and falls back for each', async () => {
    const view = await chart(`LineChart($/d,'date','n')`, {rows: [{week: '2026-10-05', commits: 3}, {week: '2026-10-12', commits: 5}]});
    expect(view.svg.getAttribute('aria-label')).toBeTruthy();
    expect(note(view)).toBe('no field "date", "n"');
    expect(fieldReports(view)).toEqual(['LineChart#c: no fields "date" (x), "n" (y) in the data; fields: week commits']);
  });

  it('takes a field name in another case or by its label, silently', async () => {
    const view = await chart(`BarChart('git.churn','File','COMMITS')`);
    expect(view.all('path[data-i]')).toHaveLength(6);
    expect(problems(view)).toEqual([]);
    expect(view.stateOf('c')).toBe('OK');
    expect(view.root.querySelector('[data-chart-note]')).toBeNull();
    view.unmount();
    const lines = await chart(`ScatterPlot('git.hotspots','commits','complexity',r='lines')`);
    expect(lines.svg.getAttribute('aria-label')).toContain('sized by Lines');
    expect(problems(lines)).toEqual([]);
    lines.unmount();
    // a label with spaces in a prop that takes several names is one field, not three
    const spaced = await chart(`LineChart('git.timeline','week','Commits by main module')`);
    expect(problems(spaced)).toEqual([]);
    expect(spaced.root.querySelector('[data-chart-note]')).toBeNull();
  });

  it('checks every field prop of every rows chart', async () => {
    const bar = await chart(`BarChart('git.authors','author','churn')`);
    expect(bar.all('path[data-i]')).toHaveLength(3);
    expect(fieldReports(bar)).toEqual(['BarChart#c: no field "churn" (y) in git.authors; fields: author commits files last']);
    bar.unmount();
    const heat = await chart(`Heatmap('deps.matrix','target','from','weight')`);
    expect(heat.state()).toBeNull();
    expect(fieldReports(heat)).toEqual(['Heatmap#c: no field "target" (x) in deps.matrix; fields: from to weight']);
    heat.unmount();
    const cal = await chart(`CalendarHeatmap('git.activity',date='day',value='count')`);
    expect(cal.all('rect[data-i]')).toHaveLength(16);
    expect(fieldReports(cal)).toEqual(['CalendarHeatmap#c: no fields "day" (date), "count" (value) in git.activity; fields: date commits']);
    cal.unmount();
    const hist = await chart(`Histogram($/d,'nope')`, {rows: [{loc: 4}, {loc: 9}]});
    expect(hist.svg.getAttribute('aria-label')).toContain('Histogram of loc');
    expect(fieldReports(hist)).toEqual(['Histogram#c: no field "nope" (value) in the data; fields: loc']);
    hist.unmount();
    const scatter = await chart(`ScatterPlot($/d,'a','b',r='size',color='kind',label='name')`, {rows: [{a: 1, b: 2}, {a: 3, b: 4}]});
    expect(fieldReports(scatter)).toEqual(['ScatterPlot#c: no fields "size" (r), "kind" (color), "name" (label) in the data; fields: a b']);
  });

  it('reports W_FIELD, not an empty plate, when the default finds nothing either', async () => {
    const view = await chart(`BarChart($/d,'name','churn')`, {rows: [{name: 'a', owner: 'x'}]});
    expect(view.state()).toBe('empty');
    expect(view.root.textContent).toContain('no field "churn" (y) in the data; fields: name owner');
    expect(problems(view)).toEqual([expect.objectContaining({code: 'W_FIELD', message: 'BarChart#c: no field "churn" (y) in the data; fields: name owner'})]);
  });

  it('reports data with nothing to draw as W_SHAPE, not as missing data', async () => {
    const view = await chart('BarChart($/d)', {rows: [{a: 'x', b: 'y'}]});
    expect(view.state()).toBe('empty');
    expect(problems(view)).toEqual([expect.objectContaining({code: 'W_SHAPE', message: 'BarChart#c: no numeric field to draw'})]);
    view.unmount();
    const scatter = await chart(`ScatterPlot('git.hotspots','owner','path')`);
    expect(problems(scatter)).toEqual([expect.objectContaining({code: 'W_SHAPE', message: 'ScatterPlot#c: no rows with numbers in "owner" and "path" (git.hotspots)'})]);
  });

  it('withdraws the field report once the data has the field the spec names (D14: state, not event)', async () => {
    const view = await chart(`BarChart($/d,'name','lines')`, {rows: [{name: 'a', loc: 3}]});
    expect(note(view)).toBe('no field "lines"');
    expect(fieldReports(view)).toHaveLength(1);
    view.setData('/d', [{name: 'a', lines: 3}]);
    await view.settle();
    expect(view.root.querySelector('[data-chart-note]')).toBeNull();
    expect(fieldReports(view)).toHaveLength(1);
    // the component's state is OK again
    expect(view.stateOf('c')).toBe('OK');
  });
});

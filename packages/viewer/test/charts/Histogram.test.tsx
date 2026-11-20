import {fireEvent} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {errorDataset} from '../harness.tsx';
import {chart, numbers} from './util.tsx';

describe('Histogram', () => {
  it('bins a numeric field of a rows dataset and marks the median and the 90th percentile', async () => {
    const view = await chart(`Histogram('files.list','loc',title='File sizes')`);
    expect(view.svg.getAttribute('aria-label')).toMatch(/^Histogram of LOC, 9 values in \d+ bins, median 400, 90th percentile 836$/);
    expect(view.all('rect[data-i]').length).toBeGreaterThan(1);
    expect(view.root.querySelector('[data-median]')?.textContent).toBe('median 400');
    expect(view.root.querySelector('[data-p90]')?.textContent).toBe('p90 836');
    expect(view.errors).toEqual([]);
  });

  it('takes a bare array of numbers, numeric strings included', async () => {
    const view = await chart('Histogram($/d)', {rows: [1, 2, '3', 4, 5, 'x', null]});
    expect(view.svg.getAttribute('aria-label')).toMatch(/^Histogram, 5 values in/);
    expect(view.root.querySelector('[data-chart-note]')?.textContent).toBe('2 values not numeric');
  });

  it('defaults to Freedman-Diaconis bins capped at 40 and honours bins=', async () => {
    const values = numbers(5000, i => (i * 7919) % 1000);
    const auto = await chart('Histogram($/d)', {rows: values});
    const bars = auto.all('rect[data-i]').length;
    expect(bars).toBeGreaterThan(5);
    expect(bars).toBeLessThanOrEqual(41);
    expect(auto.all('rect[data-i]').reduce((sum, el) => sum + Number(el.getAttribute('height')), 0)).toBeGreaterThan(0);
    auto.unmount();
    const fixed = await chart('Histogram($/d,bins=4)', {rows: values});
    expect(fixed.all('rect[data-i]').length).toBeLessThanOrEqual(6);
  });

  it('shows drafting, empty, a source error and a wrong shape', async () => {
    const pending = await chart(`Histogram('files.list','loc')`, {datasets: 'pending'});
    expect(pending.state()).toBe('drafting');
    pending.unmount();
    const empty = await chart('Histogram($/d)', {rows: []});
    expect(empty.state()).toBe('empty');
    empty.unmount();
    const failed = await chart(`Histogram('files.list','loc')`, {data: {'/ds/files_list': errorDataset('files.list')}});
    expect(failed.code()).toBe('E_INTERNAL');
    failed.unmount();
    const shape = await chart('Histogram($/d)', {rows: {loc: 4}});
    expect(shape.code()).toBe('E_SHAPE');
    expect(shape.root.textContent).toContain('expected rows or an array of numbers, received object');
    shape.unmount();
    const words = await chart('Histogram($/d)', {rows: ['a', 'b']});
    expect(words.state()).toBe('empty');
    words.unmount();
    // a value field the data does not have: the default field is counted and the plate says which name it missed (D15)
    const missing = await chart(`Histogram($/d,'nope')`, {rows: [{loc: 4}]});
    expect(missing.state()).toBeNull();
    expect(missing.root.querySelector('[data-chart-note]')?.textContent).toBe('no field "nope"');
    missing.unmount();
    const nothing = await chart(`Histogram($/d,'nope')`, {rows: [{name: 'x'}]});
    expect(nothing.state()).toBe('empty');
    expect(nothing.root.textContent).toContain('"nope"');
  });

  it('keeps the median and p90 tags in a band above the bars, clear of the bars and of each other', async () => {
    // the tallest bin is the last, where the 90th percentile falls (the gallery's file sizes)
    const rows = [420, 480, 560, 640, 700, 820, 868, 900, 960].map(loc => ({loc}));
    for (const width of [960, 360]) {
      const view = await chart(`Histogram($/d,'loc')`, {rows, size: {width, height: 600}});
      const barTop = Math.min(...view.all('rect[data-i]').map(el => Number(el.getAttribute('y'))));
      const p90 = view.root.querySelector('[data-p90] text')!;
      const median = view.root.querySelector('[data-median] text')!;
      // a 10.5 px tag hangs about 3 px below its baseline: it ends at least 6 px above the highest bar
      expect(Number(p90.getAttribute('y')) + 3).toBeLessThanOrEqual(barTop - 6);
      expect(Number(view.root.querySelector('[data-p90] line')!.getAttribute('y2'))).toBeLessThan(barTop);
      // one row each
      expect(Number(p90.getAttribute('y')) - Number(median.getAttribute('y'))).toBeGreaterThanOrEqual(12);
      view.unmount();
    }
  });

  it('tags whole-number data with whole-number statistics (V050)', async () => {
    const whole = await chart(`Histogram($/d)`, {rows: [1, 2, 3, 4]});
    expect(whole.root.querySelector('[data-median] text')?.textContent).toBe('median 3');
    expect(whole.root.querySelector('[data-p90] text')?.textContent).toBe('p90 4');
    whole.unmount();
    const fractions = await chart(`Histogram($/d)`, {rows: [0.5, 1, 2.25, 4]});
    expect(fractions.root.querySelector('[data-median] text')?.textContent).toBe('median 1.63');
  });

  it('survives one datum, identical values, negatives and a log count axis', async () => {
    const one = await chart('Histogram($/d)', {rows: [42]});
    expect(one.all('rect[data-i]')).toHaveLength(1);
    expect(one.svg.getAttribute('aria-label')).toBe('Histogram, 1 value in 1 bin, median 42, 90th percentile 42');
    expect(one.svg.innerHTML).not.toContain('NaN');
    one.unmount();
    const zeros = await chart('Histogram($/d)', {rows: [0, 0, 0, 0]});
    expect(zeros.all('rect[data-i]')).toHaveLength(1);
    expect(zeros.svg.innerHTML).not.toContain('NaN');
    zeros.unmount();
    const negative = await chart('Histogram($/d)', {rows: [-10, -5, -5, 0, 3, 8]});
    expect(negative.svg.innerHTML).not.toContain('NaN');
    expect(negative.root.textContent).toContain('−10');
    negative.unmount();
    const log = await chart('Histogram($/d,log=true)', {rows: [...numbers(200, () => 1), 2, 3, 50]});
    expect(log.svg.innerHTML).not.toContain('NaN');
    expect(log.all('rect[data-i]').every(el => Number(el.getAttribute('height')) > 0)).toBe(true);
  });

  it('walks the bins with the keyboard; bins are not selectable', async () => {
    const view = await chart('Histogram($/d,bins=5)', {rows: numbers(100, i => i)});
    view.key('ArrowRight');
    expect(view.root.querySelector('[aria-live]')?.textContent).toMatch(/^0 – 20, 20 values$/);
    expect(view.tooltip()).toContain('20%');
    view.key('Enter');
    fireEvent.click(view.all('rect[data-i]')[1]!);
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(view.actions).toEqual([]);
  });

  it('follows a binding update', async () => {
    const view = await chart('Histogram($/d)', {rows: [1, 2, 3]});
    view.setData('/d', [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(view.svg.getAttribute('aria-label')).toContain('8 values');
  });
});

// Grid's `cols` is read by the server (fixed and warn lines) and by the viewer (tracks, W_COLS) through these two
// functions, so what each form means is pinned here, next to their definition.
import {describe, expect, it} from 'vitest';
import {normalizeCols, parseCols} from '../src/index.ts';

describe('normalizeCols', () => {
  it.each([
    // what Grid reads, as written
    ['3', '3'], ['2:1', '2:1'], ['1:2.5:1', '1:2.5:1'], ['12', '12'],
    // whitespace and case are not a different value
    [' 2:1 ', '2:1'], ['2 : 1', '2:1'],
    // CSS tracks and other separators
    ['2fr 1fr', '2:1'], ['2fr,1fr', '2:1'], ['2FR 1FR', '2:1'], ['1fr 2fr 1fr', '1:2:1'], ['2 1', '2:1'], ['2,1', '2:1'], ['2, 1', '2:1'],
    ['2/1', '2:1'], ['1/2', '1:2'], ['1;1', '1:1'],
    // percentages are shares of 100
    ['50% 50%', '1:1'], ['50%,50%', '1:1'], ['25% 75%', '1:3'], ['33% 67%', '33:67'], ['33.3% 66.7%', '33.3:66.7'],
    // counts in words, with their noun, as CSS, and past the most Grid draws
    ['two', '2'], ['Three', '3'], ['twelve', '12'], ['3 columns', '3'], ['4 cols', '4'], ['two columns', '2'], ['repeat(3, 1fr)', '3'], ['40', '12'],
  ])('%j -> %j', (written, meant) => {
    expect(normalizeCols(written)).toBe(meant);
  });

  it.each(['', '0', '-2', 'abc', 'wide', 'auto', '2:x', '1:0', '2:', ':', '1:-1', '3.5', '1fr', '200px 1fr', '1fr 50%', 'thirteen', '1:1:1:1:1:1:1:1:1:1:1:1:1'])('%j cannot be read', written => {
    expect(normalizeCols(written)).toBeUndefined();
  });
});

describe('parseCols', () => {
  it('gives the track weights of what normalizeCols reads', () => {
    expect(parseCols('3')).toEqual([1, 1, 1]);
    expect(parseCols(' 2:1 ')).toEqual([2, 1]);
    expect(parseCols('1:2.5:1')).toEqual([1, 2.5, 1]);
    expect(parseCols('2fr 1fr')).toEqual([2, 1]);
    expect(parseCols('50% 50%')).toEqual([1, 1]);
    expect(parseCols('two')).toEqual([1, 1]);
    expect(parseCols('40')).toHaveLength(12);
    for (const bad of [undefined, '', '0', 'wide', '1:0']) expect(parseCols(bad), String(bad)).toBeUndefined();
  });
});

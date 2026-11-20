// Rules of the kit and base stylesheets that jsdom cannot lay out: checked as text, so a regression in one of them
// fails here and not only in a screenshot. The visual proof is in the bundle screenshots of the review rounds.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const src = join(import.meta.dirname, '..', '..', 'src');
const read = (path: string) => readFileSync(join(src, path), 'utf8');
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = flat.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return flat.slice(flat.indexOf('{', at) + 1, flat.indexOf('}', at)).trim();
}
function modules(dir: string): string[] {
  return readdirSync(join(src, dir), {recursive: true, encoding: 'utf8'}).filter(file => file.endsWith('.module.css')).map(file => join(dir, file));
}

describe('kit.css', () => {
  it('lets the directory of a path take all of the squeeze, down to "…/" and no further (D12)', () => {
    const declarations = rule(read('styles/kit.css'), '.gl-path-dir');
    expect(declarations).toContain('flex: 0 1000000 auto');
    expect(declarations).toContain('min-width: 2.5ch');
  });

  it('is the one place that says so: no component module overrides how a path gives way', () => {
    const overrides = modules('components').filter(file => /gl-path-dir\)\s*\{[^}]*(flex|min-width)/.test(read(file)));
    expect(overrides).toEqual([]);
  });

  it('holds the height an unsized chart will draw at while its chunk loads, with and without a plate (F016)', () => {
    const css = read('styles/kit.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const unsized = ".gl-cell[data-family='chart']:not([data-size], [data-gl='Sparkline'], [data-gl='SegmentedBar'])";
    // both boxes a view can be in: the cell's own .gl-body, and the plate's body (never `:is()` around a combinator,
    // which can never match a frame body because its parent is the frame, not the cell)
    expect(css).toContain(`${unsized} > .gl-body > .gl-drafting`);
    expect(css).toContain(`${unsized} > .gl-frame > .gl-frame-body > .gl-drafting`);
    expect(css).not.toMatch(/:is\([^)]*>[^)]*\)\s*>\s*\.gl-drafting/);
    expect(rule(css, unsized)).toContain('--gl-chart-draft: 280px');
    for (const [name, height] of [['CalendarHeatmap', 182], ['Icicle', 150], ['Treemap', 328]] as const) {
      expect(rule(css, `.gl-cell[data-family='chart'][data-gl='${name}']`)).toContain(`--gl-chart-draft: ${height}px`);
    }
  });
});

describe('base.css', () => {
  it('does not stretch the plate of an unsized chart to the tallest neighbour of its row (F009)', () => {
    const declarations = rule(read('styles/base.css'), ".gl-cell[data-family='chart']:not([data-size]) > :is(.gl-frame, .gl-body)");
    expect(declarations).toBe('flex: 0 0 auto;');
  });
});

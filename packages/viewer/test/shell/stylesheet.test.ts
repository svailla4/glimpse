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
  it('does not stretch the plate of an unsized component to the tallest neighbour of its row (F009, the Cycles plate)', () => {
    const css = read('styles/base.css');
    // a chart never; tables and empty states not in a row (the page grid, a Grid, a Row say so with --gl-cell-fit)
    expect(rule(css, ".gl-cell[data-family='chart']:not([data-size]) > :is(.gl-frame, .gl-body)")).toBe('flex: 0 0 auto;');
    expect(rule(css, ".gl-cell:not([data-size]):not([data-family='layout']) > :is(.gl-frame, .gl-body)")).toBe('flex: calc(1 - var(--gl-fit)) 1 auto;');
    expect(rule(css, '.gl-grid12')).toContain('--gl-cell-fit: 1');
    for (const name of ['Grid', 'Row']) expect(read(`components/layout/${name}.module.css`), name).toContain('--gl-cell-fit: 1');
    // the cell reads the flag of its container and clears it for what is nested
    expect(rule(css, '.gl-cell')).toContain('--gl-fit: var(--gl-cell-fit, 0)');
    expect(rule(css, '.gl-cell > :is(.gl-frame, .gl-body)')).toContain('--gl-cell-fit: initial');
    // where the browser can, a plate other than a chart may still grow a little to keep one bottom line with its row
    expect(css).toContain('@supports (max-height: calc-size(fit-content, size + 1px))');
    expect(css).toContain('max-height: calc-size(fit-content, size + 64px + (1 - var(--gl-fit)) * 100000px);');
  });

  it('hides tooltips while a plate is moved or resized (V049)', () => {
    expect(rule(read('styles/kit.css'), ':root[data-gl-arranging] .gl-tooltip')).toBe('display: none;');
  });

  it('keeps the spans the spec asked for in a window of 1100 px and wider (D17)', () => {
    const css = read('styles/base.css');
    // the page container is the window less 64 px of padding: 1036 px at 1100
    expect(css).toContain('@container page (max-width: 999px)');
    expect(css).not.toContain('max-width: 1099px');
  });
});

describe('CommitList.module.css', () => {
  // Finding V050: two ref chips read 'PYTHON/A2UI-…' and 'PYTHON/A2UI-…'.
  it('elides a ref chip from its start, so the tail that tells refs apart stays', () => {
    const css = read('components/table/CommitList.module.css');
    expect(rule(css, '.ref')).toContain('direction: rtl');
    expect(rule(css, '.ref > bdi')).toContain('direction: ltr');
  });
});

describe('edgekit.module.css', () => {
  // Finding V049: at 100% the overview inset covered a node and stayed opaque.
  it('fades the overview inset while the pointer is over the diagram, and brings it back on the inset', () => {
    const css = read('components/diagrams/edgekit/edgekit.module.css');
    expect(rule(css, '.canvas:hover ~ .overview')).toMatch(/opacity: 0\.\d+/);
    expect(rule(css, '.overview:hover')).toContain('opacity: 1');
  });
});

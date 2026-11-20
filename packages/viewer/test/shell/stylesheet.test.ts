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

  // Round 4: `min-width: auto` is 0 for a box that clips, so the `…/` left after every directory was dropped still
  // took the squeeze first and a cell read './generic-binder.test.ts' or 'message-processor.test…'.
  it('never shrinks the `…/` that is left once directories are dropped; a long name gives way in its middle', () => {
    const css = read('styles/kit.css');
    // and is exactly as wide as that text: the 2.5ch floor left a gap after a bare `…/` ('…/ name.ts', round 5)
    expect(rule(css, '.gl-path-dir[data-dropped]')).toBe('flex: none; min-width: 0;');
    expect(rule(css, '.gl-path-base[data-split]')).toBe('display: flex;');
    expect(rule(css, '.gl-path-head')).toContain('text-overflow: ellipsis');
    expect(rule(css, '.gl-path-tail')).toBe('flex: none;');
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
  // Decision D20 (content-sized plates). Before it, a size step was a fixed height and a plate in a row grew to the
  // tallest neighbour, plus up to 64 px past its content: empty bodies beside tall plates on the overview, history,
  // deps and gallery pages and on the owner's demo pages.
  it('does not stretch a plate to the tallest neighbour of its row, sized or not (F009, D20)', () => {
    const css = read('styles/base.css');
    // a chart never; any other component not in a row (the page grid, a Grid, a Row say so with --gl-cell-fit)
    expect(rule(css, ".gl-cell[data-family='chart'] > :is(.gl-frame, .gl-body)")).toBe('flex: 0 0 auto;');
    expect(rule(css, ".gl-cell:not([data-family='layout']) > :is(.gl-frame, .gl-body)")).toBe('flex: calc(1 - var(--gl-fit)) 1 auto;');
    expect(rule(css, '.gl-grid12')).toContain('--gl-cell-fit: 1');
    for (const name of ['Grid', 'Row']) expect(read(`components/layout/${name}.module.css`), name).toContain('--gl-cell-fit: 1');
    // the cell reads the flag of its container and clears it for what is nested
    expect(rule(css, '.gl-cell')).toContain('--gl-fit: var(--gl-cell-fit, 0)');
    expect(rule(css, '.gl-cell > :is(.gl-frame, .gl-body)')).toContain('--gl-cell-fit: initial');
    // no plate grows past its content any more, not even by the 64 px that kept bottom lines
    expect(css).not.toContain('calc-size(');
  });

  it('makes a size step a maximum for the view box, and a height only for charts and Split (D20)', () => {
    const css = read('styles/base.css');
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rule(css, '.gl-cell[data-size] > .gl-frame > .gl-frame-body,\n  .gl-cell[data-size] > .gl-body')).toBe('max-height: var(--gl-h);');
    const fixed = ":is([data-family='chart'], [data-family='layout'])";
    expect(rule(css, `.gl-cell[data-size]${fixed} > .gl-frame > .gl-frame-body,\n  .gl-cell[data-size]${fixed} > .gl-body`)).toBe('height: var(--gl-h);');
    // the old rule gave the whole plate (header included) the step as its height
    expect(flat).not.toMatch(/\.gl-cell\[data-size\] > :is\(\.gl-frame, \.gl-body\) \{ height/);
    // a cell nested in a sized container reads no step of its own
    expect(rule(css, '.gl-cell:not([data-size])')).toBe('--gl-h: initial;');
    // while it drafts, a sized component holds its step (the plate inset is 14 px a side), in the kit layer: the
    // state's own `min-height: 72px` is there, and a base rule never wins against a later layer (round 5: 72 px)
    const kit = read('styles/kit.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(kit).toContain('.gl-cell[data-size] > .gl-body > .gl-drafting,');
    expect(kit).toContain('min-height: calc(var(--gl-h) - 28px);');
    expect(flat).not.toContain('.gl-drafting');
    // and the table shell does not undo it for the drafting it holds
    expect(read('components/table/shell.module.css')).toContain('.shell > :not(:global(.gl-state))');
  });

  it('gives every scroller its cap from useSizeCap, never a fixed 420 px or a fill (D20)', () => {
    for (const name of ['DataTable', 'FileTree', 'CommitList', 'JsonView']) {
      const css = read(`components/table/${name}.module.css`);
      expect(rule(css, '.root'), name).toContain('max-height: var(--gl-cap, 420px)');
      expect(css, name).not.toContain('data-sized');
    }
    const lines = read('components/code/codekit/lines.module.css');
    expect(rule(lines, ".code[data-fit='cap']")).toContain('max-height: var(--gl-cap, 420px)');
    expect(read('components/code/CodeTour.module.css')).not.toMatch(/height: 420px/);
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


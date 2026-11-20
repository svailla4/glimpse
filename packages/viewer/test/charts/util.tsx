// Shared by the chart tests: one chart on a page, bound to inline rows at /d or to a fixture dataset.
import {fireEvent} from '@testing-library/react';
import {renderExpress, type RenderExpressOptions, type RenderedSpec} from '../harness.tsx';

export interface ChartView extends RenderedSpec {
  cell: RenderedSpec['cell'];
  /** The chart's cell. */
  readonly root: HTMLElement;
  /** The chart's SVG (`role="img"`); throws when the chart is not drawn. */
  readonly svg: SVGSVGElement;
  all(selector: string): Element[];
  state(): string | null;
  code(): string | null;
  tooltip(): string;
  key(key: string, init?: KeyboardEventInit): void;
}

/** Renders `c=<call>` on a page and waits for the lazy chunk. `data` is written to /d: use `$/d` in the call. */
export async function chart(call: string, options: RenderExpressOptions & {rows?: unknown} = {}): Promise<ChartView> {
  const {rows, ...rest} = options;
  const view = renderExpress(`root=Page('T',[c])\nc=${call}`, {datasets: 'ready', ...rest, data: {...(rows !== undefined ? {'/d': rows} : {}), ...rest.data}});
  await view.settle();
  const extra = {
    get root() { return view.cell('c'); },
    get svg() {
      const svg = view.cell('c').querySelector<SVGSVGElement>('svg[role="img"]');
      if (!svg) throw new Error(`no chart drawn: ${view.cell('c').innerHTML.slice(0, 400)}`);
      return svg;
    },
    all: (selector: string) => [...view.cell('c').querySelectorAll(selector)],
    state: () => view.cell('c').querySelector('[data-gl-state]')?.getAttribute('data-gl-state') ?? null,
    code: () => view.cell('c').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code') ?? null,
    tooltip: () => view.container.ownerDocument.querySelector('[role="tooltip"]')?.textContent ?? '',
    key(key: string, init: KeyboardEventInit = {}) {
      const svg = view.cell('c').querySelector('svg[role="img"]');
      if (!svg) throw new Error('no chart drawn');
      fireEvent.keyDown(svg, {key, ...init});
    },
  };
  return Object.defineProperties(view, Object.getOwnPropertyDescriptors(extra)) as ChartView;
}

export const numbers = (count: number, value: (i: number) => number): number[] => Array.from({length: count}, (_, i) => value(i));
export const LONG = 'x'.repeat(500);

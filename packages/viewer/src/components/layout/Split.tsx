// packages/viewer/src/components/layout/Split.tsx
// Two panes with a hairline divider in an 8 px hit area: drag to resize, double-click to go back to the spec's
// ratio, arrow keys move 2%. Below 720 px of page width a side-by-side split stacks.
import type * as C from '@glimpse/catalog';
import {useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent} from 'react';
import {ArrangeContext, type GlView} from '../../kit/index.ts';
import {vars} from './shared.ts';
import css from './Split.module.css';

const MIN = 0.1;
const MAX = 0.9;
const STEP = 0.02;
const clamp = (fraction: number) => Math.min(MAX, Math.max(MIN, fraction));

/**
 * Share of the first pane. The documented form is a ratio, '1:2' (one third; '1/2' too); the other ways authors write
 * a share are taken as meant (F037): a percentage '30%' or '30', a fraction '0.3' (the server quotes a number given
 * for this string prop). One half when the ratio is missing or means nothing.
 */
export function parseRatio(ratio: string | number | undefined): number {
  const text = String(ratio ?? '').trim();
  const pair = /^([\d.]+)\s*[:/]\s*([\d.]+)$/.exec(text);
  if (pair) {
    const start = Number(pair[1]);
    const end = Number(pair[2]);
    return Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > 0 ? clamp(start / (start + end)) : 0.5;
  }
  const share = /^([\d.]+)\s*(%?)$/.exec(text);
  if (!share) return 0.5;
  const value = Number(share[1]);
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  if (share[2] === '%' || (value > 1 && value < 100)) return value < 100 ? clamp(value / 100) : 0.5;
  return value < 1 ? clamp(value) : 0.5;
}

export const SplitView: GlView<typeof C.Split> = ({props, child}) => {
  const root = useRef<HTMLDivElement>(null);
  const spec = parseRatio(props.ratio);
  // null: the ratio the spec asks for; a number once the person has moved the divider.
  const [moved, setMoved] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const fraction = moved ?? spec;
  const column = props.dir === 'col';

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = root.current;
    if (!box || event.button !== 0) return;
    event.preventDefault();
    const divider = event.currentTarget;
    // A side-by-side split is stacked on a narrow page: there the divider lies flat and moves up and down.
    const bounds = box.getBoundingClientRect();
    const bar = divider.getBoundingClientRect();
    const vertical = column || (bar.height <= 12 && bar.width > 12);
    try {
      divider.setPointerCapture?.(event.pointerId);
    } catch {
      // a pointer that is already gone cannot be captured; the window listeners below still end the drag
    }
    setDragging(true);
    const onMove = (move: PointerEvent) => {
      const size = vertical ? bounds.height : bounds.width;
      if (size > 0) setMoved(clamp(((vertical ? move.clientY - bounds.top : move.clientX - bounds.left)) / size));
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? clamp(fraction - STEP)
      : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? clamp(fraction + STEP)
      : event.key === 'Home' ? MIN
      : event.key === 'End' ? MAX
      : event.key === 'Enter' ? null
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setMoved(next);
  };

  return (
    <div
      className={css.split}
      ref={root}
      data-dir={column ? 'col' : 'row'}
      data-sized={props.size ? '' : undefined}
      data-dragging={dragging || undefined}
      style={vars({'--a': `${fraction}fr`, '--b': `${1 - fraction}fr`})}
    >
      <ArrangeContext.Provider value={null}>
        <div className={css.pane}>{child(props.start)}</div>
        <div
          className={css.divider}
          role="separator"
          tabIndex={0}
          aria-orientation={column ? 'horizontal' : 'vertical'}
          aria-label="Resize panes"
          aria-valuemin={MIN * 100}
          aria-valuemax={MAX * 100}
          aria-valuenow={Math.round(fraction * 100)}
          onPointerDown={onPointerDown}
          onDoubleClick={() => setMoved(null)}
          onKeyDown={onKeyDown}
        />
        <div className={css.pane}>{child(props.end)}</div>
      </ArrangeContext.Provider>
    </div>
  );
};

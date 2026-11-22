// The zoom bar every diagram draws: how much of it is in view, the zoom, and zoom out, zoom in, fit to view and actual
// size, with the same keys (+ - 0 1) on the focused drawing. One bar, so Graph, Flowchart, ERDiagram (flowkit) and
// SequenceDiagram zoom alike; each diagram does its own zoom arithmetic and places the bar.
import type {MouseEvent} from 'react';
import {Icon} from '../../../kit/index.ts';
import css from './ZoomBar.module.css';

/** As far in as the reader zooms. */
export const ZOOM_MAX = 2.5;
/** As far out as the controls go, unless everything only fits further out. */
export const ZOOM_MIN = 0.2;
/** One press of zoom in; zoom out divides by it. */
export const ZOOM_STEP = 1.25;
/** A bar narrower than this says "n/m" instead of "n of m in view". */
export const IN_VIEW_MIN_WIDTH = 520;
/** Room the bar takes on its right for the count, the zoom readout and the four buttons. */
export const ZOOM_BAR_ROOM = {wide: 300, narrow: 220} as const;

export interface ZoomActions {
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onReset: () => void;
}

/** Runs the zoom action a key stands for (+ or = in, - or _ out, 0 fit, 1 actual size); false for any other key. */
export function zoomKey(key: string, actions: ZoomActions): boolean {
  if (key === '+' || key === '=') actions.onZoomIn();
  else if (key === '-' || key === '_') actions.onZoomOut();
  else if (key === '0') actions.onFit();
  else if (key === '1') actions.onReset();
  else return false;
  return true;
}

/** How much of the drawing is in view, said while only part of it is. */
export interface InView {
  count: number;
  total: number;
  /** What is counted and how to see the rest, e.g. "nodes in view. Drag to pan". */
  title: string;
}

/**
 * The bar: `className` places it (flowkit over the bottom of its stage, SequenceDiagram under its scroller) and gives
 * it its height. The buttons are not tab stops: the keys work on the focused drawing.
 */
export function ZoomBar(p: ZoomActions & {zoom: number; width: number; inView?: InView; className?: string}) {
  // A double-click on a button is two zooms, never a double-click on the diagram behind it.
  const stop = (event: MouseEvent) => event.stopPropagation();
  const {inView} = p;
  return (
    <div className={`${css.bar} ${p.className ?? ''}`} role="toolbar" aria-label="Zoom">
      {inView ? (
        <span className={css.inView} data-in-view="" title={`${inView.count} of ${inView.total} ${inView.title}; Fit to view shows everything`}>
          {p.width >= IN_VIEW_MIN_WIDTH ? `${inView.count} of ${inView.total} in view` : `${inView.count}/${inView.total}`}
        </span>
      ) : null}
      <span className={css.zoom} data-zoom="">{Math.round(p.zoom * 100)}%</span>
      <button type="button" className={css.control} tabIndex={-1} aria-label="Zoom out" title="Zoom out (−)" onClick={p.onZoomOut} onDoubleClick={stop}><Icon name="zoom-out" /></button>
      <button type="button" className={css.control} tabIndex={-1} aria-label="Zoom in" title="Zoom in (+)" onClick={p.onZoomIn} onDoubleClick={stop}><Icon name="zoom-in" /></button>
      <button type="button" className={css.control} tabIndex={-1} aria-label="Fit to view" title="Fit to view (0)" onClick={p.onFit} onDoubleClick={stop}><Icon name="fit" /></button>
      <button type="button" className={css.control} tabIndex={-1} aria-label="Actual size" title="Actual size (1)" onClick={p.onReset} onDoubleClick={stop}><Icon name="reset" /></button>
    </div>
  );
}

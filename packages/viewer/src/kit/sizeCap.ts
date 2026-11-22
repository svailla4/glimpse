// packages/viewer/src/kit/sizeCap.ts  (owned by the viewer kit)
// Decision content-sized-plates: a plate's body takes its content's natural height, and the catalog's `size`
// prop is a MAXIMUM height, not a fixed one. A view reads that maximum, in px, with useSizeCap():
//   const cap = useSizeCap();
//   // a scroller that needs a definite height: min(content height, cap)
//   // a diagram: clamp(laid-out height x scale that fits the width, 140, cap)
// The steps are the ones implement() turns into the cell's --gl-h (SIZE_PX there is built from these numbers):
//   s 160, m 280, l 420, xl 640, fill = the viewport height minus the masthead (160 px), never under 420.
// Without a size step the cap is the family default: 640 for diagrams, 420 for everything else (what tables, file
// trees, JSON and code views have capped themselves at so far). Only the cell's own size step counts: a cell
// nested in a sized container without a size of its own gets its family default, as before content-sized-plates.
import {createContext, useContext, useSyncExternalStore} from 'react';

/** The catalog's size steps in px (`size` of the FRAME group and of Split). */
export const SIZE_STEPS = {s: 160, m: 280, l: 420, xl: 640} as const;
export type SizeStep = keyof typeof SIZE_STEPS | 'fill';
/** `size='fill'`: the viewport height minus this much (the masthead and the page's top padding)... */
export const FILL_OFFSET = 160;
/** ...and never less than this. */
export const FILL_MIN = 420;
/** The cap of a component without a size step, by family; DEFAULT_CAP for a family not listed. */
export const FAMILY_CAPS: Readonly<Record<string, number>> = {diagram: 640};
export const DEFAULT_CAP = 420;

/**
 * The maximum height in px for a component of `family` with the size step `size` (undefined: none), given the
 * viewport height (only `fill` reads it). Pure; useSizeCap() is this with the calling cell's values.
 */
export function sizeCap(size: string | undefined, family: string | undefined, viewportHeight: number): number {
  if (size === 'fill') return Math.max(FILL_MIN, Math.round(viewportHeight) - FILL_OFFSET);
  if (size !== undefined && Object.hasOwn(SIZE_STEPS, size)) return SIZE_STEPS[size as keyof typeof SIZE_STEPS];
  return (family !== undefined && Object.hasOwn(FAMILY_CAPS, family) ? FAMILY_CAPS[family] : undefined) ?? DEFAULT_CAP;
}

/** The size step and family of the cell a view renders in. implement() provides it; null outside a component. */
export interface SizeCell {size: SizeStep | undefined; family: string}
export const SizeCellContext = createContext<SizeCell | null>(null);

const subscribeViewport = (changed: () => void): (() => void) => {
  window.addEventListener('resize', changed);
  return () => window.removeEventListener('resize', changed);
};
const subscribeNothing = (): (() => void) => () => {};
const viewportHeight = (): number => window.innerHeight;
const noHeight = (): number => 0;

/**
 * The maximum height in px of the calling view (decision content-sized-plates; see the top of this file). Follows the window's
 * height for `size='fill'` (and only then listens to resizes). Outside a component (no cell): DEFAULT_CAP.
 */
export function useSizeCap(): number {
  const cell = useContext(SizeCellContext);
  const fill = cell?.size === 'fill';
  const height = useSyncExternalStore(fill ? subscribeViewport : subscribeNothing, fill ? viewportHeight : noHeight, noHeight);
  return sizeCap(cell?.size, cell?.family, height);
}

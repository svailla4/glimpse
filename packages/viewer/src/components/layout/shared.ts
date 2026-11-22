// packages/viewer/src/components/layout/shared.ts - what the layout containers have in common.

/** The `gap` prop: 0 / 8 / 20 / 32 px. */
const GAP_PX = {none: 0, s: 8, m: 20, l: 32} as const;
export type Gap = keyof typeof GAP_PX;

/** Gap in px for the prop value; `fallback` when the prop is omitted or not one of the four steps. */
export function gapPx(gap: string | undefined, fallback: number): number {
  return gap !== undefined && Object.hasOwn(GAP_PX, gap) ? GAP_PX[gap as Gap] : fallback;
}

/**
 * A bound text prop as text. A binding can resolve to anything (a number, an object, nothing at all): numbers are
 * shown, everything else that is not a string is no text, so a wrong binding never takes the container down.
 */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

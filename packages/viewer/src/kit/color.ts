// packages/viewer/src/kit/color.ts  (first version by WP0; owned by WP4; exported signatures are frozen)
// Colours are always CSS variables from styles/tokens.css, never hex values, so both themes work everywhere.

/** Categorical ink for a server-assigned slot: 1..8 -> 'var(--gl-cat-N)'; 0, missing or out of range -> the "other" ink. */
export function catVar(slot: number): string {
  return Number.isInteger(slot) && slot >= 1 && slot <= 8 ? `var(--gl-cat-${slot})` : 'var(--gl-cat-other)';
}

/** Sequential ramp step, low to high: 1..7 -> 'var(--gl-seq-N)' (rounded and clamped). */
export function seqVar(step: number): string {
  const n = Number.isFinite(step) ? Math.min(7, Math.max(1, Math.round(step))) : 1;
  return `var(--gl-seq-${n})`;
}

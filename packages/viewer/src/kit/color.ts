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

/** Number of categorical inks. A ninth category is "other" (design 8.3). */
export const CAT_SLOTS = 8;

const validSlot = (slot: unknown): slot is number => typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && slot <= CAT_SLOTS;

/** A category that is itself the remainder ("other", "Other", "other (7)", "(other)"): it wears the other ink, never a hue. */
export function isOtherKey(key: string): boolean {
  return /^\(?other\)?(?:\s*\(\d+\))?$/i.test(key.trim());
}

/**
 * Colour slots for the categories one component shows (design rule stable-category-colours). `keys` are the categories in order of first
 * appearance. A key the session already gave a slot (`known`, one table of /meta/slots) keeps it, so an entity wears
 * the same ink on every plate. Every other key takes the lowest slot that is still free in THIS component, in order
 * of first appearance, and only a category beyond the eight inks gets 0 (the "other" ink). `held` is what an earlier
 * call returned for the same component: a key keeps the fallback slot it was given while that slot is still free, so
 * colours do not move when rows are added, paged or re-sorted. Categories named "other" are always 0.
 */
export function assignSlots(keys: Iterable<string>, known?: Readonly<Record<string, number>> | null, held?: ReadonlyMap<string, number> | null): Map<string, number> {
  const order = [...new Set(keys)];
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  const give = (key: string, slot: number) => {
    slots.set(key, slot);
    if (slot !== 0) taken.add(slot);
  };
  for (const key of order) {
    if (isOtherKey(key)) give(key, 0);
    else {
      const slot = known && Object.hasOwn(known, key) ? known[key] : undefined;
      if (validSlot(slot) && !taken.has(slot)) give(key, slot);
    }
  }
  for (const key of order) {
    if (slots.has(key)) continue;
    const slot = held?.get(key);
    if (validSlot(slot) && !taken.has(slot)) give(key, slot);
  }
  let next = 1;
  for (const key of order) {
    if (slots.has(key)) continue;
    while (taken.has(next)) next++;
    give(key, next <= CAT_SLOTS ? next : 0);
  }
  return slots;
}

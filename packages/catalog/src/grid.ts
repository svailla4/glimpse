// packages/catalog/src/grid.ts
// Grid's `cols`, read one way by the server and the viewer. Grid draws a count ('3') or a ratio ('2:1'); an author
// often writes the CSS or the prose for it instead ('2fr 1fr', '50% 50%', 'two'). The server writes what it guessed
// as a `fixed` line and what it cannot read as a `warn` line (spec/expand.ts); the viewer draws the same guess and
// reports W_COLS for what reached the tab unread (components/layout/Grid.tsx).

/** The most tracks a Grid draws. */
export const MAX_TRACKS = 12;

const WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** A count, also as a word or with its noun ('3', 'three', '3 columns'), or CSS 'repeat(3, 1fr)'. */
const COUNT = /^(?:(\d+|[a-z]+)(?:\s*col(?:umn)?s?)?|repeat\(\s*(\d+)\s*,\s*1fr\s*\))$/;
/** Between the weights of a ratio: ':' as Grid reads it, or what CSS and lists use. */
const SEPARATOR = /\s*[:,/;|]\s*|\s+/;
/** One weight: a positive number, bare, in fr or in percent. */
const WEIGHT = /^(\d+(?:\.\d+)?|\.\d+)(fr|%)?$/;

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * `cols` as Grid reads it: a count from 1 to 12 or a ratio like '2:1'. A guess is written in that form ('2fr 1fr',
 * '2,1', '2 1' and '2/1' are '2:1', '50% 50%' is '1:1', 'two' and '3 columns' are counts, a count over 12 is 12).
 * undefined when it is neither.
 */
export function normalizeCols(cols: string): string | undefined {
  const text = cols.trim().toLowerCase();
  const count = COUNT.exec(text);
  if (count) {
    const word = (count[1] ?? count[2])!;
    const n = /^\d+$/.test(word) ? Number(word) : WORDS.indexOf(word) + 1;
    if (n >= 1) return String(Math.min(n, MAX_TRACKS));
  }
  const weights = text.split(SEPARATOR).map(part => WEIGHT.exec(part));
  if (weights.length < 2 || weights.length > MAX_TRACKS || weights.some(weight => !weight || !(Number(weight[1]) > 0))) return undefined;
  const units = new Set(weights.map(weight => weight![2] ?? ''));
  if (units.size > 1) return undefined;
  const written = weights.map(weight => weight![1]!);
  // Percentages are shares of 100: '50% 50%' is the ratio 1:1.
  if (units.has('%') && written.every(weight => /^\d+$/.test(weight))) {
    const d = written.map(Number).reduce(gcd);
    return written.map(weight => Number(weight) / d).join(':');
  }
  return written.join(':');
}

/** The track weights Grid draws for `cols` ('2:1' is [2, 1], '3' is [1, 1, 1]); undefined when it cannot be read. */
export function parseCols(cols: string | undefined): number[] | undefined {
  const meant = cols === undefined ? undefined : normalizeCols(cols);
  if (meant === undefined) return undefined;
  return meant.includes(':') ? meant.split(':').map(Number) : new Array<number>(Number(meant)).fill(1);
}

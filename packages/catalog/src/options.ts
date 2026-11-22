// Ask's options (decision ask-options-carry-notes): a list whose entries are a label, or {label, note} where the note
// says what picking that option means or costs. Read the same way by the server (a `warn` line) and the tab (W_OPTIONS),
// so they agree on what draws (rule: the server and the viewer share pure functions from the catalog). Kept out of
// notation.ts, which the eager script would then bundle whole: Ask is in the eager content chunk.

export interface AskOption { label: string; note?: string }

/** What an author writes for Ask.options. */
export type AskOptionsValue = Array<string | AskOption>;

export interface OptionProblem {
  /** 1-based entry, or 0 for the value as a whole. */
  option: number;
  type: 'shape' | 'dropped' | 'ignored';
  message: string;
}

/** A key read under the name it was plainly meant as (`description` -> `note`): a `fixed` line on the server. */
export interface OptionRename { option: number; from: string; to: 'label' | 'note' }

export interface ReadOptions { options: AskOption[]; problems: OptionProblem[]; renamed: OptionRename[] }

/** Keys read as the label or the note, in order: the first is the documented one. */
const LABEL_KEYS = ['label', 'title', 'text', 'name', 'value'] as const;
const NOTE_KEYS = ['note', 'description', 'detail', 'details', 'why', 'cost'] as const;
const READ_KEYS: ReadonlySet<string> = new Set<string>([...LABEL_KEYS, ...NOTE_KEYS]);
const ITEM_HINT = "'label' or {label, note?}";
const MAX_CLIP = 40;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clip = (text: string) => (text.length > MAX_CLIP ? `${text.slice(0, MAX_CLIP - 1)}…` : text);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'string' ? `"${clip(value)}"` : typeof value === 'object' ? 'an object' : `${typeof value} ${String(value)}`;

/**
 * Ask.options as the options drawn. Never throws: each entry is judged on its own. An entry with no label, an empty
 * one and a repeat of an earlier label are not drawn; keys of an entry that are not read are said; each is a problem.
 */
export function readOptions(value: unknown): ReadOptions {
  const options: AskOption[] = [];
  const problems: OptionProblem[] = [];
  const renamed: OptionRename[] = [];
  if (value === undefined || value === null) return {options, problems, renamed};
  if (!Array.isArray(value)) {
    problems.push({option: 0, type: 'shape', message: `expected a list [${ITEM_HINT}], received ${describe(value)}`});
    return {options, problems, renamed};
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    const option = i + 1;
    const labelKey = isRecord(item) ? LABEL_KEYS.find(key => textOf(item[key])) : undefined;
    const label = isRecord(item) ? (labelKey ? textOf(item[labelKey]) : undefined) : textOf(item);
    if (!label) {
      problems.push({option, type: 'dropped', message: isRecord(item) ? `no label: expected ${ITEM_HINT}` : `expected ${ITEM_HINT}, received ${describe(item)}`});
      return;
    }
    if (seen.has(label)) {
      problems.push({option, type: 'dropped', message: `"${clip(label)}" repeats an earlier option`});
      return;
    }
    seen.add(label);
    if (!isRecord(item)) {
      options.push({label});
      return;
    }
    const noteKey = NOTE_KEYS.find(key => textOf(item[key]));
    const note = noteKey ? textOf(item[noteKey]) : undefined;
    if (labelKey && labelKey !== 'label') renamed.push({option, from: labelKey, to: 'label'});
    if (noteKey && noteKey !== 'note') renamed.push({option, from: noteKey, to: 'note'});
    // A key the label or note was not taken from (a second label or note key) is not read: said like any other.
    const ignored = Object.keys(item).filter(key => !READ_KEYS.has(key) || (key !== labelKey && key !== noteKey && textOf(item[key]) !== undefined));
    if (ignored.length > 0) problems.push({option, type: 'ignored', message: `ignored ${ignored.length === 1 ? 'key' : 'keys'} ${ignored.slice(0, 6).join(', ')} of option "${clip(label)}"`});
    options.push(note ? {label, note} : {label});
  });
  return {options, problems, renamed};
}

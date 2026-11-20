// Coercion and entity helpers shared by the content views. Data is agent- or analyzer-written: nothing here trusts it.
import type {EntityRef, EntityType, FieldKind, Tone} from '@glimpse/catalog';

// The entity a FileLoc names (a file, or a directory when the path ends with a slash) is the kit's definition, and
// so is the rule that marks an entity as selected (marksSelection, design 5.1).
export {fileEntity} from '../../../kit/index.ts';

/** 'array', 'null', 'string' ...: the word a redline uses for what it received. */
export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Message of an E_SHAPE redline (design 5.1: state expected and received). */
export function shapeMessage(expected: string, received: unknown): string {
  return `expected ${expected}, received ${typeName(received)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- {label, value} items (finding V002) ----
// KeyValue and Stats both draw labelled values, and a model writes either one with the other's shape. So both read
// the label from `label`, `name`, `key`, `k` or `title` and the value from `value` or `v`, as well as the object form
// {Label: value}. A dataset's roles (label, value) come first.
const LABEL_KEYS = ['label', 'name', 'key', 'k', 'title'] as const;
const VALUE_KEYS = ['value', 'v'] as const;

export interface LabelValue {
  /** The key holding the label, when the item has one. */
  labelKey?: string;
  /** The key holding the value, when the item has one. */
  valueKey?: string;
}

/** Which keys of a record hold its label and its value; `roles` (a dataset's roles.label / roles.value) are tried first. */
export function labelValueKeys(item: Record<string, unknown>, roles?: {label?: unknown; value?: unknown}): LabelValue {
  const pick = (role: unknown, names: readonly string[]) => {
    if (typeof role === 'string' && Object.hasOwn(item, role)) return role;
    return names.find(name => Object.hasOwn(item, name) && item[name] !== undefined);
  };
  const labelKey = pick(roles?.label, LABEL_KEYS);
  const valueKey = pick(roles?.value, VALUE_KEYS.filter(name => name !== labelKey));
  return {...(labelKey ? {labelKey} : {}), ...(valueKey && valueKey !== labelKey ? {valueKey} : {})};
}

/** A record that is one {label, value} item rather than a map of labels to values. */
export function isLabelValueItem(item: Record<string, unknown>): boolean {
  const {labelKey, valueKey} = labelValueKeys(item);
  return labelKey !== undefined && valueKey !== undefined && Object.keys(item).every(key => key === labelKey || key === valueKey || STAT_EXTRAS.has(key));
}
const STAT_EXTRAS: ReadonlySet<string> = new Set(['unit', 'delta', 'spark', 'format', 'tone']);

/**
 * What the data looked like, for a message that names the accepted shapes: `[{foo, bar}]`, `[number]`, `{}` or `[]`.
 * Only keys and type names are printed, never values.
 */
export function shapeHint(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    const record = data.find(isRecord);
    if (record) {
      const keys = Object.keys(record);
      return `[{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}]`;
    }
    const item = data.find(value => value !== null && value !== undefined);
    return `[${item === undefined ? 'null' : typeName(item)}]`;
  }
  if (isRecord(data)) return Object.keys(data).length === 0 ? '{}' : 'an object';
  return typeName(data);
}

/** Display text of any cell: strings as they are, primitives printed, objects as compact JSON; '' for null. */
export function cellText(value: unknown, max = 160): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    json = String(value);
  }
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

const ENTITY_KINDS: Partial<Record<FieldKind, EntityType>> = {module: 'module', symbol: 'symbol', author: 'author', commit: 'commit'};
/** The entity a non-file cell names (module, symbol, author, commit), by its field kind. */
export function cellEntity(kind: FieldKind | undefined, value: string): EntityRef | undefined {
  const type = kind ? ENTITY_KINDS[kind] : undefined;
  return type && value ? {type, id: value, label: value} : undefined;
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?|json[c5]?|md|mdx|py|go|rs|java|kt|kts|rb|cs|php|swift|dart|c|h|cc|cpp|hpp|css|scss|less|html?|ya?ml|toml|sql|sh|bash|zsh|lock|txt|xml|vue|svelte|proto|gradle|tf|ini|cfg|conf|env)$/i;
const LINE_SUFFIX = /#L\d+(?:-L?\d+)?$/;
/**
 * Whether a bare string value names a repo path (KeyValue values, sniffed list rows). Deliberately strict: 'Node.js',
 * 'example.com', 'TCP/IP' and '1.4.0' are text. A path has no spaces or scheme and either sits in a directory and has
 * an extension, ends with a slash, carries a #L suffix, or is a conventionally named top-level file.
 */
export function looksLikePath(value: string): boolean {
  if (value.length < 3 || value.length > 400 || /\s|:\/\/|^[#/]|\/\//.test(value)) return false;
  if (LINE_SUFFIX.test(value)) return true;
  if (value.includes('/')) return value.endsWith('/') ? /^[\w@.-]+(?:\/[\w@.+-]+)*\/$/.test(value) : /\/[^/]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(value);
  return CODE_EXT.test(value) && (/^[a-z0-9_.-]+$/.test(value) || /^[A-Z][A-Z0-9_-]*\.[a-z0-9]+$/.test(value));
}

const TONE_VARS: Record<Tone, string | undefined> = {
  neutral: undefined,
  good: 'var(--gl-good)',
  warn: 'var(--gl-warning)',
  bad: 'var(--gl-critical)',
  info: 'var(--gl-info)',
};
const TONE_WORDS: Record<Tone, string> = {neutral: 'neutral', good: 'good', warn: 'warning', bad: 'critical', info: 'info'};

/** Status ink and spoken word for a tone; undefined for neutral and for anything that is not a tone. */
export function toneMark(tone: unknown): {color: string; word: string} | undefined {
  if (typeof tone !== 'string' || !Object.hasOwn(TONE_VARS, tone)) return undefined;
  const color = TONE_VARS[tone as Tone];
  return color ? {color, word: TONE_WORDS[tone as Tone]} : undefined;
}

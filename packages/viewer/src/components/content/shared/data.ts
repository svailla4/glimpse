// Coercion and entity helpers shared by the content views. Data is agent- or analyzer-written: nothing here trusts it.
import {parseFileLoc, type EntityRef, type EntityType, type FieldKind, type FileLoc, type Tone} from '@glimpse/catalog';

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

/** The entity a FileLoc names: a file, or a directory when the path ends with a slash. */
export function fileEntity(file: FileLoc): EntityRef {
  const {path, line, endLine} = parseFileLoc(file);
  const dir = path.length > 1 && path.endsWith('/');
  const clean = dir ? path.replace(/\/+$/, '') : path;
  const entity: EntityRef = {type: dir ? 'dir' : 'file', id: clean, path: clean};
  if (line != null) entity.line = line;
  if (endLine != null) entity.endLine = endLine;
  return entity;
}

const ENTITY_KINDS: Partial<Record<FieldKind, EntityType>> = {module: 'module', symbol: 'symbol', author: 'author', commit: 'commit'};
/** The entity a non-file cell names (module, symbol, author, commit), by its field kind. */
export function cellEntity(kind: FieldKind | undefined, value: string): EntityRef | undefined {
  const type = kind ? ENTITY_KINDS[kind] : undefined;
  return type && value ? {type, id: value, label: value} : undefined;
}

/**
 * Design 5.1: a mark is highlighted when it is the selection (same type and id), when it is a file inside the
 * selected directory, or when its path is the selected file.
 */
export function matchesSelection(selected: EntityRef | null, entity: Pick<EntityRef, 'type' | 'id' | 'path'> | undefined): boolean {
  if (!selected || !entity) return false;
  if (selected.type === entity.type && selected.id === entity.id) return true;
  if (!entity.path) return false;
  if (selected.type === 'dir') {
    const dir = (selected.path ?? selected.id).replace(/\/+$/, '');
    return dir === '' || entity.path === dir || entity.path.startsWith(`${dir}/`);
  }
  return selected.type === 'file' && (selected.path ?? selected.id) === entity.path;
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

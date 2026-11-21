// EventQueue (design 2.7): what the user did in the tab, as the one-line strings the model reads. Everything that
// reaches the model from the viewer passes through the formatters here: a fixed `viewer:` prefix, JSON-escaped values
// and a length cap, so text typed or rendered in the tab cannot pose as an instruction or break the line format.
import {formatFileLoc, type EntityRef} from '@glimpse/catalog';
import {escapeInvisible, escapeSeparators, jsonQuote} from '../spec/errors.ts';
import {ReportStore} from './reports.ts';

export const MAX_EVENTS = 100;
const MAX_VALUE = 300;
const PREFIX = 'viewer:';

const clip = (text: string, max = MAX_VALUE) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/**
 * A value printed bare when it is a plain ASCII token (a path, a sha, a name without spaces), else JSON-escaped with
 * every invisible or direction-changing character written out (finding V016).
 */
function token(value: unknown, max = MAX_VALUE): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return /^[\w@./#:~+-]+$/.test(text) ? clip(text, max) : jsonQuote(clip(text, max));
}

const name = (value: string) => value.replace(/[^\w.-]/g, '_').slice(0, 64) || '_';

/**
 * `viewer: select file src/hub/hub.ts#L41-58 (overview)`. A file, symbol or row with a path is named by its place; any
 * other entity by its id. A symbol, node, row or message also says its label, unless the id already does
 * (`select node orders`, `select row tiers:Data stores`); a node with a file says where it is (decision D24):
 * `viewer: select node PG Postgres db/schema.sql#L1-120 (arch)`. The node ids a selection stands for (`nodes`) are
 * not printed: the model wrote those links.
 */
export function selectLine(ref: EntityRef, surfaceId: string): string {
  const loc = ref.path !== undefined
    ? formatFileLoc({path: ref.path, ...(ref.line !== undefined ? {line: ref.line} : {}), ...(ref.endLine !== undefined ? {endLine: ref.endLine} : {})})
    : undefined;
  const where = loc !== undefined && (ref.type === 'file' || ref.type === 'symbol' || ref.type === 'row') ? loc : ref.id;
  const named = ref.type === 'symbol' || ref.type === 'node' || ref.type === 'row' || ref.type === 'message';
  // Only an id can already say the label: a place ('src/a.ts#L8') says where, never what (a symbol 'a' is still named).
  const said = where === ref.id && ref.label !== undefined && ref.id.includes(ref.label);
  const label = named && ref.label && !said ? ` ${token(ref.label, 80)}` : '';
  const at = ref.type === 'node' && loc !== undefined ? ` ${token(loc)}` : '';
  return `${PREFIX} select ${name(String(ref.type))} ${token(where)}${label}${at} (${name(surfaceId)})`;
}

/** `viewer: press plan approve {"plan":1}` / `viewer: answer feature store {"choice":"Redis"}` */
export function actionLine(verb: 'press' | 'answer' | 'event', surfaceId: string, action: string, context: unknown): string {
  let json = '';
  if (typeof context === 'object' && context !== null && Object.keys(context).length > 0) {
    json = JSON.stringify(context);
    json = json.length > MAX_VALUE ? jsonQuote(clip(json)) : escapeSeparators(escapeInvisible(json, true));
  }
  return `${PREFIX} ${verb} ${name(surfaceId)} ${name(action)}${json ? ' ' + json : ''}`;
}

export {reportLine, reportText} from './reports.ts';

interface Entry { line: string; selection: boolean }

export class EventQueue {
  private entries: Entry[] = [];
  private waiters = new Set<() => void>();
  /**
   * Decision D14: what the tabs said about each component, in a store of its own. It never takes a place in the
   * queue, so a flood of reports cannot push out a press; its untold problems follow the queued lines on delivery.
   */
  readonly reports = new ReportStore(() => this.wakeAll());

  /** Queues an action for the agent. Beyond MAX_EVENTS the oldest entry is dropped. */
  push(line: string): void {
    this.add({line, selection: false});
  }

  /** The current selection replaces an undelivered earlier one; null withdraws it. */
  select(line: string | null): void {
    this.entries = this.entries.filter(entry => !entry.selection);
    if (line !== null) this.add({line, selection: true});
  }

  private add(entry: Entry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_EVENTS) this.entries.splice(0, this.entries.length - MAX_EVENTS);
    this.wakeAll();
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Lines waiting: queued events and render problems not told yet. */
  get size(): number {
    return this.entries.length + this.reports.pending;
  }

  /**
   * Delivers pending lines, oldest first, and forgets them: the queued events, then the render problems not told yet
   * (decision D14). With `maxChars` (the prompt hook), only as many whole event lines as fit are delivered (always at
   * least one), the rest stay queued, and render problems wait for the next tool result.
   */
  drain(maxChars = Infinity): string[] {
    const lines: string[] = [];
    let used = 0;
    while (this.entries.length > 0) {
      const next = this.entries[0]!.line;
      if (lines.length > 0 && used + next.length + 1 > maxChars) break;
      lines.push(maxChars === Infinity ? next : clip(next, maxChars));
      used += next.length + 1;
      this.entries.shift();
    }
    return maxChars === Infinity ? [...lines, ...this.reports.drainLines()] : lines;
  }

  /** Resolves when something is pending, after `ms`, or when the signal aborts, whichever is first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.size > 0 || ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, {once: true});
    });
  }

  /** Releases every waiter (shutdown). */
  close(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

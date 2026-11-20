// EventQueue (design 2.7): what the user did in the tab, as the one-line strings the model reads. Everything that
// reaches the model from the viewer passes through the formatters here: a fixed `viewer:` prefix, JSON-escaped values
// and a length cap, so text typed or rendered in the tab cannot pose as an instruction or break the line format.
import {formatFileLoc, type EntityRef} from '@glimpse/catalog';
import {oneLine} from '../spec/errors.ts';

export const MAX_EVENTS = 100;
const MAX_VALUE = 300;
const PREFIX = 'viewer:';

const clip = (text: string, max = MAX_VALUE) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/** A value printed bare when it is a plain token (a path, a sha, a name without spaces), else JSON-escaped. */
function token(value: unknown, max = MAX_VALUE): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return /^[\w@./#:~+-]+$/.test(text) ? clip(text, max) : JSON.stringify(clip(text, max));
}

const name = (value: string) => value.replace(/[^\w.-]/g, '_').slice(0, 64) || '_';

/** `viewer: select file src/hub/hub.ts#L41-58 (overview)` */
export function selectLine(ref: EntityRef, surfaceId: string): string {
  const where = ref.path !== undefined && (ref.type === 'file' || ref.type === 'symbol' || ref.type === 'row')
    ? formatFileLoc({path: ref.path, ...(ref.line !== undefined ? {line: ref.line} : {}), ...(ref.endLine !== undefined ? {endLine: ref.endLine} : {})})
    : ref.id;
  const label = ref.type === 'symbol' && ref.label ? ` ${token(ref.label, 80)}` : '';
  return `${PREFIX} select ${name(String(ref.type))} ${token(where)}${label} (${name(surfaceId)})`;
}

/** `viewer: press plan approve {"plan":1}` / `viewer: answer feature store {"choice":"Redis"}` */
export function actionLine(verb: 'press' | 'answer' | 'event', surfaceId: string, action: string, context: unknown): string {
  let json = '';
  if (typeof context === 'object' && context !== null && Object.keys(context).length > 0) {
    json = JSON.stringify(context);
    if (json.length > MAX_VALUE) json = JSON.stringify(clip(json));
  }
  return `${PREFIX} ${verb} ${name(surfaceId)} ${name(action)}${json ? ' ' + json : ''}`;
}

/**
 * `viewer: error overview DataTable#impact E_SHAPE expected an array of rows, received an object`: what a tab drew
 * in place of a component (decision D3). The text comes from the viewer and may quote the repository, so it is
 * flattened to one line and capped like every other value here.
 */
export function reportLine(surfaceId: string, component: string, code: string, message: string): string {
  return `${PREFIX} error ${name(surfaceId)} ${reportText(component, code, message)}`;
}

/** `DataTable#impact: E_SHAPE expected an array of rows, received an object`, the form a `warn` line carries. */
export function reportText(component: string, code: string, message: string): string {
  const flat = oneLine(message, 200);
  return `${component.replace(/[^\w#.-]/g, '_').slice(0, 80)}: ${name(code)} ${clip(flat, 200)}`.trim();
}

interface Entry { line: string; selection: boolean; /** Reports: `<surface>\u0000<component>`, replaced by a newer report of the same component. */ report?: {surfaceId: string; component: string; text: string} }

export class EventQueue {
  private entries: Entry[] = [];
  private waiters = new Set<() => void>();

  /** Queues an action for the agent. Beyond MAX_EVENTS the oldest entry is dropped. */
  push(line: string): void {
    this.add({line, selection: false});
  }

  /** Queues what a tab reported about one component; an undelivered earlier report of that component is replaced. */
  report(surfaceId: string, component: string, code: string, message: string): void {
    this.entries = this.entries.filter(entry => !(entry.report && entry.report.surfaceId === surfaceId && entry.report.component === component));
    this.add({line: reportLine(surfaceId, component, code, message), selection: false, report: {surfaceId, component, text: reportText(component, code, message)}});
  }

  /** Takes the undelivered reports of a surface out of the queue (a `show` prints them as `warn` lines instead). */
  takeReports(surfaceId: string): string[] {
    const taken = this.entries.filter(entry => entry.report?.surfaceId === surfaceId).map(entry => entry.report!.text);
    if (taken.length > 0) this.entries = this.entries.filter(entry => entry.report?.surfaceId !== surfaceId);
    return taken;
  }

  /**
   * Forgets the undelivered reports of a surface (it was replaced or closed); with `only`, just those of the
   * components with these ids (a replace in place keeps the reports of the components it did not change).
   */
  dropReports(surfaceId: string, only?: ReadonlySet<string>): void {
    const drops = (report: NonNullable<Entry['report']>) => report.surfaceId === surfaceId && (only === undefined || only.has(report.component.slice(report.component.indexOf('#') + 1)));
    this.entries = this.entries.filter(entry => !entry.report || !drops(entry.report));
  }

  /** How many reports are waiting for a surface. */
  reportsFor(surfaceId: string): number {
    return this.entries.filter(entry => entry.report?.surfaceId === surfaceId).length;
  }

  /** The current selection replaces an undelivered earlier one; null withdraws it. */
  select(line: string | null): void {
    this.entries = this.entries.filter(entry => !entry.selection);
    if (line !== null) this.add({line, selection: true});
  }

  private add(entry: Entry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_EVENTS) this.entries.splice(0, this.entries.length - MAX_EVENTS);
    for (const wake of [...this.waiters]) wake();
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Delivers pending lines, oldest first, and forgets them. With `maxChars`, only as many whole lines as fit are
   * delivered (always at least one) and the rest stay queued.
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
    return lines;
  }

  /** Resolves when something is pending, after `ms`, or when the signal aborts, whichever is first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.entries.length > 0 || ms <= 0 || signal?.aborted) return Promise.resolve();
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

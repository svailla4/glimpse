// packages/viewer/src/kit/report.ts
// What a component draws, told to the host as the component's CURRENT state (decision reports-are-component-state; codes in
// packages/catalog/src/transport.ts). One holder per component cell collects what its view puts on screen in place of
// content (an Empty, a Redline, a problem the view names while it still draws) and sends ONE state for the component:
//   I_*  a truthful empty or waiting state (the dataset says why it is empty, the view waits for a selection)
//   W_*  the component could not draw what the spec asked (nothing bound, empty inline data, unknown field, shape)
//   E_*  a redline
//   OK   none of these: the component draws normally. Withdraws whatever was said before.
// The state is sent when the cell mounts, whenever it changes, and again (OK included) each time an update
// (re)defines the component, so the host can forget what it knew at every definition and still hear the truth.
// W_* and E_* reach the host as A2UI renderer errors; I_* and OK, which are not errors, as Glimpse states (only-problems-are-errors).
// Only component-level states count: whatever renders inside <Subpart> (a borrowed view, one file of a diff, one stop
// of a tour) never speaks for the component.
import {REPORT_OK} from '@glimpse/catalog';
import {createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode} from 'react';

/**
 * One state of one component. The shell posts a problem (W_*, E_*) as an A2UI v1.0 renderer `error` message and any
 * other state (I_*, OK) as a Glimpse ComponentState (decision only-problems-are-errors).
 */
export interface RenderReport {
  /** 'OK', or an I_*, W_* or E_* code. */
  code: string;
  /** `Name#id: text`, the message of the `error`. */
  message: string;
  surfaceId: string;
  /** The catalog name and the id of the component the state belongs to, and the text of the state. */
  name: string;
  componentId: string;
  text: string;
}

/** Where states go. The shell provides one (KitProvider `report` and `watch`); tests provide their own. */
export interface ReportChannel {
  report(report: RenderReport): void;
  /**
   * Calls `redefined` each time an update names component `componentId` of surface `surfaceId` again (an
   * updateComponents the viewer applied), whether or not its properties changed. Returns the unsubscribe.
   */
  watch?(surfaceId: string, componentId: string, redefined: () => void): () => void;
}
export const ReportContext = createContext<ReportChannel | null>(null);

/** States a view can name. Views pass one as `code` to <Empty> when the default (W_EMPTY) is not what happened. */
export const REPORT_CODES = {
  /** The data is empty and the source says why (no import cycles, a clean working tree). */
  truthful: 'I_EMPTY',
  /** The view follows the selection and nothing is selected yet. */
  waiting: 'I_WAITING',
  /** Bound or inline data is missing or empty. The default of <Empty>. */
  empty: 'W_EMPTY',
  /** A field the spec names is not in the data. */
  field: 'W_FIELD',
} as const;

type Entry = {pending: true} | {pending?: false; code: string; message: string};

const SEVERITY = (code: string) => (code.startsWith('E_') ? 3 : code.startsWith('W_') ? 2 : 1);
/** A code the host accepts (`^[A-Z][A-Z0-9_]{1,31}$`) with a class prefix; anything without one is a redline. */
export function reportCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const prefixed = /^[EWI]_[A-Z0-9_]/.test(clean) || clean === REPORT_OK ? clean : `E_${clean.replace(/^_+/, '') || 'RENDER'}`;
  return prefixed.slice(0, 32);
}

/** Most severe first; among equals, the first one put. undefined: nothing but pending entries (or nothing at all). */
function pick(entries: Iterable<Entry>): {code: string; message: string} | 'pending' | undefined {
  let best: {code: string; message: string} | undefined;
  let pending = false;
  for (const entry of entries) {
    if (entry.pending) pending = true;
    else if (!best || SEVERITY(entry.code) > SEVERITY(best.code)) best = entry;
  }
  return best ?? (pending ? 'pending' : undefined);
}

/**
 * The report holder of one component cell. States put into it are coalesced to the end of the current task
 * (a microtask), so the switch from one state to another inside a commit is one report, not two.
 */
export class CellReporter {
  private readonly entries = new Map<object, Entry>();
  private sent: string | undefined;
  /** Send the next settled state even when it is the one already sent: the cell mounted or was redefined. */
  private force = true;
  private queued = false;
  private alive = true;
  readonly label: string;
  private readonly name: string;
  private readonly componentId: string;
  readonly surfaceId: string;
  /** Where the reports go; the provider may hand over a new channel object between renders. */
  channel: ReportChannel;

  constructor(name: string, componentId: string, surfaceId: string, channel: ReportChannel) {
    this.label = `${name}#${componentId}`;
    this.name = name;
    this.componentId = componentId;
    this.surfaceId = surfaceId;
    this.channel = channel;
  }

  put(token: object, entry: Entry): void {
    this.entries.set(token, entry);
    this.schedule();
  }

  drop(token: object): void {
    if (this.entries.delete(token)) this.schedule();
  }

  /** The component was (re)defined: say what it shows now, even if that was said before. */
  redefined(): void {
    this.force = true;
    this.schedule();
  }

  /** The cell is on screen (again): what it shows next is sent even if it was said before. */
  attach(): void {
    this.alive = true;
    this.force = true;
    this.schedule();
  }

  /** The cell went away: nothing more is sent for it. Its component is not withdrawn: it is just not on screen. */
  detach(): void {
    this.alive = false;
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (!this.alive) return;
    const current = pick(this.entries.values());
    // Still drafting (a chunk or a dataset on its way): what it will show is not known yet.
    if (current === 'pending') return;
    const state = current ?? {code: REPORT_OK, message: 'ok'};
    const key = `${state.code}\n${state.message}`;
    if (!this.force && key === this.sent) return;
    this.force = false;
    this.sent = key;
    this.channel.report({
      code: state.code, message: `${this.label}: ${state.message}`, surfaceId: this.surfaceId, name: this.name, componentId: this.componentId, text: state.message,
    });
  }
}

/** The holder of the cell the calling view renders in; null outside a cell, inside a <Subpart>, or where nobody listens. */
export const CellReportContext = createContext<CellReporter | null>(null);

/**
 * Creates the holder of one cell (implement() calls it once per cell) and keeps it for the life of the cell. Each time
 * the shell says an update named the component again, the cell renders once more and its state is sent again after
 * that render has settled, OK included.
 */
export function useCellReporter(name: string, componentId: string, surfaceId: string | undefined): CellReporter | null {
  const channel = useContext(ReportContext);
  const [generation, setGeneration] = useState(0);
  const holder = useRef<CellReporter | null>(null);
  if (channel && surfaceId !== undefined) {
    const label = `${name}#${componentId}`;
    if (!holder.current || holder.current.label !== label || holder.current.surfaceId !== surfaceId) holder.current = new CellReporter(name, componentId, surfaceId, channel);
    else holder.current.channel = channel;
  } else holder.current = null;
  const reporter = holder.current;
  useEffect(() => {
    if (!reporter || !channel?.watch || surfaceId === undefined) return;
    return channel.watch(surfaceId, componentId, () => setGeneration(n => n + 1));
  }, [reporter, channel, surfaceId, componentId]);
  // Runs after the effects of everything inside the cell in the same commit (`generation` is the trigger): the states
  // they put are in.
  useEffect(() => {
    if (generation >= 0) reporter?.redefined();
  }, [reporter, generation]);
  useEffect(() => {
    if (!reporter) return;
    reporter.attach();
    return () => reporter.detach();
  }, [reporter]);
  return reporter;
}

/**
 * Puts one state of the calling view into its cell's holder while it is on screen: `code` and `message` (without the
 * `Name#id: ` prefix), or `pending` while it drafts. Nothing when `code` is undefined. Empty, Redline and Drafting
 * call it; a view that draws content but could not do everything the spec asked (a focus that matches no node, a
 * field that is not in the data, drawn with the default) calls it directly:
 *   useReportState(missing ? 'W_FOCUS' : undefined, `focus "${focus}" matches no node`);
 */
export function useReportState(code: string | undefined, message = '', pending = false): void {
  const reporter = useContext(CellReportContext);
  const token = useRef<object>({});
  useEffect(() => {
    if (!reporter || (code === undefined && !pending)) return;
    const own = token.current;
    reporter.put(own, pending ? {pending: true} : {code: reportCode(code!), message: message.replace(/\s+/g, ' ').trim()});
    return () => reporter.drop(own);
  }, [reporter, code, message, pending]);
}

/**
 * Marks what it wraps as a part of the component, not the component: an Empty, a Redline or a Drafting inside it is
 * drawn but never reported as the component's state (one binary file of a diff, one stop of a tour, a borrowed
 * Steps inside CodeTour). borrowView() wraps every borrowed view in it. A single state can say the same with
 * <Empty part /> or <Redline part />.
 */
export function Subpart(p: {children: ReactNode}): ReactNode {
  return createElement(CellReportContext.Provider, {value: null}, p.children);
}

/**
 * The `watch` half of a ReportChannel, for the shell and the test harness: cells subscribe, and whoever applies the
 * messages calls `applied(messages)` right after the processor took them. Every component an `updateComponents`
 * names is told, changed or not. A `createSurface` needs nothing: its cells mount and say their state anyway.
 */
export function createRedefinitions(): {watch: NonNullable<ReportChannel['watch']>; applied(messages: readonly unknown[]): void} {
  const watchers = new Map<string, Set<() => void>>();
  const key = (surfaceId: string, componentId: string) => `${surfaceId}\n${componentId}`;
  return {
    watch(surfaceId, componentId, redefined) {
      const k = key(surfaceId, componentId);
      const set = watchers.get(k) ?? new Set<() => void>();
      watchers.set(k, set);
      set.add(redefined);
      return () => {
        set.delete(redefined);
        if (set.size === 0) watchers.delete(k);
      };
    },
    applied(messages) {
      for (const message of messages) {
        const update = (message as {updateComponents?: {surfaceId?: unknown; components?: unknown}} | null)?.updateComponents;
        if (!update || typeof update.surfaceId !== 'string' || !Array.isArray(update.components)) continue;
        for (const component of update.components as Array<{id?: unknown} | null>) {
          if (typeof component?.id !== 'string') continue;
          for (const redefined of [...(watchers.get(key(update.surfaceId, component.id)) ?? [])]) redefined();
        }
      }
    },
  };
}

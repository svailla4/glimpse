// Render reports (decision D14): what a tab says about one component is that component's CURRENT state, kept here
// per (surface, component) and never in the event queue, so no number of reports can push out a press, an answer or
// a selection. A state is `OK`, `I_*` (a truthful empty or waiting state), `W_*` or `E_*`; only the last two are
// problems the model hears about, and each one once: in the result of the show that drew it, or else as one
// `viewer: error` line on a later result, if it is still the component's state when that result is written.
import {isProblemReport, REPORT_OK} from '@glimpse/catalog';
import {oneLine} from '../spec/errors.ts';

export interface ComponentState {
  code: string;
  message: string;
  /** The model has this state (or a warning about the same component), so it is not delivered again. */
  told: boolean;
}

/** Report lines one result carries before the rest of a surface's problems fold into a count. */
export const MAX_REPORT_LINES = 8;
const MAX_TEXT = 200;

const name = (value: string) => value.replace(/[^\w.-]/g, '_').slice(0, 64) || '_';
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

/**
 * `viewer: error overview DataTable#impact: E_SHAPE expected an array of rows, received an object`: a problem a tab
 * reported about a component. The text comes from the viewer and may quote the repository, so it is flattened to one
 * line and capped like every other value of a `viewer:` line.
 */
export function reportLine(surfaceId: string, component: string, code: string, message: string): string {
  return `viewer: error ${name(surfaceId)} ${reportText(component, code, message)}`;
}

/** `DataTable#impact: E_SHAPE expected an array of rows, received an object`, the form a `warn` line carries. */
export function reportText(component: string, code: string, message: string): string {
  return `${component.replace(/[^\w#.-]/g, '_').slice(0, 80)}: ${name(code)} ${clip(oneLine(message, MAX_TEXT), MAX_TEXT)}`.trim();
}

/** `viewer: error big (+112 more parts could not be drawn)` */
export const foldLine = (surfaceId: string, count: number): string => `viewer: error ${name(surfaceId)} (+${count} more parts could not be drawn)`;

/** `DataTable#impact` -> `impact` */
const idOf = (component: string) => component.slice(component.indexOf('#') + 1);

export class ReportStore {
  private surfaces = new Map<string, Map<string, ComponentState>>();
  /**
   * Per surface, the components a show already warned about in its own words (a missing file, a wrong kind): what the
   * tab later draws there is the same problem, so it is kept as told until the component is defined again.
   */
  private warned = new Map<string, Set<string>>();
  private wake: () => void;

  constructor(wake: () => void = () => {}) {
    this.wake = wake;
  }

  /**
   * Records the state a tab reports for `component` (`Name#id`). The same state again changes nothing, so a second
   * tab or a reload does not deliver it twice; a different one replaces it and is news when it is a problem.
   * `quiet` records a problem as already told (a state the model has no part in, such as an empty part of a preset).
   */
  set(surfaceId: string, component: string, code: string, message: string, quiet = false): void {
    const states = this.surfaces.get(surfaceId) ?? new Map<string, ComponentState>();
    this.surfaces.set(surfaceId, states);
    const previous = states.get(component);
    if (previous && previous.code === code && previous.message === message) return;
    if (code === REPORT_OK && !previous) return;
    const problem = isProblemReport(code);
    const silent = quiet || this.warned.get(surfaceId)?.has(component) === true;
    states.set(component, {code, message, told: silent || !problem});
    if (problem && !silent) this.wake();
  }

  /** The state last reported for a component, if any. */
  get(surfaceId: string, component: string): ComponentState | undefined {
    return this.surfaces.get(surfaceId)?.get(component);
  }

  /** Components of a surface with a stored state. */
  size(surfaceId: string): number {
    return this.surfaces.get(surfaceId)?.size ?? 0;
  }

  /**
   * Forgets the states of a surface (it was replaced, closed or evicted), or with `ids`, of the components with those
   * ids (the ones a show defined again): the tab reports them afresh.
   */
  forget(surfaceId: string, ids?: Iterable<string>): void {
    if (ids === undefined) {
      this.surfaces.delete(surfaceId);
      this.warned.delete(surfaceId);
      return;
    }
    const gone = new Set(ids);
    const states = this.surfaces.get(surfaceId);
    for (const component of [...(states?.keys() ?? [])]) if (gone.has(idOf(component))) states!.delete(component);
    const warned = this.warned.get(surfaceId);
    for (const component of [...(warned ?? [])]) if (gone.has(idOf(component))) warned!.delete(component);
  }

  /**
   * The problems of one surface the model has not been told, as `Name#id: CODE message`, marked told. Components in
   * `skip` (the call already warns about them in other words) are marked told without being returned, and so is what
   * the tab reports about them later, until they are defined again.
   */
  take(surfaceId: string, skip: ReadonlySet<string> = new Set()): string[] {
    if (skip.size > 0) {
      const warned = this.warned.get(surfaceId) ?? new Set<string>();
      for (const component of skip) warned.add(component);
      this.warned.set(surfaceId, warned);
    }
    const out: string[] = [];
    for (const [component, state] of this.surfaces.get(surfaceId) ?? []) {
      if (state.told || !isProblemReport(state.code)) continue;
      state.told = true;
      if (!skip.has(component)) out.push(reportText(component, state.code, state.message));
    }
    return out;
  }

  /** Problems not told yet, over every surface. */
  get pending(): number {
    let count = 0;
    for (const states of this.surfaces.values()) for (const state of states.values()) if (!state.told && isProblemReport(state.code)) count++;
    return count;
  }

  /**
   * Every untold problem as a `viewer: error` line, marked told. At most MAX_REPORT_LINES lines: the rest of a
   * surface's problems are folded into one line that counts them.
   */
  drainLines(): string[] {
    const lines: string[] = [];
    for (const [surfaceId, states] of this.surfaces) {
      let folded = 0;
      for (const [component, state] of states) {
        if (state.told || !isProblemReport(state.code)) continue;
        state.told = true;
        if (lines.length < MAX_REPORT_LINES) lines.push(reportLine(surfaceId, component, state.code, state.message));
        else folded++;
      }
      if (folded > 0) lines.push(foldLine(surfaceId, folded));
    }
    return lines;
  }
}

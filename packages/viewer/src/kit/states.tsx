// packages/viewer/src/kit/states.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// The three non-ready looks every component shares, and the gate that picks one from a DataState.
// Frozen test hooks: each state root carries data-gl-state="drafting" | "empty" | "redline"; a redline also carries
// data-code. Tests and the e2e suite select on these, never on class names.
//
// What the person sees, the agent hears (design rule D3): an Empty and a Redline that stand in for a component
// report themselves to the host once (`W_EMPTY` or the redline code, message `Name#id: ...`), so a `show` result can
// say what the view really drew. Nothing is reported outside a component cell or where nobody listens.
import type {Dataset} from '@glimpse/catalog';
import type {JSX, ReactNode} from 'react';
import {useHostActions, useRenderReport, type DataState} from './hooks.ts';
import {Icon} from './icons.tsx';
import {PlateAside, PlateScope, useCell} from './implement.tsx';
import {Marginal, marginalText} from './marginal.tsx';

/** Pending: dashed construction frame with two diagonals at final size and a mono status line. Fills its box. */
export function Drafting(p: {label?: string}): JSX.Element {
  return (
    <div className="gl-state gl-drafting" data-gl-state="drafting" role="status" aria-busy="true">
      <svg className="gl-drafting-lines" aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
        <line x1="0" y1="0" x2="100" y2="100" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1="100" x2="100" y2="0" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="gl-state-line">{p.label ?? 'drafting'}</span>
    </div>
  );
}

/**
 * No data: a centred mono line that says why (the reason the dataset gives, else the binding or source), with an
 * optional dimmer second line (`detail`, usually the source). Outside a plate it draws its own hairline frame.
 */
export function Empty(p: {message: string; detail?: string}): JSX.Element {
  const cell = useCell();
  useRenderReport('W_EMPTY', cell ? `${cell.name}#${cell.id}` : undefined, p.detail ? `${p.message} (${p.detail})` : p.message);
  return (
    <div className="gl-state gl-empty" data-gl-state="empty">
      <span className="gl-state-line">{p.message}</span>
      {p.detail ? <span className="gl-state-detail">{p.detail}</span> : null}
    </div>
  );
}

/** Error: critical rule at left, mono code, `Name#id`, message. Never takes the page down. */
export function Redline(p: {code: string; id: string; message: string}): JSX.Element {
  useRenderReport(p.code, p.id, p.message);
  return (
    <div className="gl-state gl-redline" data-gl-state="redline" data-code={p.code} role="alert">
      <span className="gl-redline-code">{p.code}</span> <span className="gl-redline-id">{p.id}</span>{' '}
      <span className="gl-redline-message">{p.message}</span>
    </div>
  );
}

/** Focus goes to the plate header when the control that had it is about to go away with the scope row. */
function parkFocus(control: HTMLElement): void {
  const frame = control.closest('.gl-frame');
  const header = frame?.querySelector<HTMLElement>(':scope > .gl-frame-head[tabindex]');
  header?.focus({preventScroll: true});
}

/**
 * The way back from a drill (design rule D1). While the server has re-scoped a dataset (`dataset.drill`), every
 * component bound to it shows the scope it is looking at with two controls: one level up, and back to the scope the
 * spec asked for. It lives in a row of its own under the plate header (in place above the content without a plate),
 * survives a reload because it is read from the envelope, and is the only back control: components dispatch
 * gl_drill and keep no drill state of their own.
 */
function ScopeCrumb(p: {ds: Dataset; componentId: string}): JSX.Element | null {
  const host = useHostActions(p.componentId);
  const {drill, $ds: key} = p.ds;
  if (!drill || typeof drill.target !== 'string') return null;
  const up = typeof drill.up === 'string' ? drill.up : '';
  return (
    <PlateScope>
      <span className="gl-scope-label">Scope</span>
      <span className="gl-scope-target" data-gl-scope={drill.target} title={drill.target}><bdi>{drill.target}</bdi></span>
      {up !== '' ? (
        <button type="button" className="gl-scope-button" data-gl-scope-up="" title={`Up one level, to ${up}`} aria-label={`Up one level, to ${up}`} onClick={() => host.drill(key, up)}>
          <Icon name="arrow-up" /> Up
        </button>
      ) : null}
      <button
        type="button"
        className="gl-scope-button"
        data-gl-scope-reset=""
        title="Back to the whole view"
        aria-label={`Leave ${drill.target}: back to the whole view`}
        onClick={event => {
          parkFocus(event.currentTarget);
          host.drill(key, '');
        }}
      >
        <Icon name="reset" /> Full view
      </button>
    </PlateScope>
  );
}

/**
 * Renders Drafting / Empty / Redline for non-ready states and children(data, state) when ready.
 * `id` is `Name#componentId`, shown in the redline. Data-bound views start with
 *   const state = useDataset(props.data);
 *   return <DataGate state={state} id={`DataTable#${id}`}>{rows => ...}</DataGate>;
 * When the data is cut (state.truncated, or fewer rows than state.total) the gate also puts the Marginal note in the
 * plate header through <PlateAside> (in place, above the content, when there is no plate). Views do not render
 * <Marginal> themselves unless they describe a different state, such as the page a table is showing.
 * While the dataset is drilled (state.ds.drill) the gate shows the scope and the way back, in every state: a view
 * only dispatches useHostActions(id).drill(key, target) and draws no back control of its own.
 */
export function DataGate<T>(p: {state: DataState<T>; id: string; children: (data: T, state: DataState<T>) => ReactNode}): JSX.Element {
  const {state} = p;
  const cell = useCell();
  const componentId = cell?.id ?? p.id.slice(p.id.indexOf('#') + 1);
  return (
    <>
      {state.ds?.drill ? <ScopeCrumb ds={state.ds} componentId={componentId} /> : null}
      {state.status === 'pending' ? <Drafting label={state.message} />
        : state.status === 'empty' ? <Empty message={state.message ?? 'no data'} detail={state.detail} />
        : state.status === 'error' ? <Redline code={state.code ?? 'E_DATA'} id={p.id} message={state.message ?? 'failed'} />
        : (
          <>
            {marginalText(state) ? <PlateAside><Marginal state={state} /></PlateAside> : null}
            {p.children(state.data as T, state)}
          </>
        )}
    </>
  );
}

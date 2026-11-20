// packages/viewer/src/kit/states.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// The three non-ready looks every component shares, and the gate that picks one from a DataState.
// Frozen test hooks: each state root carries data-gl-state="drafting" | "empty" | "redline"; a redline also carries
// data-code. Tests and the e2e suite select on these, never on class names.
import type {JSX, ReactNode} from 'react';
import type {DataState} from './hooks.ts';
import {PlateAside} from './implement.tsx';
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

/** No data: hairline frame with a centred mono line that names the binding or source. */
export function Empty(p: {message: string}): JSX.Element {
  return (
    <div className="gl-state gl-empty" data-gl-state="empty">
      <span className="gl-state-line">{p.message}</span>
    </div>
  );
}

/** Error: critical rule at left, mono code, `Name#id`, message. Never takes the page down. */
export function Redline(p: {code: string; id: string; message: string}): JSX.Element {
  return (
    <div className="gl-state gl-redline" data-gl-state="redline" data-code={p.code} role="alert">
      <span className="gl-redline-code">{p.code}</span> <span className="gl-redline-id">{p.id}</span>{' '}
      <span className="gl-redline-message">{p.message}</span>
    </div>
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
 */
export function DataGate<T>(p: {state: DataState<T>; id: string; children: (data: T, state: DataState<T>) => ReactNode}): JSX.Element {
  const {state} = p;
  if (state.status === 'pending') return <Drafting label={state.message} />;
  if (state.status === 'empty') return <Empty message={state.message ?? 'no data'} />;
  if (state.status === 'error') return <Redline code={state.code ?? 'E_DATA'} id={p.id} message={state.message ?? 'failed'} />;
  return (
    <>
      {marginalText(state) ? <PlateAside><Marginal state={state} /></PlateAside> : null}
      {p.children(state.data as T, state)}
    </>
  );
}

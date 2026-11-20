// packages/viewer/src/kit/states.tsx  (first version by WP0; owned by WP4; exported signatures are frozen)
// The three non-ready looks every component shares, and the gate that picks one from a DataState.
// Frozen test hooks: each state root carries data-gl-state="drafting" | "empty" | "redline"; a redline also carries
// data-code. Tests and the e2e suite select on these, never on class names.
//
// What the person sees, the agent hears (decisions D3, D14): an Empty and a Redline that stand in for a component are
// the component's state, told to the host through its cell (report.ts): `W_EMPTY` (or the `code` given) for an empty
// state, the redline code for a redline, nothing yet while it drafts, OK once it draws. A state inside <Subpart>, or
// with `part`, belongs to a part of the component and is not told. Nothing is told outside a component cell.
import type {Dataset} from '@glimpse/catalog';
import {useLayoutEffect, useRef, type JSX, type ReactNode} from 'react';
import {wrapAtSlashes} from './entity.tsx';
import {useHostActions, type DataState} from './hooks.ts';
import {Icon} from './icons.tsx';
import {PlateAside, PlateScope, useCell} from './implement.tsx';
import {Marginal, marginalText} from './marginal.tsx';
import {useReportState} from './report.ts';

/** Pending: dashed construction frame with two diagonals at final size and a mono status line. Fills its box. */
export function Drafting(p: {label?: string; part?: boolean}): JSX.Element {
  // What the component will show is not known yet: its report waits.
  useReportState(undefined, '', !p.part);
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
 * `code` is what the component's report says (decision D14), W_EMPTY by default: I_EMPTY for a truthful empty answer
 * (the source says why; emptyCodeOf(state) knows), I_WAITING for a view that follows a selection nobody has made,
 * W_FIELD for a field the spec names that the data lacks. `part`: this empty is one part of a component that shows
 * other content (one file of a diff), so it is not the component's state.
 */
export function Empty(p: {message: string; detail?: string; code?: string; part?: boolean}): JSX.Element {
  useReportState(p.part ? undefined : (p.code ?? 'W_EMPTY'), p.detail ? `${p.message} (${p.detail})` : p.message);
  return (
    <div className="gl-state gl-empty" data-gl-state="empty">
      <span className="gl-state-line">{wrapAtSlashes(p.message)}</span>
      {p.detail ? <span className="gl-state-detail">{wrapAtSlashes(p.detail)}</span> : null}
    </div>
  );
}

/** Error: critical rule at left, mono code, `Name#id`, message. Never takes the page down. `part`: see Empty. */
export function Redline(p: {code: string; id: string; message: string; part?: boolean}): JSX.Element {
  useReportState(p.part ? undefined : p.code, p.message);
  return (
    <div className="gl-state gl-redline" data-gl-state="redline" data-code={p.code} role="alert">
      <span className="gl-redline-code">{p.code}</span> <span className="gl-redline-id">{p.id}</span>{' '}
      <span className="gl-redline-message">{p.message}</span>
    </div>
  );
}

/**
 * Focus goes to the plate header when the control that had it goes away with the scope row; without a plate, to the
 * component's cell (focusable for the occasion), so the keyboard never drops to <body>.
 */
function parkFocus(from: Element | null): void {
  const cell = from?.closest<HTMLElement>('.gl-cell');
  if (!cell?.isConnected) return;
  const header = cell.querySelector<HTMLElement>(':scope > .gl-frame > .gl-frame-head[tabindex]');
  if (header) {
    header.focus({preventScroll: true});
    return;
  }
  if (!cell.hasAttribute('tabindex')) {
    cell.setAttribute('tabindex', '-1');
    cell.addEventListener('blur', () => cell.removeAttribute('tabindex'), {once: true});
  }
  cell.focus({preventScroll: true});
}

const lostFocus = () => document.activeElement === null || document.activeElement === document.body;

/**
 * The way back from a drill (design rule D1). While the server has re-scoped a dataset (`dataset.drill`), every
 * component bound to it shows the scope it is looking at with two controls: one level up, and back to the scope the
 * spec asked for. It lives in a row of its own under the plate header (in place above the content without a plate),
 * survives a reload because it is read from the envelope, and is the only back control: components dispatch
 * gl_drill and keep no drill state of their own.
 * Keyboard: a control that goes away hands the focus on (V063). After Up it stays on Up while there is a level
 * above, moves to Full view when there is none, and to the plate header when the scope row itself goes away.
 */
function ScopeCrumb(p: {ds: Dataset; componentId: string}): JSX.Element | null {
  const host = useHostActions(p.componentId);
  const {drill, $ds: key} = p.ds;
  const reset = useRef<HTMLButtonElement>(null);
  const upButton = useRef<HTMLButtonElement>(null);
  /** The Up control that was pressed, its cell and the scope it was pressed in, while the answer is on its way. */
  const pressed = useRef<{control: Element; cell: Element; scope: string | undefined} | null>(null);
  const target = drill && typeof drill.target === 'string' ? drill.target : undefined;
  // After the answer has rendered: a pressed control that is gone has left the focus on <body>.
  useLayoutEffect(() => {
    const was = pressed.current;
    if (!was || was.scope === target) return;
    pressed.current = null;
    if (was.control.isConnected || !lostFocus()) return;
    if (reset.current?.isConnected) reset.current.focus({preventScroll: true});
    else parkFocus(was.cell);
  });
  // The whole row goes away (back at the scope of the spec): the plate header takes the focus. This runs before the
  // buttons leave the document, so the focus never passes through <body>.
  useLayoutEffect(() => () => {
    const active = document.activeElement;
    if (active !== null && (active === reset.current || active === upButton.current)) parkFocus(active);
  }, []);
  if (target === undefined) return null;
  const up = typeof drill?.up === 'string' ? drill.up : '';
  return (
    <PlateScope>
      <span className="gl-scope-label">Scope</span>
      <span className="gl-scope-target" data-gl-scope={target} title={target}><bdi>{target}</bdi></span>
      {up !== '' ? (
        <button
          ref={upButton}
          type="button"
          className="gl-scope-button"
          data-gl-scope-up=""
          title={`Up one level, to ${up}`}
          aria-label={`Up one level, to ${up}`}
          onClick={event => {
            const control = event.currentTarget;
            pressed.current = {control, cell: control.closest('.gl-cell') ?? control, scope: target};
            host.drill(key, up);
          }}
        >
          <Icon name="arrow-up" /> Up
        </button>
      ) : null}
      <button
        ref={reset}
        type="button"
        className="gl-scope-button"
        data-gl-scope-reset=""
        title="Back to the whole view"
        aria-label={`Leave ${target}: back to the whole view`}
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
 * `marginal={false}`: the view says what was cut in its own words ('24 of 90 modules', decision D16), once.
 */
export function DataGate<T>(p: {state: DataState<T>; id: string; marginal?: boolean; children: (data: T, state: DataState<T>) => ReactNode}): JSX.Element {
  const {state} = p;
  const cell = useCell();
  const componentId = cell?.id ?? p.id.slice(p.id.indexOf('#') + 1);
  return (
    <>
      {state.ds?.drill ? <ScopeCrumb ds={state.ds} componentId={componentId} /> : null}
      {state.status === 'pending' ? <Drafting label={state.message} />
        : state.status === 'empty' ? <Empty message={state.message ?? 'no data'} detail={state.detail} code={state.code} />
        : state.status === 'error' ? <Redline code={state.code ?? 'E_DATA'} id={p.id} message={state.message ?? 'failed'} />
        : (
          <>
            {p.marginal !== false && marginalText(state) ? <PlateAside><Marginal state={state} /></PlateAside> : null}
            {p.children(state.data as T, state)}
          </>
        )}
    </>
  );
}

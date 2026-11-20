// KeyValue, Steps and List take `title` but not the whole frame group (no `size`), so implement() does not frame
// them. With a title they draw the same numbered plate through the kit Frame; without one they render bare.
// Either way the data goes through DataGate, and the marginal note of cut data lands in the plate header.
import type {ComponentDef} from '@glimpse/catalog';
import type {JSX, ReactNode} from 'react';
import {DataGate, Frame, Marginal, marginalText, type DataState} from '../../../kit/index.ts';
import styles from './Plate.module.css';

export function DataPlate<T>(p: {
  id: string;
  def: ComponentDef<string, any>;
  title?: string;
  note?: string;
  state: DataState<T>;
  /** Header content next to the marginal note (plate) or above the body (bare). */
  aside?: ReactNode;
  children: (data: T, state: DataState<T>) => ReactNode;
}): JSX.Element {
  const {id, def, title, note, state, aside} = p;
  const gateId = `${def.name}#${id}`;
  if (!title) {
    return (
      <div className={styles.bare}>
        {aside ? <div className={styles.aside}>{aside}</div> : null}
        <DataGate state={state} id={gateId}>{p.children}</DataGate>
        {note ? <p className={styles.note}>{note}</p> : null}
      </div>
    );
  }
  // The note is shown in the header here, so the gate must not repeat it in the body.
  const cut = marginalText(state) !== undefined;
  const gated: DataState<T> = cut ? {...state, truncated: undefined, total: undefined} : state;
  const header = cut || aside ? <div className="gl-frame-aside">{aside}{cut ? <Marginal state={state} /> : null}</div> : undefined;
  return (
    <Frame id={id} def={def} title={title} note={note} aside={header}>
      <DataGate state={gated} id={gateId}>{data => p.children(data, state)}</DataGate>
    </Frame>
  );
}

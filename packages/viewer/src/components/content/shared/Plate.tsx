// KeyValue, Steps and List: the data gate every content list shares. The numbered plate of a titled component is
// drawn by implement() like any other (the kit frames every component that takes `title`); this adds what the view
// owns around its data: header content (a count) through <PlateAside>, and the caption of an untitled component,
// which has no plate footer to sit in. The marginal note of cut data and the drill crumb come from DataGate.
import type {ComponentDef} from '@glimpse/catalog';
import type {JSX, ReactNode} from 'react';
import {DataGate, PlateAside, type DataState} from '../../../kit/index.ts';
import styles from './Plate.module.css';

export function DataPlate<T>(p: {
  id: string;
  def: ComponentDef<string, any>;
  /** The component's title: with one, the plate (and its caption) is the kit's. */
  title?: string;
  note?: string;
  state: DataState<T>;
  /** Header content: in the plate header when there is a plate, above the body otherwise. */
  aside?: ReactNode;
  children: (data: T, state: DataState<T>) => ReactNode;
}): JSX.Element {
  const {id, def, title, note, state, aside} = p;
  return (
    <div className={styles.bare}>
      {aside ? <PlateAside>{aside}</PlateAside> : null}
      <DataGate state={state} id={`${def.name}#${id}`}>{p.children}</DataGate>
      {note && !title ? <p className={styles.note}>{note}</p> : null}
    </div>
  );
}

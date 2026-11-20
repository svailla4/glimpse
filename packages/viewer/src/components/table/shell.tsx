import type {JSX, ReactNode} from 'react';
import s from './shell.module.css';

/**
 * The box of a table-family view. The gate may put a marginal note above the view when there is no plate header to
 * hold it; in a column the view then takes what is left of a sized cell instead of overflowing it by that note.
 */
export function Shell(p: {sized: boolean; children: ReactNode}): JSX.Element {
  return <div className={s.shell} data-sized={p.sized ? '' : undefined}>{p.children}</div>;
}

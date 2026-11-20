import type {CSSProperties, JSX, ReactNode} from 'react';
import {useSizeCap} from '../../kit/index.ts';
import s from './shell.module.css';

/**
 * The box of a table-family view (DataTable, CommitList, FileTree, JsonView). It hands the view its maximum height,
 * as `--gl-cap` (decision D20): the view is as tall as its rows and scrolls only past that, so a short table leaves
 * no blank paper under it, sized or not. The gate may put a marginal note above the view when there is no plate
 * header to hold it; in a sized cell the view then takes what is left of the box instead of overflowing it.
 */
export function Shell(p: {children: ReactNode}): JSX.Element {
  const cap = useSizeCap();
  return <div className={s.shell} style={{'--gl-cap': `${cap}px`} as CSSProperties}>{p.children}</div>;
}

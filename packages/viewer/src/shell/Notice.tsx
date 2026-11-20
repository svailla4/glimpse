// packages/viewer/src/shell/Notice.tsx - what a tab shows when it has no session to connect to.
import type {JSX, ReactNode} from 'react';
import css from './Shell.module.css';

export function Notice(p: {title: string; children: ReactNode}): JSX.Element {
  return (
    <main className={css.notice}>
      <h1 className={css.noticeTitle}>{p.title}</h1>
      <p className={css.noticeText}>{p.children}</p>
    </main>
  );
}

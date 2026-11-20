// The "queued for the agent" affordance of Button and Ask (design 2.7): a click cannot wake an idle session, so the
// viewer says where the event went. The live region stays mounted, so the text is announced when it appears.
import type {JSX} from 'react';
import styles from './Queued.module.css';

export const QUEUED_TEXT = 'queued for the agent';
export const FAILED_TEXT = 'not sent';

export type QueueState = 'idle' | 'queued' | 'failed';

export function Queued(p: {state: QueueState; detail?: string}): JSX.Element {
  const text = p.state === 'queued' ? QUEUED_TEXT : p.state === 'failed' ? FAILED_TEXT : '';
  return (
    <span className={styles.queued} role="status" aria-live="polite" data-gl-queued={p.state === 'idle' ? undefined : p.state}>
      {text ? (
        <>
          <span className={styles.mark} aria-hidden="true" />
          {text}
          {p.detail ? <span className={styles.detail}> · {p.detail}</span> : null}
        </>
      ) : null}
    </span>
  );
}

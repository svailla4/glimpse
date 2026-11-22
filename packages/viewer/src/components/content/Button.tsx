// Button (design 5.3): dispatches its A2UI action, which the server queues for the agent. 28 px, ink outline;
// `primary` is ink-filled, never vermilion. Once the host has taken a press it says "queued for the agent" for two
// seconds; a press that could not leave the tab says "not sent", and one made after the session ended says so.
import type * as C from '@glimpse/catalog';
import {useEffect, useRef, useState} from 'react';
import {useLatest, useLinkStatus, type GlView} from '../../kit/index.ts';
import {textOf} from './shared/inline.tsx';
import {ENDED_TITLE, Queued, type QueueState} from './shared/Queued.tsx';
import styles from './Button.module.css';

const NOTE_MS = 2000;

export const ButtonView: GlView<typeof C.Button> = ({props}) => {
  const [state, setState] = useState<QueueState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
  // Once the session is over the shell drops whatever a view sends: nothing pressed here can reach the agent.
  const ended = useLinkStatus() === 'ended';
  // Read when the host answers a press, which may be after the session ended.
  const endedRef = useRef(ended);
  useLatest(endedRef, ended);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const show = (next: QueueState) => {
    if (!mounted.current) return;
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), NOTE_MS);
  };
  const press = () => {
    // Say so instead of claiming it was queued.
    if (ended) return show('ended');
    if (typeof props.action !== 'function') return show('failed');
    // "queued" is said once the action has been handed over, not before; a rejection means it never left the tab.
    Promise.resolve()
      .then(() => props.action())
      .then(() => show(endedRef.current ? 'ended' : 'queued'), () => show('failed'));
  };

  const label = textOf(props.label).trim() || 'Send';
  return (
    <div className={styles.wrap}>
      {/* Still focusable and pressable once the session has ended, so that a press is answered with the reason. */}
      <button
        type="button"
        className={styles.button}
        data-tone={props.tone ?? 'default'}
        aria-disabled={ended || undefined}
        title={ended ? ENDED_TITLE : undefined}
        onClick={press}
      >
        {label}
      </button>
      <Queued state={state} />
    </div>
  );
};

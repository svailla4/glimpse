// Button (design 5.3): dispatches its A2UI action, which the server queues for the agent. 28 px, ink outline;
// `primary` is ink-filled, never vermilion. After a press it says "queued for the agent" for two seconds.
import type * as C from '@glimpse/catalog';
import {useEffect, useRef, useState} from 'react';
import type {GlView} from '../../kit/index.ts';
import {textOf} from './shared/inline.tsx';
import {Queued, type QueueState} from './shared/Queued.tsx';
import styles from './Button.module.css';

const NOTE_MS = 2000;

export const ButtonView: GlView<typeof C.Button> = ({props}) => {
  const [state, setState] = useState<QueueState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mounted = useRef(true);
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
    if (typeof props.action !== 'function') return show('failed');
    show('queued');
    // The action resolves once the host has taken it; a rejection means it never left the tab.
    Promise.resolve()
      .then(() => props.action())
      .catch(() => show('failed'));
  };

  const label = textOf(props.label).trim() || 'Send';
  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.button} data-tone={props.tone ?? 'default'} onClick={press}>
        {label}
      </button>
      <Queued state={state} />
    </div>
  );
};

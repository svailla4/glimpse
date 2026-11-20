// The mono chip (design 5.3 Chips): the label stays ink, a dot carries tone or slot colour.
import type {JSX} from 'react';
import styles from './Chip.module.css';

export function Chip(p: {label: string; dot?: string; dotLabel?: string; title?: string}): JSX.Element {
  return (
    <span className={styles.chip} title={p.title}>
      {!p.dot ? null : p.dotLabel ? (
        <span className={styles.dot} style={{background: p.dot}} role="img" aria-label={p.dotLabel} />
      ) : (
        <span className={styles.dot} style={{background: p.dot}} aria-hidden="true" />
      )}
      <span className={styles.label}>{p.label}</span>
    </span>
  );
}

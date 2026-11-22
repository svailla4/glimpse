// Text (design 5.3): text in one of five tones, with inline micro-markup only. Line breaks are kept. Long text is set
// in columns once its box is wide (decision D26): a measure of about 72ch in a full-width plate left half the frame
// empty, and no measure at all made lines too long to read.
import type * as C from '@glimpse/catalog';
import type {GlView} from '../../kit/index.ts';
import {Inline, textOf} from './shared/inline.tsx';
import styles from './Text.module.css';

/** Text longer than this (about six lines at 72ch) may be set in columns; shorter text never is. */
const LONG_TEXT = 400;

export const TextView: GlView<typeof C.Text> = ({id, props}) => {
  const text = textOf(props.text);
  if (text.trim() === '') return null;
  const tone = props.tone ?? 'body';
  const body = (
    <p className={styles.text} data-tone={tone}>
      <Inline text={text} componentId={id} />
    </p>
  );
  // Mono text is laid out by its own spaces and line breaks; it is never set in columns.
  return text.length > LONG_TEXT && tone !== 'mono' ? <div className={styles.long}>{body}</div> : body;
};

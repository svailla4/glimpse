// Text (design 5.3): short text in one of five tones, with inline micro-markup only.
import type * as C from '@glimpse/catalog';
import type {GlView} from '../../kit/index.ts';
import {Inline, textOf} from './shared/inline.tsx';
import styles from './Text.module.css';

export const TextView: GlView<typeof C.Text> = ({id, props}) => {
  const text = textOf(props.text);
  if (text.trim() === '') return null;
  return (
    <p className={styles.text} data-tone={props.tone ?? 'body'}>
      <Inline text={text} componentId={id} />
    </p>
  );
};

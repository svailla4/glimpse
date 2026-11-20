// Callout (design 5.3): a marginal note. A 1 px rule in the kind's status ink with a dot at its top, a mono tag, the
// body, and the file anchor on the last line. No fill, no box. The tag names the kind, so colour is never alone.
import type * as C from '@glimpse/catalog';
import type {GlView} from '../../kit/index.ts';
import {FileLink} from './shared/FileLink.tsx';
import {Inline, textOf} from './shared/inline.tsx';
import styles from './Callout.module.css';

const KINDS = {
  note: {tag: 'Note', ink: 'var(--gl-info)'},
  tip: {tag: 'Tip', ink: 'var(--gl-good)'},
  warn: {tag: 'Warning', ink: 'var(--gl-warning)'},
  risk: {tag: 'Risk', ink: 'var(--gl-critical)'},
  decision: {tag: 'Decision', ink: 'var(--gl-ink)'},
  question: {tag: 'Question', ink: 'var(--gl-serious)'},
} as const;

export const CalloutView: GlView<typeof C.Callout> = ({id, props}) => {
  const text = textOf(props.text);
  const title = textOf(props.title).trim();
  const file = textOf(props.file).trim();
  if (text.trim() === '' && title === '' && file === '') return null;
  const kindName = props.kind && Object.hasOwn(KINDS, props.kind) ? props.kind : 'note';
  const kind = KINDS[kindName];
  return (
    <aside className={styles.callout} data-kind={kindName} style={{['--callout-ink' as never]: kind.ink}}>
      <div className={styles.tag}>{kind.tag}</div>
      {text.trim() !== '' || title !== '' ? (
        <p className={styles.body}>
          {title ? <strong className={styles.title}>{title}{/[.:!?]$/.test(title) ? ' ' : '. '}</strong> : null}
          <Inline text={text} componentId={id} />
        </p>
      ) : null}
      {file ? (
        <div className={styles.file}>
          <FileLink file={file} componentId={id} />
        </div>
      ) : null}
    </aside>
  );
};

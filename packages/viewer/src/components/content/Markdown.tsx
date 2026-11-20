// Markdown (design 5.3): agent-written prose. The parser (markdown-to-jsx) is a lazy chunk, so the first bundle
// carries only this file; MarkdownProse.tsx holds the rendering rules (no raw HTML, http(s) links only, no images).
import type * as C from '@glimpse/catalog';
import {Suspense, lazy, type FC} from 'react';
import {Drafting, type GlView} from '../../kit/index.ts';
import {textOf} from './shared/inline.tsx';
import styles from './Markdown.module.css';

/** If the parser chunk cannot be loaded the source is still worth reading as plain text. */
type ProseView = FC<{id: string; text: string}>;
const PlainProse: ProseView = ({text}) => <div className={styles.plain} data-gl-markdown="plain">{text}</div>;

const Prose = lazy<ProseView>(() => import('./MarkdownProse.tsx').then(module => ({default: module.MarkdownProse}), () => ({default: PlainProse})));

export const MarkdownView: GlView<typeof C.Markdown> = ({id, props}) => {
  const text = textOf(props.text);
  if (text.trim() === '') return null;
  return (
    <Suspense fallback={<Drafting label="setting prose" />}>
      <Prose id={id} text={text} />
    </Suspense>
  );
};

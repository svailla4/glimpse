// The lazy half of Markdown: markdown-to-jsx with the security rules of design 2.8.
//   - raw HTML is never parsed (disableParsingRawHTML): tags in the source stay literal text
//   - a link renders as <a> only for http(s), opened in a new tab with rel="noopener noreferrer"; a relative link to a
//     repo path becomes a file link; every other scheme (javascript:, data:, mailto:, ...) renders as plain text
//   - images are never fetched: an image is a chip that shows its alt text
//   - fenced code goes through the CodeBlock view of the code chunk, or a plain mono block while that is unavailable
// Every element gets its class through `overrides`, so no selector here can reach into a borrowed view.
import type * as C from '@glimpse/catalog';
import MarkdownToJsx, {RuleType, type MarkdownToJSX} from 'markdown-to-jsx/react';
import {memo, useMemo, type JSX, type ReactNode} from 'react';
import {borrowView, fmtNum, type GlView} from '../../kit/index.ts';
import {Chip} from './shared/Chip.tsx';
import {looksLikePath} from './shared/data.ts';
import {FileLink} from './shared/FileLink.tsx';
import inline from './shared/inline.module.css';
import styles from './Markdown.module.css';

/** Longer sources are cut at a line break and say so: parsing is linear, but nobody reads a megabyte of notes. */
const MAX_CHARS = 200_000;

// [[path#L10-20]] is not Markdown, and a path such as src/__tests__/a.ts would be read as emphasis. Before parsing,
// each ref becomes a link with a private scheme and a fully escaped target; the link rule turns it into a FileLink,
// and code (where the ref must stay literal) turns it back.
const REF = /\[\[(?!\s)([^[\]\n]{1,400}?)(?<!\s)\]\]/g;
const REF_SCHEME = 'glref:';
const REF_LINK = /\[ref\]\(glref:([^)\s]*)\)/g;
const escapeRef = (loc: string) => encodeURIComponent(loc).replace(/[()*_~!']/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const hideRefs = (source: string) => source.replace(REF, (_whole, loc: string) => `[ref](${REF_SCHEME}${escapeRef(loc)})`);
function decodeRef(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
const showRefs = (code: string) => code.replace(REF_LINK, (whole, encoded: string) => {
  const loc = decodeRef(encoded);
  return loc === undefined ? whole : `[[${loc}]]`;
});

const PlainCode: GlView<typeof C.CodeBlock> = ({props}) => (
  <pre className={styles.pre} data-lang={props.lang || undefined}>
    <code>{props.code}</code>
  </pre>
);
const Code = borrowView<typeof C.CodeBlock>(() => import('../code/index.ts'), 'CodeBlock', PlainCode);
const noChild = () => null;

function plainText(node: ReactNode): string | undefined {
  if (typeof node === 'string') return node;
  if (Array.isArray(node) && node.every(part => typeof part === 'string')) return node.join('');
  return undefined;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function buildOptions(componentId: string): MarkdownToJSX.Options {
  const Link = (p: {href?: string | null; title?: string; children?: ReactNode}): JSX.Element => {
    const href = typeof p.href === 'string' ? p.href.trim() : '';
    if (href.startsWith(REF_SCHEME)) {
      const loc = decodeRef(href.slice(REF_SCHEME.length));
      return loc ? <FileLink file={loc} componentId={componentId} /> : <span>{p.children}</span>;
    }
    if (/^https?:\/\//i.test(href)) {
      return <a className={styles.link} href={href} title={p.title} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{p.children}</a>;
    }
    // A relative link can only mean a file of the repository: select it instead of navigating the viewer away.
    const path = href.replace(/^\.\//, '');
    if (path && !SCHEME.test(path) && looksLikePath(path)) {
      const label = plainText(p.children);
      return <FileLink file={path} label={label && label !== path ? label : undefined} componentId={componentId} />;
    }
    return <span className={styles.dead}>{p.children}</span>;
  };
  const Image = (p: {alt?: string; title?: string}): JSX.Element => (
    <span className={styles.image} data-gl-image=""><Chip label={p.alt?.trim() ? `image: ${p.alt.trim()}` : 'image'} title={p.title} /></span>
  );
  const heading = (Tag: 'h3' | 'h4' | 'h5', className: string | undefined) =>
    function Heading(p: {children?: ReactNode}): JSX.Element {
      // The id the parser derives from the heading text is dropped: several documents share one page.
      return <Tag className={className}>{p.children}</Tag>;
    };
  const Table = (p: {children?: ReactNode}): JSX.Element => (
    <div className={styles.tableWrap}><table className={styles.table}>{p.children}</table></div>
  );
  const Task = (p: {checked?: boolean}): JSX.Element => (
    <svg className={styles.task} width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={p.checked ? 'done' : 'to do'}>
      <rect x="0.5" y="0.5" width="11" height="11" />
      {p.checked ? <path d="M3 6.2L5.2 8.4L9.2 3.8" /> : null}
    </svg>
  );
  const cls = (className: string | undefined) => ({props: {className}});
  const minor = heading('h5', styles.h3);
  return {
    disableParsingRawHTML: true,
    forceBlock: true,
    forceWrapper: true,
    wrapper: 'div',
    wrapperProps: {className: styles.prose} as MarkdownToJSX.Options['wrapperProps'],
    overrides: {
      a: Link,
      img: Image,
      h1: heading('h3', styles.h1),
      h2: heading('h4', styles.h2),
      h3: minor,
      h4: minor,
      h5: minor,
      h6: minor,
      p: cls(styles.p),
      ul: cls(styles.list),
      ol: cls(styles.list),
      li: cls(styles.item),
      blockquote: cls(styles.quote),
      hr: cls(styles.rule),
      table: Table,
      th: cls(styles.th),
      td: cls(styles.td),
      input: Task,
      footer: cls(styles.footnotes),
    },
    renderRule(next, node, _renderChildren, state) {
      if (node.type === RuleType.codeBlock) {
        return (
          <div className={styles.code} key={state.key}>
            <Code id={componentId} props={{code: showRefs(node.text), lang: node.lang || undefined}} child={noChild} />
          </div>
        );
      }
      if (node.type === RuleType.codeInline) return <code className={inline.code} key={state.key}>{showRefs(node.text)}</code>;
      return next();
    },
  };
}

export const MarkdownProse = memo(function MarkdownProse(p: {id: string; text: string}): JSX.Element {
  const options = useMemo(() => buildOptions(p.id), [p.id]);
  const source = useMemo(() => {
    if (p.text.length <= MAX_CHARS) return hideRefs(p.text);
    const cut = p.text.lastIndexOf('\n', MAX_CHARS);
    return hideRefs(p.text.slice(0, cut > 0 ? cut : MAX_CHARS));
  }, [p.text]);
  return (
    <div className={styles.markdown} data-gl-markdown="prose">
      <MarkdownToJsx options={options}>{source}</MarkdownToJsx>
      {p.text.length > MAX_CHARS ? <p className={styles.cut}>showing the first {fmtNum(source.length)} of {fmtNum(p.text.length)} characters</p> : null}
    </div>
  );
});

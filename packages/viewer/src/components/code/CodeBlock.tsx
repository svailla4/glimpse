import type * as C from '@glimpse/catalog';
import {parseLineRanges, type TokenLine} from '@glimpse/catalog';
import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {Empty, Icon, Redline, useHost, type GlView} from '../../kit/index.ts';
import s from './CodeBlock.module.css';
import {coerceLines, cx, inRanges, lineText, plainLines, textCols, TokenSpans} from './codekit/lines.tsx';
import k from './codekit/lines.module.css';
import {useFetched} from './codekit/useFetched.ts';
import {VirtualRows} from './codekit/VirtualRows.tsx';

const NUMBERS_ABOVE = 5;

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)?.then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };
  return [copied, copy];
}

export const CodeBlockView: GlView<typeof C.CodeBlock> = ({id, props}) => {
  const host = useHost();
  const raw: unknown = props.code;
  const code = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : undefined;
  const lang = typeof props.lang === 'string' && props.lang.trim() !== '' ? props.lang.trim() : undefined;
  const title = typeof props.title === 'string' && props.title !== '' ? props.title : undefined;
  const plain = useMemo(() => (code ? plainLines(code) : []), [code]);

  // Plain text first; tokens replace it when the host answers. No language means there is nothing to highlight.
  const highlighted = useFetched(lang && code ? `${lang}\n${code}` : undefined, 0, signal => host.highlight(code ?? '', lang, signal));
  const lines = useMemo<TokenLine[]>(() => {
    const tokens = coerceLines(highlighted.data?.lines);
    // A token line is used only when it spells the same text, so a host that splits lines differently cannot garble the snippet.
    return plain.map((text, i) => {
      const line = tokens[i];
      return line && lineText(line) === text ? line : text === '' ? [] : [[text, 0]];
    });
  }, [plain, highlighted.data]);
  const marks = useMemo(() => parseLineRanges(props.mark), [props.mark]);
  const cols = useMemo(() => plain.reduce((max, text) => Math.max(max, Math.min(textCols(text), 2016)), 0), [plain]);
  const [copied, copy] = useCopied();

  if (raw !== null && raw !== undefined && code === undefined) {
    return <Redline code="E_SHAPE" id={`CodeBlock#${id}`} message={`code: expected text, received ${Array.isArray(raw) ? 'an array' : typeof raw}`} />;
  }
  if (!code) return <Empty message="no code" />;

  const numbered = plain.length > NUMBERS_ABOVE;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    copy(code);
  };
  const copyButton = (
    <button
      type="button"
      className={cx(k.tool, !title && !lang && s.float)}
      tabIndex={-1}
      aria-label={copied ? 'Copied' : 'Copy code'}
      aria-keyshortcuts="c"
      title="Copy (c)"
      data-copied={copied || undefined}
      onClick={() => copy(code)}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );

  return (
    <div className={cx(k.code, s.block)} data-well="" data-gl-code="block" style={{['--gl-digits' as never]: String(plain.length).length}}>
      {title || lang ? (
        <div className={k.head}>
          {title ? <span className={s.title}>{title}</span> : null}
          <span className={k.grow} />
          {lang ? <span className={k.badge} data-gl-lang="">{lang}</span> : null}
          {copyButton}
        </div>
      ) : copyButton}
      <VirtualRows
        className={s.body}
        role="region"
        aria-label={`${title ?? 'Code'}${lang ? `, ${lang}` : ''}, ${plain.length} ${plain.length === 1 ? 'line' : 'lines'}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        count={lines.length}
        rowHeight={20}
        pad={6}
        cols={cols}
        colsPad={numbered ? 'var(--gl-gutter) + 34px' : '28px'}
      >
        {index => (
          <div className={k.line} data-line={index + 1} data-bare={numbered ? undefined : ''} data-hl={inRanges(marks, index + 1) ? '' : undefined}>
            {numbered ? <span className={k.num}>{index + 1}</span> : null}
            <span className={k.mk} />
            <span className={k.src}><TokenSpans tokens={lines[index] ?? []} /></span>
          </div>
        )}
      </VirtualRows>
      <span className={s.live} role="status">{copied ? 'Copied' : ''}</span>
    </div>
  );
};

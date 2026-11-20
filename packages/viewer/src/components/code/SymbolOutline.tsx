import type * as C from '@glimpse/catalog';
import {formatFileLoc, parseFileLoc, type EntityRef} from '@glimpse/catalog';
import {useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {
  Drafting, Empty, PlateAside, REPORT_CODES, Redline, fmtNum, toNumber, useFollowedFile, useHost, useHostActions, useRev, useSelection, type GlView,
} from '../../kit/index.ts';
import s from './SymbolOutline.module.css';
import {Crumbs, cx, useCapStyle} from './codekit/lines.tsx';
import k from './codekit/lines.module.css';
import {useFetched} from './codekit/useFetched.ts';
import {VirtualRows, type VirtualRowsHandle} from './codekit/VirtualRows.tsx';

const BADGE: Record<string, string> = {fn: 'FN', class: 'CLS', method: 'MTD', type: 'TY', iface: 'IF', const: 'CONST', var: 'VAR', enum: 'ENUM', mod: 'MOD', heading: 'H'};
const KIND_NAME: Record<string, string> = {
  fn: 'function', class: 'class', method: 'method', type: 'type', iface: 'interface', const: 'constant', var: 'variable', enum: 'enum', mod: 'module',
  heading: 'heading',
};
const ROW = 24;
const MAX_DEPTH = 12;

interface Sym { key: string; name: string; kind: string; line: number; endLine?: number; depth: number; exported: boolean }

/** The outline is JSON from the host: keep rows that have a name and a line, count the rest. */
function readSymbols(input: unknown, path: string): {symbols: Sym[]; dropped: number} | undefined {
  if (!Array.isArray(input)) return undefined;
  const symbols: Sym[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of input) {
    const name = typeof item?.name === 'string' ? item.name : '';
    const line = Math.floor(toNumber(item?.line) ?? 0);
    const key = `${path}#${name}@${line}`;
    if (name === '' || line < 1 || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    const endLine = Math.floor(toNumber(item.endLine) ?? 0);
    symbols.push({
      key,
      name,
      kind: typeof item.kind === 'string' ? item.kind : '',
      line,
      endLine: endLine > line ? endLine : undefined,
      depth: Math.min(MAX_DEPTH, Math.max(0, Math.floor(toNumber(item.depth) ?? 0))),
      exported: item.exported === true,
    });
  }
  return {symbols, dropped};
}

export const SymbolOutlineView: GlView<typeof C.SymbolOutline> = ({id, props}) => {
  const host = useHost();
  const rev = useRev();
  const followed = useFollowedFile(typeof props.file === 'string' && props.file.trim() !== '' ? props.file : undefined);
  const path = (typeof followed === 'string' && followed.trim() !== '' ? parseFileLoc(followed).path : '') || undefined;
  const fetched = useFetched(path, rev, signal => host.outline(path ?? '', signal));
  const shownPath = fetched.dataKey;
  const outline = useMemo(
    () => (shownPath === undefined ? undefined : readSymbols((fetched.data as {symbols?: unknown} | null | undefined)?.symbols, shownPath)),
    [fetched.data, shownPath],
  );

  if (!path) return <Empty message="no file selected" code={REPORT_CODES.waiting} />;
  if (fetched.error) return <Redline code="E_OUTLINE" id={`SymbolOutline#${id}`} message={`${path}: ${fetched.error}`} />;
  if (shownPath === undefined) return <Drafting label={`reading the outline of ${path}`} />;
  if (!outline) return <Redline code="E_SHAPE" id={`SymbolOutline#${id}`} message={`expected an outline {symbols: [...]} for ${shownPath}`} />;
  if (outline.symbols.length === 0) return <Empty message={`no symbols in ${shownPath}`} code={REPORT_CODES.truthful} />;
  return (
    <Outline
      id={id}
      path={shownPath}
      symbols={outline.symbols}
      dropped={outline.dropped}
      framed={typeof props.title === 'string' && props.title !== ''}
      busy={fetched.loading}
    />
  );
};

interface OutlineProps { id: string; path: string; symbols: Sym[]; dropped: number; framed: boolean; busy: boolean }

function Outline({id, path, symbols, dropped, framed, busy}: OutlineProps): ReactNode {
  const capStyle = useCapStyle();
  const {selected, select} = useSelection(id);
  const actions = useHostActions(id);
  const listId = useId();
  const rows = useRef<VirtualRowsHandle>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = useMemo(() => {
    const needle = query.toLowerCase();
    return needle === '' ? symbols : symbols.filter(symbol => symbol.name.toLowerCase().includes(needle));
  }, [symbols, query]);

  // Another file is another list: start over (path is the trigger).
  useEffect(() => {
    setQuery('');
    setActive(0);
    rows.current?.reveal(0, {always: true});
  }, [path]);

  const at = Math.min(active, shown.length - 1);
  const entity = (symbol: Sym): EntityRef => ({type: 'symbol', id: symbol.key, path, line: symbol.line, ...(symbol.endLine ? {endLine: symbol.endLine} : {}), label: symbol.name});
  const open = (symbol: Sym) => actions.open(formatFileLoc({path, line: symbol.line}));
  const move = (to: number) => {
    if (shown.length === 0) return;
    const index = Math.min(shown.length - 1, Math.max(0, to));
    setActive(index);
    rows.current?.reveal(index, {near: true});
  };
  const filter = (next: string) => {
    setQuery(next);
    setActive(0);
    rows.current?.reveal(0, {always: true});
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const current = shown[at];
    if (event.key === 'Enter') {
      if (!current) return;
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) open(current);
      else select(entity(current));
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'c' && current && String(getSelection?.() ?? '') === '') {
      event.preventDefault();
      void navigator.clipboard?.writeText(`${path}:${current.line}`)?.catch(() => {});
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const page = Math.max(1, (rows.current?.visible().last ?? 0) - (rows.current?.visible().first ?? 0));
    switch (event.key) {
      case 'ArrowDown': move(at + 1); break;
      case 'ArrowUp': move(at - 1); break;
      case 'PageDown': move(at + page); break;
      case 'PageUp': move(at - page); break;
      case 'Home': move(0); break;
      case 'End': move(shown.length - 1); break;
      case 'Backspace': if (query === '') return; filter(query.slice(0, -1)); break;
      case 'Escape':
        if (query !== '') filter('');
        else if (selected) select(null);
        else return;
        break;
      default:
        // Typing filters. A leading space is not a query.
        if (event.key.length !== 1 || (event.key === ' ' && query === '')) return;
        filter(query + event.key);
    }
    event.preventDefault();
  };
  const onRowClick = (event: MouseEvent, index: number) => {
    const symbol = shown[index];
    if (!symbol) return;
    setActive(index);
    // Keys go to the list from here on (rows are not focusable themselves).
    rows.current?.element?.focus({preventScroll: true});
    if (event.metaKey || event.ctrlKey) open(symbol);
    else select(entity(symbol));
  };

  const bits = (
    <>
      <Crumbs path={path} />
      <span className={k.meta}>
        {query === '' ? fmtNum(symbols.length) : `${fmtNum(shown.length)} of ${fmtNum(symbols.length)}`} {symbols.length === 1 ? 'symbol' : 'symbols'}
      </span>
      {dropped > 0 ? <span className={k.meta} data-gl-marginal="">{fmtNum(dropped)} malformed dropped</span> : null}
      {query !== '' ? (
        <button type="button" className={s.filter} tabIndex={-1} aria-label={`Clear filter ${query}`} title="Clear (Esc)" data-gl-filter="" onClick={() => filter('')}>
          {query}
        </button>
      ) : null}
    </>
  );

  return (
    <div className={cx(k.code, s.outline)} data-gl-code="outline" data-fit="cap" data-boxed={framed ? undefined : ''} aria-busy={busy || undefined} style={capStyle}>
      {framed ? <PlateAside><span className={k.bits}>{bits}</span></PlateAside> : <div className={k.head}><span className={k.bits}>{bits}</span></div>}
      {shown.length === 0 ? <div className={s.none} role="status">no symbol matches “{query}”</div> : null}
      <VirtualRows
        handle={rows}
        role="listbox"
        aria-label={`Symbols of ${path}. Type to filter.`}
        aria-activedescendant={shown.length > 0 ? `${listId}-${at}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        count={shown.length}
        rowHeight={ROW}
      >
        {index => {
          const symbol = shown[index]!;
          const isSelected = selected?.type === 'symbol' && selected.id === symbol.key;
          return (
            <div
              id={`${listId}-${index}`}
              role="option"
              aria-selected={isSelected}
              className={s.row}
              data-symbol={symbol.name}
              data-active={index === at ? '' : undefined}
              data-selected={isSelected ? '' : undefined}
              data-exported={symbol.exported ? '' : undefined}
              style={{['--gl-depth' as never]: symbol.depth}}
              onClick={event => onRowClick(event, index)}
            >
              <span className={s.kind} title={KIND_NAME[symbol.kind] ?? (symbol.kind || 'symbol')}>{BADGE[symbol.kind] ?? 'SYM'}</span>
              <span className={s.name}>{symbol.name}</span>
              <span className={s.at}>{symbol.line}</span>
            </div>
          );
        }}
      </VirtualRows>
    </div>
  );
}

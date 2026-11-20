import type * as C from '@glimpse/catalog';
import {formatFileLoc, parseFileLoc, type CodeNote, type DataInput} from '@glimpse/catalog';
import {useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {
  Drafting, Empty, Icon, PlateAside, REPORT_CODES, Redline, fmtNum, toNumber, useDataset, useFollowedFile, useHostActions, useRev, useSelection, type GlView,
} from '../../kit/index.ts';
import {Crumbs, ignoredMarksText, inRanges, parseMarks, TokenSpans} from './codekit/lines.tsx';
import k from './codekit/lines.module.css';
import {useFileLines} from './codekit/useFileLines.ts';
import {VirtualRows, type VirtualRowsHandle} from './codekit/VirtualRows.tsx';

const LINE = 20;
/** Lines of context kept above a range that is scrolled to. */
const LEAD = 3;
const MAX_NOTES = 500;
const SKIPPED: Record<string, (path: string, size: number) => string> = {
  binary: path => `${path} is a binary file`,
  'too-large': (path, size) => `${path} is too large to show (${fmtNum(size, 'bytes')})`,
  missing: path => `${path} does not exist`,
  // The file service answers this for anything that is not in the project's inventory, whether or not it exists on
  // disk: outside the root, ignored by git, under .git, in a dependency tree.
  'outside-root': path => `${path} is not a file of this project (outside it, ignored, or under .git)`,
};
/** A binary or very large file is what it is (I_*); a missing one is W_FILE when the spec named it, I_* when a selection did. */
function skippedCode(skipped: string, named: boolean): string {
  if (skipped === 'binary' || skipped === 'too-large') return REPORT_CODES.truthful;
  return named ? 'W_FILE' : REPORT_CODES.truthful;
}
const NOTE_TAG: Record<string, string> = {note: 'Note', warn: 'Warning', risk: 'Risk'};

interface Note { line: number; anchor: number; text: string; kind: string }

/** Notes are agent-written data: keep the well-formed ones, count the rest. */
function readNotes(input: unknown, total: number): {notes: Note[]; dropped: number} {
  if (input === null || input === undefined) return {notes: [], dropped: 0};
  if (!Array.isArray(input)) return {notes: [], dropped: 1};
  const notes: Note[] = [];
  let dropped = 0;
  for (const item of input as Array<Partial<CodeNote> | null>) {
    const line = Math.floor(toNumber(item?.line) ?? 0);
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (line < 1 || text === '' || notes.length >= MAX_NOTES) {
      dropped++;
      continue;
    }
    // A note past the end of the file is still worth reading: it hangs on the last line.
    const first = Math.min(line, Math.max(1, total));
    const anchor = Math.min(Math.max(first, Math.floor(toNumber(item?.endLine) ?? first)), Math.max(1, total));
    notes.push({line: first, anchor, text, kind: typeof item?.kind === 'string' && item.kind in NOTE_TAG ? item.kind : 'note'});
  }
  return {notes, dropped};
}

const noteHeight = (note: Note) => 26 + 18 * Math.max(1, Math.ceil(note.text.length / 72));

export const CodeViewView: GlView<typeof C.CodeView> = ({id, props}) => (
  <CodeFile
    id={id}
    file={props.file}
    mark={props.mark}
    notes={props.notes}
    fit={props.size ? 'fill' : 'cap'}
    chrome={typeof props.title === 'string' && props.title !== '' ? 'plate' : 'boxed'}
  />
);

export interface CodeFileProps {
  /** Id of the A2UI component this is part of: the source of its selection and open actions. */
  id: string;
  file?: string;
  mark?: string;
  notes?: DataInput<CodeNote[]>;
  fit: 'fill' | 'cap';
  /** Where the header goes: into the plate header, into a boxed body, or into a body that sits inside another view. */
  chrome: 'plate' | 'boxed' | 'bare';
}

/** The file reader behind CodeView, also the right-hand side of CodeTour. */
export function CodeFile(props: CodeFileProps): ReactNode {
  const {id} = props;
  const explicit = typeof props.file === 'string' && props.file.trim() !== '' ? props.file : undefined;
  const followed = useFollowedFile(explicit);
  const loc = useMemo(() => (typeof followed === 'string' && followed.trim() !== '' ? parseFileLoc(followed) : undefined), [followed]);
  const path = loc?.path || undefined;
  const rev = useRev();
  const {selected, select} = useSelection(id);
  const actions = useHostActions(id);
  const framed = props.chrome === 'plate';

  const selFrom = selected && selected.path === path ? Math.floor(toNumber(selected.line) ?? 0) : 0;
  const selTo = selFrom > 0 ? Math.max(selFrom, Math.floor(toNumber(selected?.endLine) ?? selFrom)) : 0;
  const locFrom = loc?.line && loc.line > 0 ? loc.line : 0;
  const locTo = locFrom > 0 ? Math.max(locFrom, loc?.endLine ?? locFrom) : 0;
  // The selection is the red pencil. A range written in the `file` prop is the passage the agent points at: it is
  // scrolled to and set off in graphite, so `mark` and the selection still read inside it.
  const [washFrom, washTo] = selFrom > 0 ? [selFrom, selTo] : explicit ? [0, 0] : [locFrom, locTo];
  const [regionFrom, regionTo] = explicit ? [locFrom, locTo] : [0, 0];
  const [targetFrom, targetTo] = selFrom > 0 ? [selFrom, selTo] : [locFrom, locTo];

  const lines = useFileLines(path, rev, targetFrom || 1);
  const file = lines.file;
  const current = file !== undefined && file.path === path;
  const total = file?.total ?? 0;

  const {ranges: marks, ignored: badMarks} = useMemo(() => parseMarks(props.mark), [props.mark]);
  const notesState = useDataset<CodeNote[]>(props.notes);
  const {notes, dropped} = useMemo(() => readNotes(notesState.data, total), [notesState.data, total]);
  const byAnchor = useMemo(() => {
    const map = new Map<number, Note[]>();
    for (const note of notes) map.set(note.anchor, [...(map.get(note.anchor) ?? []), note]);
    return map;
  }, [notes]);
  const sizeKey = useMemo(() => notes.map(note => `${note.anchor}:${note.text.length}`).join(','), [notes]);
  const showNotes = current && notes.length > 0;
  const rowHeight = useCallback(
    (index: number) => LINE + (showNotes ? (byAnchor.get(index + 1)?.reduce((sum, note) => sum + noteHeight(note), 0) ?? 0) : 0),
    [byAnchor, showNotes],
  );
  const measured = useCallback((index: number) => showNotes && byAnchor.has(index + 1), [byAnchor, showNotes]);

  const rows = useRef<VirtualRowsHandle>(null);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const anchor = useRef<number | undefined>(undefined);
  const settled = useRef<{path?: string; from: number; to: number}>({from: 0, to: 0});

  useEffect(() => {
    if (!current || total === 0) return;
    const before = settled.current;
    if (before.path === path && before.from === targetFrom && before.to === targetTo) return;
    const arrived = before.path !== path;
    settled.current = {path, from: targetFrom, to: targetTo};
    if (arrived) {
      // A new file mounts its rows at its range (see openAt below); there is nothing to scroll.
      setCursor(undefined);
      anchor.current = undefined;
    } else if (targetFrom > 0) {
      // A range that moves inside the file on screen is scrolled to only when it is out of view.
      rows.current?.reveal(Math.min(targetFrom, total) - 1, {lead: LEAD, smooth: true});
    }
  }, [current, total, path, targetFrom, targetTo]);

  // Decision D14: waiting for a selection, and a file that cannot be shown, are truthful states; a file the spec names
  // that is not there is a fault the agent can fix.
  if (!path) return <Empty message="no file selected" code={REPORT_CODES.waiting} />;
  if (lines.error) {
    return (
      <div className={k.failed} data-gl-code-failed="">
        <Redline code="E_FILE" id={`CodeView#${id}`} message={`${path}: ${lines.error}`} />
        <button type="button" className={k.retry} onClick={lines.retry}>Retry</button>
      </div>
    );
  }
  if (!file) return <Drafting label={`reading ${path}`} />;
  if (file.skipped) return <Empty message={(SKIPPED[file.skipped] ?? SKIPPED.missing!)(file.path, file.size)} code={skippedCode(file.skipped, props.file !== undefined)} />;
  if (total === 0) return <Empty message={`${file.path} is empty`} code={REPORT_CODES.truthful} />;

  const shownPath = file.path;
  // Where the rows of a newly shown file open: its range, a few lines down from the top.
  const lead = current && targetFrom > 0 ? Math.max(0, Math.min(targetFrom, total) - 1 - LEAD) : 0;
  const openAt = lead * LINE + (showNotes ? notes.reduce((sum, note) => sum + (note.anchor <= lead ? noteHeight(note) : 0), 0) : 0);
  const lineOf = (n: number | undefined) => formatFileLoc({path: shownPath, line: n && n > 0 ? n : undefined});
  const selectLines = (a: number, b: number) => {
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    // A range picked here is already where the reader is looking: it must not scroll the view back to its first line.
    settled.current = {path: shownPath, from, to};
    select({type: 'file', id: shownPath, path: shownPath, line: from, ...(to > from ? {endLine: to} : {})});
  };
  const pick = (n: number, extend: boolean) => {
    if (extend) selectLines(anchor.current ?? (washFrom || n), n);
    else {
      anchor.current = n;
      selectLines(n, n);
    }
    setCursor(n);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const view = rows.current;
    if (!view) return;
    const {first, last} = view.visible();
    const page = Math.max(1, last - first);
    const at = cursor ?? (current && washFrom > 0 ? washFrom : first + 1);
    let to: number | undefined;
    switch (event.key) {
      case 'ArrowDown': to = cursor === undefined ? at : at + 1; break;
      case 'ArrowUp': to = cursor === undefined ? at : at - 1; break;
      case 'PageDown': to = at + page; break;
      case 'PageUp': to = at - page; break;
      case 'Home': to = 1; break;
      case 'End': to = total; break;
      case 'Enter': case ' ': pick(at, event.shiftKey); break;
      case 'Escape': if (selected) select(null); break;
      case 'o': actions.open(lineOf(cursor ?? targetFrom)); break;
      case 'c': {
        const line = cursor ?? (targetFrom || undefined);
        void navigator.clipboard?.writeText(line ? `${shownPath}:${line}` : shownPath)?.catch(() => {});
        break;
      }
      default: return;
    }
    event.preventDefault();
    if (to === undefined) return;
    const line = Math.min(total, Math.max(1, to));
    setCursor(line);
    view.reveal(line - 1, {near: true});
    if (event.shiftKey) selectLines(anchor.current ?? at, line);
  };

  const bits = (
    <>
      <Crumbs path={shownPath} />
      {file.lang ? <span className={k.badge} data-gl-lang="">{file.lang}</span> : null}
      <span className={k.meta}>{fmtNum(total)} {total === 1 ? 'line' : 'lines'}</span>
      {badMarks.length > 0 ? <span className={k.meta} data-gl-marginal="" data-gl-mark-ignored="" title={ignoredMarksText(badMarks)}>{ignoredMarksText(badMarks)}</span> : null}
      {current && (dropped > 0 || notesState.status === 'error') ? (
        <span className={k.meta} data-gl-marginal="">
          {notesState.status === 'error' ? `notes: ${notesState.message}` : `${fmtNum(dropped)} malformed ${dropped === 1 ? 'note' : 'notes'} dropped`}
        </span>
      ) : null}
    </>
  );
  const open = (
    <button
      type="button"
      className={k.tool}
      tabIndex={-1}
      aria-label={`Open ${shownPath} in the editor`}
      aria-keyshortcuts="o"
      title="Open in editor (o)"
      onClick={() => actions.open(lineOf(current ? targetFrom : undefined))}
    >
      <Icon name="external" />
    </button>
  );

  const renderLine = (index: number): ReactNode => {
    const n = index + 1;
    const tokens = lines.line(n);
    const own = showNotes ? byAnchor.get(n) : undefined;
    const noteMark = showNotes ? (notes.some(note => note.line === n) ? 'start' : notes.some(note => n > note.line && n <= note.anchor) ? 'mid' : undefined) : undefined;
    const isSelected = current && washFrom > 0 && n >= washFrom && n <= washTo;
    const isMarked = current && inRanges(marks, n);
    return (
      <>
        <div
          className={k.line}
          data-line={n}
          data-hl={isSelected || isMarked ? '' : undefined}
          data-selected={isSelected || undefined}
          data-marked={isMarked || undefined}
          data-region={current && regionFrom > 0 && n >= regionFrom && n <= regionTo ? '' : undefined}
          data-cursor={cursor === n ? '' : undefined}
        >
          <button type="button" className={k.num} tabIndex={-1} aria-label={`Select line ${n}`} onClick={event => pick(n, event.shiftKey)}>{n}</button>
          <span className={k.mk} data-note={noteMark} />
          <span className={k.src}>{tokens ? <TokenSpans tokens={tokens} /> : <span className={k.wait} data-gl-wait="" />}</span>
        </div>
        {own ? (
          <div className={k.notes}>
            {own.map((note, i) => (
              <div key={i} className={k.note} role="note" data-gl-note={note.line} data-kind={note.kind}>
                <span className={k.noteTag}>
                  {NOTE_TAG[note.kind]} · agent{note.anchor > note.line ? ` · L${note.line}–${note.anchor}` : ''}
                </span>
                <span className={k.noteText}>{note.text}</span>
              </div>
            ))}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div
      className={k.code}
      data-gl-code="view"
      data-fit={props.fit}
      data-boxed={props.chrome === 'boxed' ? '' : undefined}
      aria-busy={lines.loading || undefined}
      style={{['--gl-digits' as never]: String(total).length}}
    >
      {framed ? (
        <PlateAside><span className={k.bits}>{bits}{open}</span></PlateAside>
      ) : (
        <div className={k.head}><span className={k.bits}>{bits}</span><span className={k.grow} />{open}</div>
      )}
      {current && lines.failed ? (
        <div className={k.notice} role="alert" data-gl-code-failed="">
          <span className={k.noticeText}>
            lines {lines.failed.ranges.map(([from, to]) => `${fmtNum(from)}–${fmtNum(to)}`).join(', ')} did not load: {lines.failed.message}
          </span>
          <button type="button" className={k.retry} onClick={lines.retry}>Retry</button>
        </div>
      ) : null}
      <VirtualRows
        key={shownPath}
        handle={rows}
        role="region"
        aria-label={`${shownPath}, ${total} ${total === 1 ? 'line' : 'lines'}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        count={total}
        rowHeight={rowHeight}
        measured={measured}
        sizeKey={`${showNotes ? sizeKey : ''}`}
        cols={lines.cols}
        colsPad="var(--gl-gutter) + 34px"
        initialOffset={openAt}
        onRange={(first, last) => lines.ensure(first + 1, last + 1)}
      >
        {renderLine}
      </VirtualRows>
    </div>
  );
}

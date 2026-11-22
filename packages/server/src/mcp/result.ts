// Tool results (design 6.1, 6.6): always one text block. Never structuredContent or an outputSchema: Claude Code would
// hand the model the structured value and drop the text.
//
// Two rules hold for every result (decision untrusted-input-contained). Text that comes from the repository (file names, author names,
// commit subjects, dataset summaries, rows) passes through shield(), so it can never start a line with `viewer:`;
// only the lines of the event queue do, and they are appended after the shielded body. And once a `show` has
// committed, formatting its result cannot turn it into a failure.
import {escapeInvisible, flattenBreaks, formatProblems, jsonQuote, NOTHING_RENDERED, oneLine, readsAsViewerLine, SpecError} from '../spec/errors.ts';
import type {DatasetState, ShowOutcome} from '../session/session.ts';

export interface ToolResult {
  content: Array<{type: 'text'; text: string}>;
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Makes a body safe to sit above genuine `viewer:` lines. Carriage returns and the Unicode line separators are
 * flattened first, since some readers break lines on them. A line that a reader would take for a `viewer:` line once
 * look-alike letters, fullwidth forms and invisible characters are seen through (finding V016) is JSON-quoted, so it
 * starts with a quotation mark; in every line, the invisible and direction-changing characters are written out.
 */
export function shield(body: string): string {
  return flattenBreaks(body, true).split('\n').map(line => (readsAsViewerLine(line) ? jsonQuote(line) : escapeInvisible(line))).join('\n');
}

/** A successful result: the shielded body, then what the user did in the tab (`viewer:` lines), if anything. */
export const text = (body: string, events: readonly string[] = []): ToolResult => ({content: [{type: 'text', text: [shield(body), ...events].join('\n')}]});
export const failed = (body: string): ToolResult => ({content: [{type: 'text', text: shield(body)}], isError: true});
/** A result that is nothing but the event queue's own lines (the `events` tool); `none` when there are none. */
export const viewerLines = (lines: readonly string[]): ToolResult => ({content: [{type: 'text', text: lines.length > 0 ? lines.join('\n') : 'none'}]});

/**
 * The error text for anything a tool handler threw. `lastLine` is the fixed closing line of a rejected `show`;
 * other tools pass none.
 */
export function failure(error: unknown, lastLine?: string): ToolResult {
  if (error instanceof SpecError) return failed(formatProblems(error.problems, lastLine ?? null));
  const message = oneLine(error instanceof Error ? error.message : String(error), 300);
  return failed([`E_INTERNAL ${message}`, ...(lastLine === undefined ? [] : [lastLine])].join('\n'));
}

export const showFailure = (error: unknown): ToolResult => failure(error, NOTHING_RENDERED);

/** 1284 -> "1,284", 48213 -> "48.2k", 3400000 -> "3.4M" */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 10_000) return Math.round(value).toLocaleString('en-US');
  if (abs < 1_000_000) return `${(value / 1000).toFixed(abs < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export interface RepoFacts {
  name: string;
  /** False when the project is not a git repository. A repository before its first commit has no head. */
  git?: boolean;
  branch?: string;
  head?: string;
  dirty: boolean;
  /** Files and lines of the inventory: the figures repo.kpis and files.tree report. */
  totals?: {files: number; loc: number};
  /** Rows of files.langs when it settled in time. */
  langs?: Array<{lang?: unknown; files?: unknown; loc?: unknown; pct?: unknown}>;
}

/** `repo glimpse main@4f2a91c dirty | 312 files 48.2k loc | TypeScript 71% CSS 12% Markdown 9%` */
export function repoLine(facts: RepoFacts): string {
  const isGit = facts.git ?? facts.branch !== undefined;
  const at = facts.head ? `${facts.branch ?? 'detached'}@${facts.head.slice(0, 7)}` : isGit ? `${facts.branch ?? 'HEAD'} (no commits)` : '(no git)';
  const parts = [`repo ${oneLine(facts.name, 60)} ${oneLine(at, 80)}${facts.dirty ? ' dirty' : ''}`];
  const rows = (facts.langs ?? []).filter(row => typeof row === 'object' && row !== null && typeof row.lang === 'string');
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const langLoc = rows.reduce((sum, row) => sum + number(row.loc), 0);
  // The inventory when it is known, so this line agrees with the Files KPI and the tree; else the language rows.
  const totals = facts.totals ?? (rows.length > 0 ? {files: rows.reduce((sum, row) => sum + number(row.files), 0), loc: langLoc} : undefined);
  if (totals) parts.push(`${compact(totals.files)} files ${compact(totals.loc)} loc`);
  if (rows.length > 0) {
    const share = (row: (typeof rows)[number]) => (langLoc > 0 ? (number(row.loc) / langLoc) * 100 : number(row.pct));
    const top = [...rows].sort((a, b) => share(b) - share(a)).slice(0, 3).filter(row => share(row) >= 0.5);
    if (top.length > 0) parts.push(top.map(row => `${oneLine(String(row.lang), 24)} ${Math.round(share(row))}%`).join(' '));
  }
  return parts.join(' | ');
}

/**
 * Size a `show` result stays under, viewer lines aside (design 10 allows 1,200 characters for a preset result; the
 * target leaves headroom, decision budgets-keep-headroom).
 */
export const RESULT_BUDGET = 1100;
const MIN_SUMMARY = 48;
const MAX_WARNINGS = 8;
const MAX_FIXES = 6;

const clip = (value: string, max: number) => (value.length > max ? value.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : value);
const sizeOf = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0);

/**
 * Clips the longest summaries until the dataset lines fit in `budget` characters; a clipped summary ends with an
 * ellipsis. No summary is cut below 48 characters here; showText() drops whole lines if that is still too much.
 */
function fitSummaries(lines: Array<{ref: string; summary: string}>, budget: number): void {
  if (lines.length === 0) return;
  const size = () => lines.reduce((sum, line) => sum + line.ref.length + line.summary.length + 7, 0);
  for (let guard = 0; size() > budget && guard < 1000; guard++) {
    const longest = lines.reduce((a, b) => (b.summary.length > a.summary.length ? b : a), lines[0]!);
    if (longest.summary.length <= MIN_SUMMARY) break;
    const cut = Math.max(MIN_SUMMARY, longest.summary.length - 8);
    longest.summary = longest.summary.slice(0, cut - 1).trimEnd() + '…';
  }
}

export interface ShowReport {
  outcome: ShowOutcome;
  elapsedMs: number;
  repo?: string;
  /** State of each requested dataset after the wait, in outcome order. `told`: the model already has this exact line. */
  datasets: Array<{ref: string; state: DatasetState | undefined; told?: boolean}>;
  /** Warnings that only became known during the wait: field checks and what the tab reported. */
  late?: string[];
  events: string[];
}

/**
 * The line every successful `show` starts with. It alone is a complete, true answer. The view's route is a bare label
 * (`#/overview`), not a link: a link without the session token opens "No session" (finding V045). The one link
 * printed is the one that opens the live session, whenever no connected tab shows the view already.
 */
export function okLine(outcome: Pick<ShowOutcome, 'id' | 'url' | 'tab' | 'openUrl'>, elapsedMs: number): string {
  return `ok ${outcome.id} ${outcome.url} tab=${outcome.tab} ${Math.max(0, Math.round(elapsedMs))}ms${outcome.tab !== 'live' ? ` open ${outcome.openUrl}` : ''}`;
}

/**
 * The success text of `show` (design 6.1): one line per item, in a fixed order; lines without content are omitted.
 * Everything but the viewer lines fits RESULT_BUDGET: summaries are clipped first, then the parts list, then whole
 * dataset and warning lines are folded into a count. Dataset lines the model was already given are folded into
 * `ds (+N unchanged)`. Viewer events come last and do not count towards the budget.
 */
export function showText(report: ShowReport): string {
  const {outcome} = report;
  const head = [okLine(outcome, report.elapsedMs)];
  for (const fix of outcome.fixes.slice(0, MAX_FIXES)) head.push(`fixed ${oneLine(fix, 120)}`);
  if (outcome.fixes.length > MAX_FIXES) head.push(`fixed (+${outcome.fixes.length - MAX_FIXES} more repairs)`);
  if (report.repo) head.push(clip(report.repo, 200));

  const warnings = [...outcome.warnings, ...(report.late ?? [])];
  const ds: Array<{ref: string; summary: string}> = [];
  let unchanged = 0;
  // Finding V003: what a source says about its own data ('4 files over 2 MB counted by size only', 'graph cut to 150
  // of 900 nodes') is a caveat of that dataset, not a part the tab could not draw; it rides on the dataset's line,
  // once per result, and never on the `warn` channel, which is for what the model can fix (decision reports-are-component-state).
  const caveats = new Set<string>();
  for (const {ref, state, told} of report.datasets) {
    if (state?.status === 'error') warnings.push(`${ref}: ${state.error?.code ?? 'E_INTERNAL'} ${state.error?.message ?? ''}`.trim());
    else if (told && state?.status === 'ready') unchanged++;
    else {
      const notes = (state?.warnings ?? []).map(warning => oneLine(warning, 120)).filter(note => note && !caveats.has(note));
      for (const note of notes) caveats.add(note);
      const summary = state?.status === 'ready' ? oneLine(state.summary || 'ready', 160) : 'pending';
      ds.push({ref: clip(ref, 120), summary: notes.length > 0 ? clip(`${summary}; ${notes.join('; ')}`, 280) : summary});
    }
  }

  const distinct = [...new Set(warnings.map(warning => oneLine(warning, 200)).filter(Boolean))];
  const warn = distinct.slice(0, MAX_WARNINGS).map(warning => `warn ${warning}`);
  if (distinct.length > MAX_WARNINGS) warn.push(`warn (+${distinct.length - MAX_WARNINGS} more warnings)`);

  let parts = [outcome.parts.length > 0 ? `parts ${outcome.parts.join(' ')}` : '', outcome.slots.length > 0 ? `slots ${outcome.slots.join(' ')}` : ''].filter(Boolean).join(' | ');
  const fixed = () => sizeOf([...head, ...(parts ? [parts] : []), ...warn]) + (unchanged > 0 ? 24 : 0);

  fitSummaries(ds, RESULT_BUDGET - fixed());
  const dsSize = () => ds.reduce((sum, line) => sum + line.ref.length + line.summary.length + 7, 0);
  // Still too long: a very long parts list gives way, then the warnings shorten, then datasets fold into a count.
  if (fixed() + dsSize() > RESULT_BUDGET && parts.length > 160) parts = clip(parts, 160);
  for (let i = warn.length - 1; i >= 0 && fixed() + dsSize() > RESULT_BUDGET; i--) warn[i] = clip(warn[i]!, 100);
  let folded = 0;
  if (fixed() + dsSize() > RESULT_BUDGET) {
    // The line that says how many were folded needs room of its own.
    while (ds.length > 1 && fixed() + dsSize() + 52 > RESULT_BUDGET) { ds.pop(); folded++; }
  }
  let dropped = 0;
  if (fixed() + dsSize() + (folded > 0 ? 52 : 0) > RESULT_BUDGET) {
    while (warn.length > 1 && fixed() + dsSize() + (folded > 0 ? 52 : 0) + 28 > RESULT_BUDGET) { warn.pop(); dropped++; }
  }
  if (dropped > 0) warn.push(`warn (+${dropped} more warnings)`);

  const lines = [
    ...head,
    ...ds.map(line => `ds ${line.ref} | ${line.summary}`),
    ...(folded > 0 ? [`ds (+${folded} more: query{ref} reads any of them)`] : []),
    ...(unchanged > 0 ? [`ds (+${unchanged} unchanged)`] : []),
    ...(parts ? [parts] : []),
    ...warn,
  ];
  return [shield(lines.join('\n')), ...report.events].join('\n');
}

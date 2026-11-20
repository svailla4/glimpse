// Tool results (design 6.1, 6.6): always one text block. Never structuredContent or an outputSchema: Claude Code would
// hand the model the structured value and drop the text.
import {formatProblems, NOTHING_RENDERED, oneLine, SpecError} from '../spec/errors.ts';
import type {DatasetState, ShowOutcome} from '../session/session.ts';

export interface ToolResult {
  content: Array<{type: 'text'; text: string}>;
  isError?: boolean;
  [key: string]: unknown;
}

export const text = (body: string): ToolResult => ({content: [{type: 'text', text: body}]});
export const failed = (body: string): ToolResult => ({content: [{type: 'text', text: body}], isError: true});

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
  branch?: string;
  head?: string;
  dirty: boolean;
  /** Rows of files.langs when it settled in time. */
  langs?: Array<{lang?: unknown; files?: unknown; loc?: unknown; pct?: unknown}>;
}

/** `repo glimpse main@4f2a91c dirty | 312 files 48.2k loc | TypeScript 71% CSS 12% Markdown 9%` */
export function repoLine(facts: RepoFacts): string {
  const at = facts.head ? `${facts.branch ?? 'detached'}@${facts.head.slice(0, 7)}` : '(no git)';
  const parts = [`repo ${oneLine(facts.name, 60)} ${oneLine(at, 80)}${facts.dirty ? ' dirty' : ''}`];
  const rows = (facts.langs ?? []).filter(row => typeof row === 'object' && row !== null && typeof row.lang === 'string');
  if (rows.length > 0) {
    const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const files = rows.reduce((sum, row) => sum + number(row.files), 0);
    const loc = rows.reduce((sum, row) => sum + number(row.loc), 0);
    parts.push(`${compact(files)} files ${compact(loc)} loc`);
    const share = (row: (typeof rows)[number]) => (loc > 0 ? (number(row.loc) / loc) * 100 : number(row.pct));
    const top = [...rows].sort((a, b) => share(b) - share(a)).slice(0, 3).filter(row => share(row) >= 0.5);
    if (top.length > 0) parts.push(top.map(row => `${oneLine(String(row.lang), 24)} ${Math.round(share(row))}%`).join(' '));
  }
  return parts.join(' | ');
}

/** Size a `show` result aims to stay under (design 10: a preset result is at most 1,200 characters). */
const RESULT_BUDGET = 1200;
const MIN_SUMMARY = 48;

/**
 * Clips the longest summaries until the dataset lines fit in `budget` characters; a clipped summary ends with an
 * ellipsis. No summary is cut below 48 characters, so a view with very many datasets can still exceed the budget.
 */
function fitSummaries(lines: Array<{ref: string; summary: string}>, budget: number): void {
  const size = () => lines.reduce((sum, line) => sum + line.ref.length + line.summary.length + 7, 0);
  for (let guard = 0; size() > budget && guard < 1000; guard++) {
    const longest = lines.reduce((a, b) => (b.summary.length > a.summary.length ? b : a));
    if (longest.summary.length <= MIN_SUMMARY) break;
    const cut = Math.max(MIN_SUMMARY, longest.summary.length - 8);
    longest.summary = longest.summary.slice(0, cut - 1).trimEnd() + '…';
  }
}

export interface ShowReport {
  outcome: ShowOutcome;
  elapsedMs: number;
  repo?: string;
  /** State of each requested dataset after the wait, in outcome order. */
  datasets: Array<{ref: string; state: DatasetState | undefined}>;
  events: string[];
}

/**
 * The success text of `show` (design 6.1): one line per item, in a fixed order; lines without content are omitted.
 * Viewer events come last and do not count towards the size budget.
 */
export function showText(report: ShowReport): string {
  const {outcome} = report;
  const head = [`ok ${outcome.id} ${outcome.url} tab=${outcome.tab} ${Math.max(0, Math.round(report.elapsedMs))}ms${outcome.tab === 'none' ? ` open ${outcome.openUrl}` : ''}`];
  for (const fix of outcome.fixes) head.push(`fixed ${oneLine(fix, 120)}`);
  if (report.repo) head.push(report.repo);

  const warnings = [...outcome.warnings];
  const ds: Array<{ref: string; summary: string}> = [];
  for (const {ref, state} of report.datasets) {
    if (state?.status === 'error') warnings.push(`${ref}: ${state.error?.code ?? 'E_INTERNAL'} ${state.error?.message ?? ''}`.trim());
    else ds.push({ref, summary: state?.status === 'ready' ? oneLine(state.summary || 'ready', 160) : 'pending'});
    for (const warning of state?.warnings ?? []) warnings.push(warning);
  }

  const tail: string[] = [];
  if (outcome.parts.length > 0 || outcome.slots.length > 0) {
    tail.push([outcome.parts.length > 0 ? `parts ${outcome.parts.join(' ')}` : '', outcome.slots.length > 0 ? `slots ${outcome.slots.join(' ')}` : ''].filter(Boolean).join(' | '));
  }
  for (const warning of [...new Set(warnings.map(w => oneLine(w, 200)))].slice(0, 8)) tail.push(`warn ${warning}`);

  fitSummaries(ds, RESULT_BUDGET - [...head, ...tail].reduce((sum, line) => sum + line.length + 1, 0));
  return [...head, ...ds.map(line => `ds ${line.ref} | ${line.summary}`), ...tail, ...report.events].join('\n');
}

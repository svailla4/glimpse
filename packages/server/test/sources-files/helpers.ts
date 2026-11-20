// Shared by the source tests: a RepoContext over a directory, the sources with a pinned clock, and shape checks.
import {basename} from 'node:path';
import {parseRef, SOURCE_BY_NAME, type DirNode, type Field, type GraphData, type SourceMeta} from '@glimpse/catalog';
import {expect} from 'vitest';
import {createRepoIndex} from '../../src/analyze/index.ts';
import type {RepoContext, RunGit, Source, SourceResult} from '../../src/contracts.ts';
import {createFilesSources} from '../../src/sources/files/index.ts';
import {createRunGit} from '../fixtures/repo.ts';

/** Sixteen days after the last commit of the fixture repository. */
export const NOW = Date.parse('2026-11-20T00:00:00Z');
export const SOURCES: ReadonlyMap<string, Source> = new Map(createFilesSources({now: () => NOW}).map(source => [source.meta.name, source]));
export const MINE = [...SOURCES.keys()];

const noGit: RunGit = () => Promise.reject(new Error('fatal: not a git repository'));

export function makeContext(root: string, options: {git?: boolean; shallow?: boolean; logged?: string[]} = {}): RepoContext {
  const git = options.git !== false;
  const runGit = git ? createRunGit(root) : noGit;
  const log = (message: string) => void options.logged?.push(message);
  return {root, name: basename(root), git: git ? {shallow: options.shallow === true, branch: 'main'} : null, runGit, index: createRepoIndex(root, runGit, log), rev: () => 1, log};
}

export function run(ctx: RepoContext, text: string, signal = new AbortController().signal): Promise<SourceResult> {
  const ref = parseRef(text);
  const source = SOURCES.get(ref.source);
  if (!source) throw new Error(`not one of the files sources: ${ref.source}`);
  return source.run(ctx, ref, signal);
}

export async function failure(ctx: RepoContext, text: string): Promise<{code?: string; message?: string}> {
  return run(ctx, text).then(() => ({}), error => ({code: (error as {code?: string}).code, message: (error as Error).message}));
}

const NUMERIC = new Set(['num', 'bytes', 'pct', 'duration', 'bar', 'heat']);
const TEXTUAL = new Set(['text', 'path', 'symbol', 'module', 'author', 'commit', 'lang', 'chip', 'code', 'date']);

function checkRows(meta: SourceMeta, result: SourceResult, fields: Field[]): void {
  const rows = result.data as Array<Record<string, unknown>>;
  expect(Array.isArray(rows), `${meta.name}: rows`).toBe(true);
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field.key];
      if (value === undefined) continue;
      if (NUMERIC.has(field.kind ?? 'text')) expect(typeof value, `${meta.name}.${field.key}`).toBe('number');
      else if (TEXTUAL.has(field.kind ?? 'text')) expect(typeof value, `${meta.name}.${field.key}`).toBe('string');
    }
    for (const field of fields.filter(candidate => candidate.priority === 1)) expect(row[field.key], `${meta.name}.${field.key} is always present`).toBeDefined();
  }
  expect(result.summary, `${meta.name}: summary lists the fields`).toContain(`fields ${fields.map(field => field.key).join(' ')}`);
}

function countTree(node: DirNode, seen: Set<string>): number {
  expect(typeof node.name).toBe('string');
  expect(seen.has(node.path), `tree path ${node.path} is unique`).toBe(false);
  seen.add(node.path);
  for (const key of ['files', 'loc', 'bytes'] as const) expect(Number.isFinite(node[key]) && node[key] >= 0, `${node.path}.${key}`).toBe(true);
  if (!node.dir) {
    expect(node.children).toBeUndefined();
    expect(node.files).toBe(1);
    return 1;
  }
  const children = node.children ?? [];
  const shown = children.reduce((sum, child) => sum + child.files, 0);
  expect(shown + (node.more?.files ?? 0), `${node.path || '.'}: children and rollup add up to its files`).toBe(node.files);
  expect(children.reduce((sum, child) => sum + child.loc, 0) + (node.more?.loc ?? 0)).toBe(node.loc);
  return 1 + children.reduce((sum, child) => sum + countTree(child, seen), 0);
}

function checkGraph(meta: SourceMeta, graph: GraphData): void {
  const ids = new Set(graph.nodes.map(node => node.id));
  expect(ids.size, `${meta.name}: node ids are unique`).toBe(graph.nodes.length);
  expect(graph.nodes.length).toBeLessThanOrEqual(meta.budget);
  expect(graph.edges.length).toBeLessThanOrEqual(400);
  for (const node of graph.nodes) {
    expect(typeof node.label === 'string' && node.label.length > 0, `${node.id} has a label`).toBe(true);
    if (node.group) expect(graph.groups?.some(group => group.id === node.group), `${node.id}: group ${node.group} exists`).toBe(true);
  }
  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    expect(ids.has(edge.from) && ids.has(edge.to), `${meta.name}: edge ${edge.from} -> ${edge.to} joins known nodes`).toBe(true);
    expect(edge.from).not.toBe(edge.to);
    expect(pairs.has(`${edge.from}\0${edge.to}`)).toBe(false);
    pairs.add(`${edge.from}\0${edge.to}`);
  }
  expect(['module', 'file']).toContain(graph.level);
}

/** Checks a result against the shape, budget and summary rules of its source. Returns the node or row count. */
export function checkResult(name: string, result: SourceResult): number {
  const meta = SOURCE_BY_NAME.get(name)!;
  expect(result.summary.length, `${name}: summary "${result.summary}"`).toBeLessThanOrEqual(160);
  expect(result.summary).not.toMatch(/\n/);
  expect(result.summary.length).toBeGreaterThan(0);
  if (result.truncated) {
    expect(result.truncated.returned).toBeLessThanOrEqual(result.truncated.total);
    expect(['topN', 'treecut', 'window', 'bucket', 'neighborhood']).toContain(result.truncated.strategy);
  }
  for (const warning of result.warnings ?? []) expect(typeof warning === 'string' && warning.length > 0).toBe(true);
  if (result.warnings) expect(result.warnings.length).toBeGreaterThan(0);
  // every result must survive the trip into the data model
  expect(JSON.parse(JSON.stringify(result.data))).toEqual(result.data);

  if (meta.kind === 'tree') {
    const nodes = countTree(result.data as DirNode, new Set());
    expect(nodes).toBeLessThanOrEqual(meta.budget);
    return nodes;
  }
  if (meta.kind === 'graph') {
    checkGraph(meta, result.data as GraphData);
    return (result.data as GraphData).nodes.length;
  }
  const rows = result.data as unknown[];
  expect(rows.length, `${name}: within its budget`).toBeLessThanOrEqual(meta.budget);
  expect(result.total).toBeGreaterThanOrEqual(rows.length);
  if (meta.shape === 'StatItem[]') {
    for (const item of rows as Array<Record<string, unknown>>) expect(typeof item.label === 'string' && ['number', 'string'].includes(typeof item.value)).toBe(true);
    expect(result.summary).toContain('fields label value');
  } else if (meta.shape === 'ChipItem[]') {
    for (const item of rows) expect(typeof item === 'string' || typeof (item as {label?: unknown}).label === 'string').toBe(true);
    expect(result.summary).toContain('fields label');
  } else checkRows(meta, result, result.fields ?? meta.fields ?? []);
  if (meta.pageable) expect(Array.isArray(result.allRows), `${name}: keeps rows for paging`).toBe(true);
  else expect(result.allRows).toBeUndefined();
  return rows.length;
}

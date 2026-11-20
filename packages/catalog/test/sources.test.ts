import {describe, expect, it} from 'vitest';
import {SOURCE_BY_NAME, SOURCES, acceptsArg, datasetKey, formatRef, isDataset, looksLikeRef, parseRef, sourceDoc, type A2uiMessage} from '../src/index.ts';
import {corpus} from './support.ts';

describe('source refs', () => {
  it.each([
    ['git.churn', {source: 'git.churn', args: {}}],
    ['git.churn src/auth top=20 since=90d', {source: 'git.churn', target: 'src/auth', args: {top: '20', since: '90d'}}],
    ['  files.tree   my dir/with spaces ', {source: 'files.tree', target: 'my dir/with spaces', args: {}}],
    ['diff.stats main..HEAD', {source: 'diff.stats', target: 'main..HEAD', args: {}}],
    ['code.refs a=b', {source: 'code.refs', args: {a: 'b'}}],
    ['code.refs A=b =x 9=1', {source: 'code.refs', target: 'A=b =x 9=1', args: {}}],
  ])('parseRef(%j)', (text, ref) => {
    expect(parseRef(text)).toEqual(ref);
  });

  it('formatRef is canonical: source, target, args sorted by key', () => {
    expect(formatRef(parseRef('git.churn top=20 src/auth since=90d'))).toBe('git.churn src/auth since=90d top=20');
    expect(formatRef({source: 'files.tree', args: {}})).toBe('files.tree');
  });

  it('datasetKey is the bare source, or the source plus six hex digits of the rest', () => {
    expect(datasetKey(parseRef('git.churn'))).toBe('git_churn');
    expect(datasetKey(parseRef('git.hotspots top=15'))).toBe('git_hotspots_09d09a');
    expect(datasetKey(parseRef('git.churn src top=5'))).toMatch(/^git_churn_[0-9a-f]{6}$/);
    // the same ref written two ways binds one dataset
    expect(datasetKey(parseRef('git.churn since=90d top=5 src'))).toBe(datasetKey(parseRef('git.churn src top=5 since=90d')));
    expect(datasetKey(parseRef('git.churn src'))).not.toBe(datasetKey(parseRef('git.churn lib')));
  });

  it('looksLikeRef recognises `word.word` first words only', () => {
    expect(looksLikeRef('git.churn src top=5')).toBe(true);
    expect(looksLikeRef('made.up')).toBe(true);
    expect(looksLikeRef('3.1k')).toBe(false);
    expect(looksLikeRef('Hello world.')).toBe(false);
    expect(looksLikeRef(42)).toBe(false);
  });

  it('every source has a unique name, a positive budget and a shape; rows sources that page declare fields', () => {
    expect(SOURCE_BY_NAME.size).toBe(SOURCES.length);
    for (const source of SOURCES) {
      expect(source.name).toMatch(/^[a-z]+\.[a-z]+$/);
      expect(looksLikeRef(source.name)).toBe(true);
      expect(source.budget).toBeGreaterThan(0);
      expect(source.shape.length).toBeGreaterThan(0);
      expect(source.doc.length).toBeGreaterThan(0);
      if (source.pageable) expect(source.kind).toBe('rows');
      if (source.pageable) expect(source.fields?.length).toBeGreaterThan(0);
      if (source.targetRequired) expect(source.target).toBeDefined();
      for (const role of Object.values(source.roles ?? {}).flat()) {
        const rowKeys = source.fields?.map(f => f.key) ?? [];
        // roles may name a row field that is not a default column (diff.files value 'add', git.hotspots size 'sloc')
        expect(typeof role === 'string' && (rowKeys.includes(role) || ['add', 'sloc'].includes(role)), `${source.name} role ${role}`).toBe(true);
      }
    }
  });

  it('acceptsArg: names listed in args, plus top on every rows source', () => {
    const meta = (name: string) => SOURCE_BY_NAME.get(name)!;
    expect(acceptsArg(meta('git.churn'), 'since')).toBe(true);
    expect(acceptsArg(meta('git.churn'), 'top')).toBe(true);
    expect(acceptsArg(meta('deps.modules'), 'focus')).toBe(true);
    // top is not listed for these rows sources and still works
    for (const name of ['repo.packages', 'deps.cycles', 'git.coupling', 'diff.files', 'code.refs']) expect(acceptsArg(meta(name), 'top'), name).toBe(true);
    // top means nothing on a tree or a graph, and since only where it is listed
    expect(acceptsArg(meta('files.tree'), 'top')).toBe(false);
    expect(acceptsArg(meta('deps.modules'), 'top')).toBe(false);
    expect(acceptsArg(meta('code.todos'), 'since')).toBe(false);
    expect(acceptsArg(meta('git.churn'), 'toString')).toBe(false);
  });

  it('git.log documents that its target is a path or a range', () => {
    expect(SOURCE_BY_NAME.get('git.log')?.target).toBe('path|range');
    expect(sourceDoc('git.log')).toContain("'git.log [path|range] [top=] [since=]'");
  });

  it('every ref in the conformance corpus passes the checks the spec pipeline applies before running a source', () => {
    const datasetsOf = (message: A2uiMessage): unknown[] => {
      if ('createSurface' in message) return Object.values((message.createSurface.dataModel?.ds as object | undefined) ?? {});
      if ('updateDataModel' in message && message.updateDataModel.path?.startsWith('/ds/')) return [message.updateDataModel.value];
      return [];
    };
    let checked = 0;
    for (const entry of corpus()) {
      for (const dataset of entry.messages.flatMap(datasetsOf)) {
        if (!isDataset(dataset)) continue;
        const ref = parseRef(dataset.source);
        const meta = SOURCE_BY_NAME.get(ref.source);
        expect(meta, `${entry.label}: ${dataset.source}`).toBeDefined();
        if (meta?.targetRequired) expect(ref.target, `${entry.label}: ${dataset.source} needs a target`).toBeTruthy();
        for (const arg of Object.keys(ref.args)) expect(meta && acceptsArg(meta, arg), `${entry.label}: ${dataset.source} ${arg}=`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

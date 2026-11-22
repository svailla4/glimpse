import {describe, expect, it} from 'vitest';
import {SOURCE_BY_NAME, SOURCES, acceptsArg, datasetKey, fieldsFor, formatRef, isDataset, looksLikeRef, parseRef, sourceDoc, variantWithField, type A2uiMessage} from '../src/index.ts';
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
    // top means nothing on a tree or a graph unless the source lists it, and since only where it is listed
    expect(acceptsArg(meta('files.tree'), 'top')).toBe(false);
    expect(acceptsArg(meta('deps.files'), 'top')).toBe(false);
    // readable-module-graph: the module graph is cut to about 24 nodes by default, and top= raises it
    expect(acceptsArg(meta('deps.modules'), 'top')).toBe(true);
    expect(sourceDoc('deps.modules')).toContain("'deps.modules [path] [top=] [focus=] [depth=]'");
    expect(acceptsArg(meta('code.todos'), 'since')).toBe(false);
    expect(acceptsArg(meta('git.churn'), 'toString')).toBe(false);
  });

  // fresh-tree-every-call / F060: deps.* and repo.* read the working tree but were cached per HEAD, so an agent that had just edited
  // imports saw the pre-edit graph until someone committed.
  it('every source computed from the working tree says so: files.*, repo.*, deps.*, code.*, diff.* and the git.* sources that join history with it', () => {
    // git.hotspots takes complexity, sloc and generated flags from the working-tree index; git.timeline names its
    // series after the working-tree module cut. Both go stale on an edit like any working-tree source.
    const joined = new Set(['git.hotspots', 'git.timeline']);
    for (const source of SOURCES) {
      const group = source.name.split('.')[0]!;
      expect(source.wt === true, source.name).toBe(['files', 'repo', 'deps', 'code', 'diff'].includes(group) || joined.has(source.name));
    }
    expect(SOURCES.filter(s => s.wt).map(s => s.name)).toEqual(expect.arrayContaining(['repo.stack', 'repo.packages', 'repo.scripts', 'deps.modules', 'deps.files', 'deps.cycles', 'deps.external', 'deps.matrix']));
  });

  // V008 / guessed-fields-repaired: 'git.churn by=module' returns module rows, so a field name asked of it is checked against those.
  it('fieldsFor gives the fields and roles of the rows a ref returns, a variant when an argument selects one', () => {
    const churn = SOURCE_BY_NAME.get('git.churn')!;
    expect(acceptsArg(churn, 'by')).toBe(true);
    expect(fieldsFor(churn)).toEqual({fields: churn.fields, roles: churn.roles});
    expect(fieldsFor(churn, {by: 'file'})).toEqual({fields: churn.fields, roles: churn.roles});
    const byModule = fieldsFor(churn, {by: 'module', top: '20'});
    expect(byModule.fields!.map(field => field.key)).toEqual(['module', 'commits', 'authors', 'files']);
    expect(byModule.roles).toEqual({label: 'module', value: 'commits', x: 'module', y: ['commits']});
    expect(fieldsFor(churn, {by: ' Module '})).toBe(byModule);
    // a source without variants, or with no fields at all
    expect(fieldsFor(SOURCE_BY_NAME.get('files.langs')!, {by: 'module'}).fields!.map(field => field.key)).toEqual(['lang', 'files', 'loc', 'pct']);
    expect(fieldsFor(SOURCE_BY_NAME.get('deps.modules')!)).toEqual({});
    // an argument named after an Object.prototype member selects nothing
    expect(fieldsFor(churn, JSON.parse('{"__proto__": {"by": "module"}}') as Record<string, string>)).toEqual({fields: churn.fields, roles: churn.roles});
  });

  // V008: both writers asked git.churn for 'module' and got per-file bars; the server can name the ref that has it.
  it('variantWithField names the variant whose rows carry a field the plain rows lack', () => {
    const churn = SOURCE_BY_NAME.get('git.churn')!;
    expect(variantWithField(churn, 'module')).toBe('by=module');
    expect(variantWithField(churn, ' Module ')).toBe('by=module');
    expect(variantWithField(churn, 'commits')).toBeUndefined(); // the per-file rows have it
    expect(variantWithField(churn, 'zzz')).toBeUndefined();
    expect(variantWithField(SOURCE_BY_NAME.get('git.hotspots')!, 'module')).toBeUndefined();
  });

  it('every variant is selected by an argument the source accepts, and its roles name its own fields', () => {
    for (const source of SOURCES) {
      for (const [selector, variant] of Object.entries(source.variants ?? {})) {
        const [arg, value] = selector.split('=');
        expect(acceptsArg(source, arg!), `${source.name} ${selector}`).toBe(true);
        expect(value, selector).toMatch(/^[a-z]+$/);
        const keys = variant.fields.map(field => field.key);
        for (const role of Object.values(variant.roles ?? {}).flat()) expect(keys, `${source.name} ${selector} role ${role}`).toContain(role);
      }
    }
  });

  it('git.log documents that its target is a path or a range', () => {
    expect(SOURCE_BY_NAME.get('git.log')?.target).toBe('path|range');
    expect(sourceDoc('git.log')).toContain("'git.log [path|range] [top=] [since=]'");
  });

  it('documents a path target on every source that reads one at run time, so catalog{} tells the model', () => {
    for (const name of ['files.langs', 'repo.kpis', 'repo.stack', 'repo.packages', 'repo.scripts', 'deps.cycles', 'deps.external', 'deps.matrix']) {
      expect(SOURCE_BY_NAME.get(name)?.target, name).toBe('path');
      expect(sourceDoc(name), name).toMatch(new RegExp(`^'${name.replace('.', '\\.')} \\[path\\]`));
    }
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

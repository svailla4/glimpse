// The pure registry helpers, with fake sources only: this file loads no analyzer and no git code.
import {SOURCE_BY_NAME, SOURCES, type SourceMeta} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import {SourceError, type RepoContext, type Source} from '../../src/contracts.ts';
import {checkRegistry, createRegistry, missingSources, notImplemented, resolveSource} from '../../src/sources/registry.ts';

const fakeMeta: SourceMeta = {name: 'fake.rows', kind: 'rows', doc: 'Test source.', shape: 'Rows', budget: 10};
const fake: Source = {meta: fakeMeta, run: async () => ({data: [{a: 1}], summary: '1 row; fields a'})};
// The sources below never read their context.
const ctx = {} as RepoContext;
const signal = new AbortController().signal;

describe('source registry helpers', () => {
  it('missingSources lists catalog sources without an implementation, in catalog order', () => {
    expect(missingSources(createRegistry(SOURCES.map(notImplemented)))).toEqual([]);
    expect(missingSources(createRegistry([]))).toEqual(SOURCES.map(s => s.name));
    expect(missingSources(createRegistry([fake, notImplemented(SOURCE_BY_NAME.get('git.log')!)]))).toEqual(SOURCES.map(s => s.name).filter(name => name !== 'git.log'));
  });

  it('checkRegistry logs one line naming what is missing and never throws', () => {
    const logged: string[] = [];
    const missing = checkRegistry(m => void logged.push(m), createRegistry([notImplemented(SOURCE_BY_NAME.get('files.tree')!)]));
    expect(missing).toHaveLength(25);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^glimpse: 25 of 26 sources are not implemented: files\.list /);
    const quiet: string[] = [];
    expect(checkRegistry(m => void quiet.push(m), createRegistry(SOURCES.map(notImplemented)))).toEqual([]);
    expect(quiet).toEqual([]);
  });

  it('a catalog source without an implementation resolves to a stand-in that fails with E_INTERNAL', async () => {
    const empty = createRegistry([]);
    const source = resolveSource('git.churn', empty)!;
    expect(source.meta).toBe(SOURCE_BY_NAME.get('git.churn'));
    const error = await source.run(ctx, {source: 'git.churn', args: {}}, signal).catch(e => e);
    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({code: 'E_INTERNAL', message: 'not implemented'});
  });

  it('an unknown name resolves to nothing; an injected fake resolves and runs', async () => {
    const registry = createRegistry([notImplemented(SOURCE_BY_NAME.get('files.tree')!), fake]);
    expect(resolveSource('git.nope', registry)).toBeUndefined();
    expect(resolveSource('fake.rows', registry)).toBe(fake);
    expect(await resolveSource('fake.rows', registry)!.run(ctx, {source: 'fake.rows', args: {}}, signal)).toEqual({data: [{a: 1}], summary: '1 row; fields a'});
    // later entries win, so a test can shadow a real source
    const shadow: Source = {meta: SOURCE_BY_NAME.get('files.tree')!, run: fake.run};
    expect(resolveSource('files.tree', createRegistry([...registry.values(), shadow]))).toBe(shadow);
  });
});

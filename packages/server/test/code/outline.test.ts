import type {SymbolRow} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createCodeService} from '../../src/code/index.ts';
import type {FileFacts} from '../../src/contracts.ts';
import {makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {makeContext} from '../git/context.ts';

describe('code service: outline', () => {
  let repo: FixtureRepo;
  beforeAll(async () => { repo = await makeFixtureRepo({dirty: false}); });
  afterAll(async () => { await repo.cleanup(); });

  it('returns the symbols the index found for the file, in line order', async () => {
    const ctx = await makeContext(repo.root);
    const code = createCodeService(ctx);
    expect(await code.outline('src/auth/tokens.ts')).toEqual({
      path: 'src/auth/tokens.ts',
      symbols: [
        {name: 'sign', kind: 'fn', line: 5, endLine: 7, depth: 0, exported: true},
        {name: 'newToken', kind: 'fn', line: 9, endLine: 12, depth: 0, exported: true},
      ],
    });
    // a file location is accepted; the answer names the file
    expect((await code.outline('./src/auth/tokens.ts#L9-12')).path).toBe('src/auth/tokens.ts');
    expect(ctx.index.calls.facts).toBe(2);
  });

  it('is empty for files the index has no symbols for', async () => {
    const code = createCodeService(await makeContext(repo.root));
    expect(await code.outline('src/index.ts')).toEqual({path: 'src/index.ts', symbols: []});
    expect(await code.outline('README.md')).toEqual({path: 'README.md', symbols: []});
    expect(await code.outline('no/such/file.ts')).toEqual({path: 'no/such/file.ts', symbols: []});
  });

  it('drops malformed symbols and repairs incomplete ones', async () => {
    const symbols = [
      {name: 'ok', kind: 'class', line: 3, depth: 1, exported: false},
      {name: '', kind: 'fn', line: 4, depth: 0, exported: true},
      {name: 'badKind', kind: 'widget', line: 5, depth: 0, exported: true},
      {name: 'badLine', kind: 'fn', line: 0, depth: 0, exported: true},
      {name: 'noLine', kind: 'fn', depth: 0, exported: true},
      {name: 'loose', kind: 'const', line: 1, depth: -2, exported: 'yes'},
      null,
      'text',
    ] as unknown as SymbolRow[];
    const facts = new Map<string, FileFacts>([['a.ts', {imports: [], symbols, complexity: 0, maxIndent: 0, todos: []}]]);
    const code = createCodeService(await makeContext(repo.root, {index: {facts: () => Promise.resolve(facts)}}));
    expect((await code.outline('a.ts')).symbols).toEqual([
      {name: 'loose', kind: 'const', line: 1, depth: 0, exported: false},
      {name: 'ok', kind: 'class', line: 3, depth: 1, exported: false},
    ]);
  });

  it('rejects paths outside the repository and passes index failures on', async () => {
    const code = createCodeService(await makeContext(repo.root));
    for (const path of ['../x.ts', '/etc/passwd', '', '.']) await expect(code.outline(path), path).rejects.toMatchObject({code: 'E_TARGET'});
    const broken = createCodeService(await makeContext(repo.root, {index: {facts: () => Promise.reject(new Error('index down'))}}));
    await expect(broken.outline('src/index.ts')).rejects.toThrow('index down');
  });
});

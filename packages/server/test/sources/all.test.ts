// Shared gate: the only test that loads every source implementation and every stub factory at once. It can go red
// because of any server package, so it checks only what must hold however far those packages have got: names and
// export shapes. It never calls a factory or runs a source; behaviour is tested by the package that owns it.
import {SOURCE_BY_NAME} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import {REGISTRY} from '../../src/sources/all.ts';
import {missingSources} from '../../src/sources/registry.ts';

describe('production registry', () => {
  it('holds only catalog sources, each under its own name and with the catalog metadata', () => {
    for (const [name, source] of REGISTRY) {
      expect(source.meta.name).toBe(name);
      expect(source.meta, `${name} uses the SourceMeta from @glimpse/catalog`).toEqual(SOURCE_BY_NAME.get(name));
      expect(typeof source.run).toBe('function');
    }
  });

  it('whatever is not registered is reported as missing', () => {
    expect(missingSources(REGISTRY).length + REGISTRY.size).toBe(SOURCE_BY_NAME.size);
  });
});

describe('factories behind the server seams', () => {
  it('are exported under the frozen names', async () => {
    const analyze = await import('../../src/analyze/index.ts');
    const code = await import('../../src/code/index.ts');
    const git = await import('../../src/git/index.ts');
    expect(typeof analyze.createRepoIndex).toBe('function');
    expect(typeof code.createCodeService).toBe('function');
    expect(typeof git.readGitInfo).toBe('function');
    expect(typeof git.createDiffService).toBe('function');
    expect(typeof git.createTreeWatcher).toBe('function');
  });
});

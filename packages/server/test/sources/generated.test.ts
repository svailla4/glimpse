// A lockfile changes with every dependency bump and a changelog with every release (or every commit), so they topped
// "Most changed files" and paired with everything in "Changes together" while saying nothing about the code. The
// per-file rankings of churn and coupling leave out the files the inventory marks as generated and the changelogs,
// and say how many; such a file asked for by name is still listed. Other prose (a guide) and code named like a
// changelog (src/history.ts) stay.
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {parseRef, type Rows} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {RepoContext, SourceResult} from '../../src/contracts.ts';
import {createGitSources} from '../../src/sources/git/git.ts';
import {git} from '../fixtures/repo.ts';
import {makeContext} from '../sources-files/helpers.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const SOURCES = new Map(createGitSources({now: () => NOW}).map(source => [source.meta.name, source]));

const identity = (name: string, date: string): Record<string, string> => {
  const address = [name.toLowerCase().replace(/\s+/g, '.'), ['example', 'test'].join('.')].join('@');
  return {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: address, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date};
};

let root: string;
let ctx: RepoContext;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-generated-')));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), {recursive: true});
      await writeFile(join(root, path), text);
    }
  };
  let version = 0;
  let notes = '# Changelog\n';
  // Every commit bumps the version: the manifest, its lockfile and the changelog change each time.
  const bump = (entry: string) => {
    version++;
    notes += `\n## 1.0.${version}\n- ${entry}\n`;
    return {
      'package.json': JSON.stringify({name: 'app', version: `1.0.${version}`, dependencies: {zod: '^3.25.0'}}, null, 2),
      'package-lock.json': JSON.stringify({name: 'app', lockfileVersion: 3, packages: {'': {version: `1.0.${version}`}}}, null, 2),
      'CHANGELOG.md': notes,
    };
  };
  for (const day of ['01', '02', '03']) {
    await write({
      ...bump(`change a and b ${day}`),
      'src/a.ts': `export const a = ${version};\n`,
      'src/b.ts': `export const b = ${version};\n`,
      'src/history.ts': `export const history: number[] = [${version}];\n`,
      'docs/guide.md': `# Guide\n\nVersion 1.0.${version}.\n`,
    });
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '--no-gpg-sign', '-m', `Change a and b, release ${day}`], identity('Ann Webb', `2026-11-${day}T10:00:00Z`));
  }
  // Dependency bumps touch only the manifest, its lockfile and the changelog.
  for (const day of ['04', '05', '06']) {
    await write(bump(`bump dependencies ${day}`));
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '--no-gpg-sign', '-m', `Bump dependencies ${day}`], identity('Bot Bumper', `2026-11-${day}T10:00:00Z`));
  }
  ctx = makeContext(root);
});
afterAll(async () => {
  if (root?.includes('glimpse-generated-')) await rm(root, {recursive: true, force: true});
});

function run(text: string): Promise<SourceResult<Rows>> {
  const ref = parseRef(text);
  return SOURCES.get(ref.source)!.run(ctx, ref, new AbortController().signal) as Promise<SourceResult<Rows>>;
}

const pairs = (result: SourceResult<Rows>) => result.data.map(row => `${row.a} + ${row.b}`);

describe('generated files and changelogs in the per-file rankings', () => {
  it('git.churn leaves a lockfile and a changelog out of the most changed files, and says so first', async () => {
    const churn = await run('git.churn');
    expect(churn.data.map(row => `${row.path} ${row.commits}`)).toEqual(['package.json 6', 'docs/guide.md 3', 'src/a.ts 3', 'src/b.ts 3', 'src/history.ts 3']);
    // Before the top file, whose path may be long enough to fill the 160 characters.
    expect(churn.summary).toBe('5 rows; fields path commits authors owner ownership last; 1 generated file and 1 changelog left out; top package.json 6 commits');
  });

  it('git.churn of a directory leaves its changelog out too', async () => {
    const all = await run('git.churn .');
    expect(all.data.some(row => row.path === 'CHANGELOG.md')).toBe(false);
  });

  it.each(['package-lock.json', 'CHANGELOG.md'])('git.churn %s lists it: it was asked for by name', async path => {
    const named = await run(`git.churn ${path}`);
    expect(named.data.map(row => `${row.path} ${row.commits}`)).toEqual([`${path} 6`]);
    expect(named.summary).not.toContain('left out');
  });

  it('git.churn by=module still counts every commit of a module', async () => {
    const modules = await run('git.churn by=module');
    expect(modules.data.reduce((sum, row) => sum + Number(row.commits), 0)).toBeGreaterThanOrEqual(6);
  });

  it('git.coupling pairs no file with its lockfile or the changelog', async () => {
    const coupling = await run('git.coupling');
    expect(coupling.data.filter(row => [row.a, row.b].some(path => path === 'package-lock.json' || path === 'CHANGELOG.md'))).toEqual([]);
    expect(pairs(coupling)).toContain('src/a.ts + src/b.ts');
    expect(pairs(coupling)).toContain('docs/guide.md + src/a.ts');
  });

  it('git.coupling of the changelog itself pairs it: it was asked for by name', async () => {
    const coupling = await run('git.coupling CHANGELOG.md');
    expect(pairs(coupling)).toContain('CHANGELOG.md + package.json');
    expect(coupling.data.every(row => row.a === 'CHANGELOG.md')).toBe(true);
  });
});

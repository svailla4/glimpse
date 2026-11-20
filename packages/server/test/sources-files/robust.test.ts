// Repositories the analyzers were not written for: languages without patterns, binary and generated files,
// monorepos, odd file names. Every source still answers, and says what it could not do.
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {DirNode, GraphData} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {RepoContext} from '../../src/contracts.ts';
import {parseLog} from '../../src/git/log.ts';
import {wordMatches} from '../../src/sources/files/code.ts';
import {historyOf} from '../../src/sources/files/history.ts';
import {git} from '../fixtures/repo.ts';
import {checkResult, makeContext, MINE, run} from './helpers.ts';

async function makeTree(files: Record<string, string | Buffer>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-robust-')));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), content);
  }
  return root;
}

describe('a repository in a language without patterns', () => {
  let root: string;
  let ctx: RepoContext;
  beforeAll(async () => {
    const module = (name: string) => `defmodule Shop.${name} do\n  alias Shop.Repo\n  # TODO: document ${name}\n  def run(x) do\n    if x do\n      :ok\n    end\n  end\nend\n`;
    root = await makeTree({
      'mix.exs': 'defmodule Shop.MixProject do\n  use Mix.Project\nend\n',
      ...Object.fromEntries(Array.from({length: 12}, (_, i) => [`lib/shop/${i < 6 ? 'orders' : 'billing'}/m${i}.ex`, module(`M${i}`)])),
      'lib/shop.ex': module('Root'),
      'priv/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      'assets/app.min.js': `!function(){${'a();'.repeat(3000)}}();\n`,
      'assets/app.js': "import './vendor.js';\nexport function boot() {}\n",
      'assets/vendor.js': 'export const v = 1;\n',
      'README.md': '# Shop\n',
    });
    ctx = makeContext(root, {git: false});
  });
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('every source answers', async () => {
    const refs: Record<string, string> = {'deps.files': 'deps.files lib/shop.ex', 'code.symbols': 'code.symbols lib/shop.ex', 'code.refs': 'code.refs run'};
    for (const name of MINE) checkResult(name, await run(ctx, refs[name] ?? name));
  });

  it('counts and names the language, and finds its TODO tags', async () => {
    expect((await run(ctx, 'files.langs')).data).toEqual([
      {lang: 'Elixir', files: 14, loc: 120, pct: 96.8},
      {lang: 'JavaScript', files: 2, loc: 3, pct: 2.4},
      {lang: 'Markdown', files: 1, loc: 1, pct: 0.8},
    ]);
    expect((await run(ctx, 'repo.stack')).data).toEqual([{label: 'Elixir', slotKey: 'Elixir'}, {label: 'JavaScript', slotKey: 'JavaScript'}]);
    expect((await run(ctx, 'code.todos')).total).toBe(13);
    expect((await run(ctx, 'code.refs run')).total).toBe(13);
  });

  it('draws the modules without edges and says imports are not analysed', async () => {
    const result = await run(ctx, 'deps.modules');
    const graph = result.data as GraphData;
    expect(graph.nodes.map(node => `${node.id} ${node.files}`).sort()).toEqual(['(root) 1', 'assets 2', 'lib/* 1', 'lib/shop/billing 6', 'lib/shop/orders 6']);
    expect(graph.edges).toEqual([]);
    expect(result.warnings).toEqual(['imports are not analysed for Elixir: those files appear without edges']);
    expect((await run(ctx, 'deps.cycles')).warnings).toEqual(['imports are not analysed for Elixir: those files appear without edges']);
  });

  it('gives an empty, labelled outline for files it cannot outline', async () => {
    const elixir = await run(ctx, 'code.symbols lib/shop.ex');
    expect(elixir).toMatchObject({data: [], total: 0, warnings: ['no symbol patterns for Elixir: the outline is empty'], summary: '0 rows; fields name kind line'});
    expect((await run(ctx, 'code.symbols priv/logo.png')).warnings).toEqual(['binary file: no outline']);
    expect((await run(ctx, 'code.symbols assets/app.min.js')).warnings).toEqual(['generated file: not scanned']);
  });

  it('outlines a Markdown file by its headings, with no "outline is empty" warning (F092)', async () => {
    const readme = await run(ctx, 'code.symbols README.md');
    expect(readme.data).toEqual([{name: 'Shop', kind: 'heading', line: 1, depth: 0, exported: true}]);
    expect(readme.warnings).toBeUndefined();
  });

  it('keeps binary and generated files in the tree by size, out of the line counts', async () => {
    const result = await run(ctx, 'files.tree');
    const tree = result.data as DirNode;
    expect(tree).toMatchObject({files: 19, loc: 124});
    const assets = tree.children?.find(child => child.path === 'assets');
    expect(assets?.children?.map(child => `${child.name} ${child.loc} ${child.bytes}`)).toEqual(['app.js 2 48', 'vendor.js 1 20', 'app.min.js 0 12017']);
    expect(tree.children?.find(child => child.path === 'priv')).toMatchObject({loc: 0, bytes: 8, files: 1});
    expect(result.summary).toBe('19 files, 124 loc, 1 generated file not counted in loc');
    // generated files sink to the end of the list, with their real size
    const rows = (await run(ctx, 'files.list')).data as Array<{path: string; loc: number}>;
    expect(rows.at(-1)).toMatchObject({path: 'assets/app.min.js', loc: 1});
    expect(rows.find(row => row.path === 'priv/logo.png')).toEqual({path: 'priv/logo.png', loc: 0, bytes: 8, complexity: 0});
  });
});

describe('a monorepo', () => {
  let root: string;
  let ctx: RepoContext;
  beforeAll(async () => {
    const lib = (pkg: string, n: number) => Object.fromEntries(Array.from({length: n}, (_, i) => [`packages/${pkg}/src/part${i}.ts`, `export const part${i} = ${i};\n`]));
    root = await makeTree({
      'package.json': '{"name": "mono", "private": true, "workspaces": ["packages/*", "apps/*"], "devDependencies": {"turbo": "^2", "typescript": "^5"}}',
      'packages/core/package.json': '{"name": "@mono/core", "version": "1.0.0", "main": "./dist/index.js", "dependencies": {"zod": "^3"}}',
      'packages/core/src/index.ts': "import {z} from 'zod';\nexport * from './part0';\nexport const schema = z.string();\n",
      ...lib('core', 9),
      'packages/ui/package.json': '{"name": "@mono/ui", "version": "1.0.0", "dependencies": {"@mono/core": "workspace:*", "react": "^19"}}',
      'packages/ui/src/index.tsx': "import {schema} from '@mono/core';\nimport {part1} from '@mono/core/src/part1';\nimport {useState} from 'react';\nexport const Button = () => null;\n",
      ...lib('ui', 9),
      'apps/web/package.json': '{"name": "web", "scripts": {"dev": "vite"}, "dependencies": {"@mono/ui": "workspace:*", "@mono/core": "workspace:*", "vite": "^8"}}',
      'apps/web/src/main.tsx': "import {Button} from '@mono/ui';\nimport {schema} from '@mono/core';\nexport const app = [Button, schema];\n",
      'apps/api/go.mod': 'module example.com/mono/api\n\ngo 1.23\n',
      'apps/api/main.go': 'package main\n\nimport "example.com/mono/api/handlers"\n\nfunc main() { handlers.Run() }\n',
      'apps/api/handlers/run.go': 'package handlers\n\nfunc Run() {}\n',
      'services/report/pyproject.toml': '[project]\nname = "report"\nversion = "0.1.0"\ndependencies = ["fastapi"]\n',
      'services/report/report/__init__.py': '',
      'services/report/report/app.py': 'from fastapi import FastAPI\nfrom report.jobs import run\nfrom .jobs import again\n',
      'services/report/report/jobs.py': 'def run():\n    pass\n\ndef again():\n    pass\n',
      'Dockerfile': 'FROM node:22\n',
      '.github/workflows/ci.yml': 'name: ci\non: push\n',
    });
    ctx = makeContext(root, {git: false});
  });
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('resolves imports of workspace packages by name and clusters along the packages', async () => {
    const result = await run(ctx, 'deps.modules');
    const graph = result.data as GraphData;
    const internal = graph.edges.filter(edge => !edge.to.startsWith('ext:')).map(edge => `${edge.from} -> ${edge.to} ${edge.weight}`);
    expect(internal).toEqual(['packages/ui -> packages/core 2', 'apps/web -> packages/core 1', 'apps/web -> packages/ui 1']);
    expect(graph.nodes.filter(node => node.kind === 'cluster').map(node => `${node.id} ${node.label}${node.group ? ` ${node.group}` : ''}`)).toEqual([
      'apps/api api dir:apps', 'apps/web web dir:apps', 'packages/core core dir:packages', 'packages/ui ui dir:packages', 'services/report report',
    ]);
    expect(graph.nodes.find(node => node.id === 'packages/core')?.file).toBe('packages/core/src/index.ts');
    expect(graph.groups).toEqual([{id: 'dir:apps', label: 'apps'}, {id: 'dir:packages', label: 'packages'}]);
    checkResult('deps.modules', result);
  });

  it('lists every package, its scripts and the stack', async () => {
    expect((await run(ctx, 'repo.packages')).data).toEqual([
      {name: 'mono', ecosystem: 'npm', version: '', dir: '', deps: 2},
      {name: 'example.com/mono/api', ecosystem: 'go', version: '', dir: 'apps/api', deps: 0},
      {name: 'web', ecosystem: 'npm', version: '', dir: 'apps/web', deps: 3},
      {name: '@mono/core', ecosystem: 'npm', version: '1.0.0', dir: 'packages/core', deps: 1},
      {name: '@mono/ui', ecosystem: 'npm', version: '1.0.0', dir: 'packages/ui', deps: 2},
      {name: 'report', ecosystem: 'pypi', version: '0.1.0', dir: 'services/report', deps: 1},
    ]);
    expect((await run(ctx, 'repo.scripts')).data).toEqual([{package: 'web', script: 'dev', command: 'vite'}]);
    expect((await run(ctx, 'repo.stack')).data).toEqual([
      {label: 'TypeScript', slotKey: 'TypeScript'}, {label: 'Go', slotKey: 'Go'}, {label: 'Python', slotKey: 'Python'},
      'FastAPI', 'React', 'Zod', 'Turborepo', 'Vite', 'Docker', 'GitHub Actions',
    ]);
    expect((await run(ctx, 'deps.external')).data).toEqual([
      {package: 'fastapi', importers: 1, ecosystem: 'pypi'}, {package: 'react', importers: 1, ecosystem: 'npm'}, {package: 'zod', importers: 1, ecosystem: 'npm'},
    ]);
  });

  it('scopes a graph to one package, with the packages it touches around it', async () => {
    const result = await run(ctx, 'deps.modules packages/ui');
    const graph = result.data as GraphData;
    expect(graph.level).toBe('file');
    expect(graph.nodes.filter(node => node.kind === 'cluster').map(node => node.id)).toEqual(['packages/core', 'apps/web']);
    expect(graph.edges.filter(edge => edge.from === 'packages/ui/src/index.tsx').map(edge => edge.to)).toEqual(['packages/core', 'ext:react']);
    expect(result.summary).toBe('13 nodes 3 edges, 0 file cycles; level file; 2 imports out of packages/ui');
  });
});

describe('names that are also properties of every object', () => {
  // File names and dependency names come from the repository. Looked up in a plain object, `constructor` finds
  // Object.prototype.constructor: a language called "Object", a framework chip without a label, a source that throws.
  let root: string;
  let ctx: RepoContext;
  beforeAll(async () => {
    root = await makeTree({
      'package.json': JSON.stringify({name: 'odd', version: '1.0.0', dependencies: {constructor: '1.0.0', toString: '1.0.0', hasOwnProperty: '1.0.0', valueOf: '1.0.0', react: '19.0.0'}}),
      constructor: 'plain text\n',
      toString: 'plain text\n',
      hasOwnProperty: 'plain text\n',
      'src/a.constructor': 'plain text\n',
      'src/b.__proto__': 'plain text\n',
      'src/index.ts': "import React from 'react';\nimport ctor from 'constructor';\nexport const app = [React, ctor];\n",
    });
    ctx = makeContext(root, {git: false});
  });
  afterAll(async () => { await rm(root, {recursive: true, force: true}); });

  it('every source answers, and nothing inherited is taken for a language or a framework', async () => {
    const refs: Record<string, string> = {'deps.files': 'deps.files src/index.ts', 'code.symbols': 'code.symbols src/index.ts', 'code.refs': 'code.refs app'};
    for (const name of MINE) checkResult(name, await run(ctx, refs[name] ?? name));
    expect(((await run(ctx, 'files.langs')).data as Array<{lang: string}>).map(row => row.lang).sort()).toEqual(['JSON', 'Other', 'TypeScript']);
    const files = (await run(ctx, 'files.list')).data as Array<{path: string; lang?: string}>;
    for (const path of ['constructor', 'toString', 'hasOwnProperty', 'src/a.constructor', 'src/b.__proto__']) expect(files.find(file => file.path === path), path).toMatchObject({path, loc: 1});
    for (const path of ['constructor', 'toString', 'hasOwnProperty', 'src/a.constructor', 'src/b.__proto__']) expect(files.find(file => file.path === path)?.lang, path).toBeUndefined();
    expect((await run(ctx, 'repo.stack')).data).toEqual([{label: 'TypeScript', slotKey: 'TypeScript'}, 'React']);
    expect((await run(ctx, 'deps.external')).data).toEqual([
      {package: 'constructor', importers: 1, ecosystem: 'npm'},
      {package: 'react', importers: 1, ecosystem: 'npm'},
    ]);
  });
});

describe('history counts', () => {
  // The files sources have no parser of their own: they count over the commits the shared parser (git/log.ts) read.
  let serial = 0;
  const record = (time: number, author: string, ...entries: string[]) =>
    `\x01${(++serial).toString(16).padStart(40, '0')}\x1f${author}\x1f${time}\x1fsubject\0${entries.map(entry => `\n${entry}`).join('')}`;
  const counts = (raw: string) => {
    const commits = parseLog(raw);
    return historyOf({commits}, commits);
  };

  it('counts commits per current path and per directory, following renames back in time', () => {
    const raw = [
      record(400, 'Ana', 'M\0src/core/engine.ts\0', 'A\0docs/guide with space.md\0'),
      record(300, 'Ben', 'R090\0src/engine.ts\0src/core/engine.ts\0'),
      record(200, 'Ana', 'M\0src/engine.ts\0', 'M\0src/é.ts\0'),
      record(100, 'Ana', 'R100\0lib/engine.ts\0src/engine.ts\0', 'D\0old.ts\0'),
      record(50, 'Cy', 'A\0lib/engine.ts\0'),
    ].join('');
    const history = counts(raw);
    expect(history.commits).toBe(5);
    expect(history.times).toEqual([400, 300, 200, 100, 50]);
    expect([...history.authors].sort()).toEqual(['Ana', 'Ben', 'Cy']);
    expect(history.fileCommits.get('src/core/engine.ts')).toBe(5);
    expect(history.fileLast.get('src/core/engine.ts')).toBe(400);
    expect(history.fileCommits.get('docs/guide with space.md')).toBe(1);
    expect(history.fileCommits.get('src/é.ts')).toBe(1);
    expect(history.fileCommits.has('lib/engine.ts')).toBe(false);
    expect(history.dirCommits.get('')).toBe(5);
    expect(history.dirCommits.get('src')).toBe(5);
    expect(history.dirCommits.get('src/core')).toBe(5);
    expect(history.dirCommits.get('docs')).toBe(1);
    expect(history.dirLast.get('docs')).toBe(400);
  });

  it('survives empty and malformed output', () => {
    expect(counts('').commits).toBe(0);
    expect(counts(`\x01\x01garbage\0\0\0${record(12, 'Ana', 'M\0')}`).commits).toBe(1);
    // a rename cycle in the history does not loop forever
    const loop = [record(3, 'A', 'R100\0a\0b\0'), record(2, 'A', 'R100\0b\0a\0'), record(1, 'A', 'M\0a\0')].join('');
    expect(counts(loop).commits).toBe(3);
  });

  it('keeps totals for the whole history when the files are known for the latest commits only', () => {
    const all = parseLog([record(30, 'Ana', 'M\0src/a.ts\0'), record(20, 'Ben', 'M\0src/a.ts\0'), record(10, 'Cy', 'A\0old/b.ts\0')].join(''));
    // the parsed window holds the two newest commits; author and time of the third are still known
    const history = historyOf({commits: all.slice(0, 2)}, all);
    expect(history.commits).toBe(3);
    expect([...history.authors].sort()).toEqual(['Ana', 'Ben', 'Cy']);
    expect(history.times).toEqual([30, 20, 10]);
    expect(history.dirCommits.get('')).toBe(3);
    expect(history.fileCommits.get('src/a.ts')).toBe(2);
    expect(history.fileCommits.has('old/b.ts')).toBe(false);
  });

  it('reads real history with odd file names', async () => {
    const root = await makeTree({'dir with space/naïve file.ts': 'export const a = 1;\n', 'plain.ts': 'export const b = 1;\n'});
    try {
      await git(root, ['init', '-q', '-b', 'main']);
      await git(root, ['add', '-A']);
      const env = {GIT_AUTHOR_NAME: 'Ana Lima', GIT_AUTHOR_EMAIL: ['ana', 'example.test'].join('@'), GIT_COMMITTER_NAME: 'Ana Lima', GIT_COMMITTER_EMAIL: ['ana', 'example.test'].join('@'),
        GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z'};
      await git(root, ['commit', '-q', '--no-gpg-sign', '-m', 'first'], env);
      const ctx = makeContext(root);
      const rows = (await run(ctx, 'files.list')).data as Array<{path: string; commits: number}>;
      expect(rows.map(row => `${row.path} ${row.commits}`).sort()).toEqual(['dir with space/naïve file.ts 1', 'plain.ts 1']);
      expect(((await run(ctx, 'files.tree dir with space')).data as DirNode)).toMatchObject({path: 'dir with space', files: 1, commits: 1, age: 19});
      expect((await run(ctx, 'code.symbols dir with space/naïve file.ts')).data).toEqual([{name: 'a', kind: 'const', line: 1, depth: 0, exported: true}]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

describe('wordMatches', () => {
  it('matches whole words, once per line, with line numbers', () => {
    const text = 'const login = 1;\nlogins(); relogin(); login_x();\n  login(login);\r\nlast login';
    expect(wordMatches(text, 'login')).toEqual([{line: 1, text: 'const login = 1;'}, {line: 3, text: '  login(login);'}, {line: 4, text: 'last login'}]);
    expect(wordMatches('a.b(a_b, a.b)', 'a.b')).toEqual([{line: 1, text: 'a.b(a_b, a.b)'}]);
    expect(wordMatches('', 'x')).toEqual([]);
    expect(wordMatches('xx x', 'x')).toEqual([{line: 1, text: 'xx x'}]);
  });
});

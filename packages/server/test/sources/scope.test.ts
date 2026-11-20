// Every source that can be given a path reads only what lies under it. A source that silently ignored its path
// returned the whole repository: `deps.external web` listed the packages of every part of a monorepo, the Python
// test framework of another part first. The table below runs each such source on a small monorepo of two parts,
// `web` (TypeScript) and `zeta` (Python, every name of it carries "zeta"), and checks that the result scoped to
// `web` holds nothing of `zeta`, differs from the whole repository and says the scope in its summary.
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {parseRef, SOURCES as CATALOG, type GraphData, type Rows, type StatItem} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {RepoContext, Source, SourceResult} from '../../src/contracts.ts';
import {createFilesSources} from '../../src/sources/files/index.ts';
import {createGitSources} from '../../src/sources/git/git.ts';
import {git} from '../fixtures/repo.ts';
import {makeContext} from '../sources-files/helpers.ts';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const SOURCES: ReadonlyMap<string, Source> = new Map(
  [...createFilesSources({now: () => NOW}), ...createGitSources({now: () => NOW})].map(source => [source.meta.name, source]),
);
const never = new AbortController().signal;

/** What belongs to the other part of the monorepo. Python is its language: `web` has none. */
const OTHER = /zeta|python/i;

const ROOT_FILES: Record<string, string> = {
  'package.json': JSON.stringify({name: 'mono', private: true, workspaces: ['web'], scripts: {lint: 'tsc -b'}, devDependencies: {typescript: '^5.9.0'}}, null, 2),
  '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n',
};
const WEB_FILES: Record<string, string> = {
  'web/package.json': JSON.stringify({name: 'web', version: '1.0.0', scripts: {dev: 'vite', build: 'vite build'}, dependencies: {react: '^19.0.0', zod: '^3.25.0'}, devDependencies: {vite: '^7.0.0'}}, null, 2),
  'web/Dockerfile': 'FROM node:22\nCOPY . .\nRUN npm ci\n',
  'web/src/main.tsx': "import {createRoot} from 'react-dom/client';\nimport {StrictMode} from 'react';\nimport {App} from './app';\n\ncreateRoot(document.body).render(<StrictMode><App /></StrictMode>);\n",
  'web/src/app.tsx': "import {useState} from 'react';\nimport {parse} from './model';\nimport {shorten} from './util/strings';\n\nexport function App() {\n  const [text] = useState('');\n  return <p>{shorten(String(parse(text)))}</p>;\n}\n",
  'web/src/model.ts': "import {z} from 'zod';\nimport {render} from './view';\n\nexport const Item = z.object({name: z.string()});\nexport function parse(text: string) {\n  return render(Item.parse(JSON.parse(text)));\n}\n",
  'web/src/view.ts': "import {Item} from './model';\n\nexport function render(item: unknown) {\n  // TODO: escape the name\n  return Item.parse(item).name;\n}\n",
  'web/src/util/strings.ts': "export function shorten(text: string, max = 40) {\n  if (text.length <= max) {\n    return text;\n  }\n  return text.slice(0, max - 1) + '…';\n}\n",
  'web/src/util/numbers.ts': "import {shorten} from './strings';\n\nexport function label(value: number) {\n  return shorten(value.toFixed(2));\n}\n",
  'web/src/util/dates.ts': "import {label} from './numbers';\n\nexport function day(at: Date) {\n  return label(at.getUTCDate());\n}\n",
  'web/src/util/colors.ts': "export const colors = ['red', 'green'];\n",
};
const ZETA_FILES: Record<string, string> = {
  'zeta/pyproject.toml': '[project]\nname = "zeta-service"\nversion = "0.1.0"\ndependencies = ["zetaclient", "fastapi"]\n\n[project.scripts]\nzeta-run = "zeta_app.main:run"\n',
  'zeta/compose.yaml': 'services:\n  zeta:\n    build: .\n',
  'zeta/zeta_app/__init__.py': '',
  'zeta/zeta_app/main.py': 'import zetaclient\n\nfrom .store import zeta_save\nfrom .jobs import zeta_jobs\n\n\ndef run():\n    # FIXME: zeta retries\n    zeta_save(zeta_jobs())\n',
  'zeta/zeta_app/store.py': 'import zetaclient\n\nfrom .jobs import zeta_jobs\n\n\ndef zeta_save(rows):\n    for row in zeta_jobs():\n        zetaclient.put(row)\n    return rows\n',
  'zeta/zeta_app/jobs.py': 'from .store import zeta_save\n\n\ndef zeta_jobs():\n    return zeta_save([])\n',
  // Eight source files in two packages, so the repository cut splits zeta and deps.matrix has imports between them.
  'zeta/zeta_tools/__init__.py': '',
  'zeta/zeta_tools/zeta_report.py': 'import zetaclient\n\nfrom ..zeta_app.store import zeta_save\n\n\ndef zeta_report():\n    return zeta_save(zetaclient.rows())\n',
  'zeta/zeta_tools/zeta_export.py': 'from ..zeta_app.jobs import zeta_jobs\n\n\ndef zeta_export():\n    return list(zeta_jobs())\n',
  'zeta/zeta_tools/zeta_audit.py': 'from ..zeta_app.store import zeta_save\n\n\ndef zeta_audit():\n    return zeta_save(None)\n',
  'zeta/zeta_tools/zeta_clean.py': 'def zeta_clean(rows):\n    return [row for row in rows if row]\n',
  'zeta/zeta_tools/zeta_merge.py': 'from .zeta_clean import zeta_clean\n\n\ndef zeta_merge(a, b):\n    return zeta_clean(a + b)\n',
};

const identity = (name: string, date: string): Record<string, string> => {
  const address = [name.toLowerCase().replace(/\s+/g, '.'), ['example', 'test'].join('.')].join('@');
  return {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: address, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date};
};

async function commit(root: string, author: string, date: string, subject: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '--no-gpg-sign', '-m', subject], identity(author, date));
}

/** The files with a line added to each. */
function edit(files: Record<string, string>, ...paths: string[]): Record<string, string> {
  for (const path of paths) files[path] = `${files[path]}\n`;
  return Object.fromEntries(paths.map(path => [path, files[path]!]));
}

let root: string;
let ctx: RepoContext;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-scope-')));
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await commit(root, 'Ann Webb', '2026-10-01T10:00:00Z', 'Start the web app', {...ROOT_FILES, ...WEB_FILES});
  await commit(root, 'Zed Zeta', '2026-10-02T10:00:00Z', 'Start the zeta service', ZETA_FILES);
  for (const [day, round] of [['10', 1], ['12', 2], ['14', 3]] as const) {
    await commit(root, 'Ann Webb', `2026-11-${day}T09:00:00Z`, `Web change ${round}`, edit(WEB_FILES, 'web/src/model.ts', 'web/src/view.ts'));
    await commit(root, 'Zed Zeta', `2026-11-${day}T11:00:00Z`, `Zeta change ${round}`, edit(ZETA_FILES, 'zeta/zeta_app/store.py', 'zeta/zeta_app/jobs.py'));
  }
  ctx = makeContext(root);
});
afterAll(async () => {
  if (root?.includes('glimpse-scope-')) await rm(root, {recursive: true, force: true});
});

function run<T = Rows>(text: string): Promise<SourceResult<T>> {
  const ref = parseRef(text);
  const source = SOURCES.get(ref.source);
  if (!source) throw new Error(`no source ${ref.source}`);
  return source.run(ctx, ref, never) as Promise<SourceResult<T>>;
}

const text = (result: SourceResult<unknown>) => `${JSON.stringify(result.data)} ${result.summary}`;
const stat = (result: SourceResult<unknown>, label: string) => (result.data as StatItem[]).find(item => item.label === label)?.value;
const column = (result: SourceResult<unknown>, key: string) => (result.data as Rows).map(row => row[key]);
const ids = (result: SourceResult<unknown>) => (result.data as GraphData).nodes.map(node => node.id);

interface Case {
  /** The scoped ref; `<source> web` when absent. */
  scoped?: string;
  /** The ref it is compared with; the bare source when absent. */
  whole?: string;
  /** Rows of numbers that name nothing (dates, counts): `check` tells the scoped numbers from the repository's. */
  blind?: boolean;
  /** What the scoped result must be, beyond holding nothing of zeta. */
  check(scoped: SourceResult<unknown>, whole: SourceResult<unknown>): void;
}

/**
 * One row per source that takes a path. A source added to the catalog with a path target, or without any target,
 * must be added here (the first test fails until it is), so no source can ignore a path unnoticed again.
 */
const CASES: Record<string, Case> = {
  'files.tree': {check: scoped => expect(scoped.data).toMatchObject({path: 'web', files: 10})},
  'files.list': {check: scoped => expect(column(scoped, 'path').every(path => String(path).startsWith('web/'))).toBe(true)},
  'files.langs': {check: scoped => expect(column(scoped, 'lang')).toEqual(['TypeScript', 'JSON', 'Dockerfile'])},
  'repo.kpis': {
    blind: true,
    check: (scoped, whole) => {
      // Each number is the one the same source gives for web: files.langs web has 3 rows, deps.matrix web 2 modules,
      // deps.cycles web 1 row, git.authors web 1 author.
      expect(scoped.data).toEqual([
        {label: 'Files', value: 10}, {label: 'Lines', value: 67, format: 'compact'}, {label: 'Languages', value: 3},
        {label: 'Modules', value: 2}, {label: 'File cycles', value: 1, tone: 'warn'},
        {label: 'Commits (30d)', value: 3, delta: 2}, {label: 'Contributors', value: 1},
      ]);
      expect(scoped.summary).toBe('7 rows; fields label value; in web; Files 10, Lines 67, Languages 3, Modules 2, File cycles 1, Commits (30d) 3, Contributors 1');
      expect([stat(whole, 'Files'), stat(whole, 'Modules'), stat(whole, 'File cycles'), stat(whole, 'Contributors')]).toEqual([24, 4, 2, 2]);
    },
  },
  'repo.stack': {check: scoped => expect((scoped.data as Array<string | {label: string}>).map(item => (typeof item === 'string' ? item : item.label))).toEqual(['TypeScript', 'React', 'Zod', 'Vite', 'Docker'])},
  'repo.packages': {check: scoped => expect(column(scoped, 'name')).toEqual(['web'])},
  'repo.scripts': {check: scoped => expect(column(scoped, 'script')).toEqual(['dev', 'build'])},
  'deps.modules': {check: scoped => expect(ids(scoped).every(id => id.startsWith('web/') || id.startsWith('ext:'))).toBe(true)},
  'deps.files': {
    scoped: 'deps.files web/src/model.ts',
    whole: 'deps.files zeta/zeta_app/store.py',
    check: scoped => expect(ids(scoped).sort()).toEqual(['ext:zod', 'web/src/app.tsx', 'web/src/model.ts', 'web/src/view.ts']),
  },
  'deps.cycles': {check: scoped => expect(column(scoped, 'members')).toEqual(['web/src/model.ts, web/src/view.ts'])},
  'deps.external': {
    check: scoped => {
      expect(scoped.data).toEqual([
        {package: 'react', importers: 2, ecosystem: 'npm'},
        {package: 'react-dom', importers: 1, ecosystem: 'npm'},
        {package: 'zod', importers: 1, ecosystem: 'npm'},
      ]);
      expect(scoped.summary).toBe('3 rows; fields package importers ecosystem; in web; top react 2 importers');
    },
  },
  'deps.matrix': {check: scoped => expect(scoped.data).toEqual([{from: 'web/src/*', to: 'web/src/util', weight: 1}])},
  'git.log': {check: scoped => expect(column(scoped, 'subject')).toEqual(['Web change 3', 'Web change 2', 'Web change 1', 'Start the web app'])},
  'git.activity': {
    blind: true,
    check: (scoped, whole) => {
      expect(column(scoped, 'date')).toEqual(['2026-10-01', '2026-11-10', '2026-11-12', '2026-11-14']);
      expect(column(whole, 'commits').reduce((sum: number, n) => sum + Number(n), 0)).toBe(8);
    },
  },
  'git.timeline': {check: scoped => expect(new Set(column(scoped, 'module'))).toEqual(new Set(['web/src/*']))},
  'git.churn': {check: scoped => expect(column(scoped, 'path').slice(0, 2)).toEqual(['web/src/model.ts', 'web/src/view.ts'])},
  'git.hotspots': {check: scoped => expect(column(scoped, 'path').every(path => String(path).startsWith('web/'))).toBe(true)},
  'git.authors': {check: scoped => expect(column(scoped, 'author')).toEqual(['Ann Webb'])},
  'git.coupling': {check: scoped => expect(scoped.data).toEqual([{a: 'web/src/model.ts', b: 'web/src/view.ts', shared: 4, degree: 100}])},
  'code.symbols': {
    scoped: 'code.symbols web/src/model.ts',
    whole: 'code.symbols zeta/zeta_app/store.py',
    check: scoped => expect(column(scoped, 'name')).toEqual(['Item', 'parse']),
  },
  'code.todos': {check: scoped => expect(scoped.data).toEqual([{tag: 'TODO', file: 'web/src/view.ts#L4', text: 'escape the name'}])},
};

/** Every source a path can be given to: all but those of a change range or an identifier. */
const PATH_SOURCES = CATALOG.filter(meta => meta.target !== 'range' && meta.target !== 'symbol').map(meta => meta.name);

/**
 * What a source does with one form of path: read it (`check` on the result, whose summary names the target unless the
 * target speaks for itself), or refuse it with E_TARGET and a message naming the call that does read it.
 */
type Form = {check(result: SourceResult<unknown>): void; speaks?: true} | {refused: RegExp};

/** The rest cluster of web/src (main, app, model, view: not web/src/util), as deps.modules draws it. */
const MODULE = 'web/src/*';
const MODULE_FILES = ['web/src/app.tsx', 'web/src/main.tsx', 'web/src/model.ts', 'web/src/view.ts'];
const FILE = 'web/src/model.ts';
const COMMITS_OF_WEB = ['Web change 3', 'Web change 2', 'Web change 1', 'Start the web app'];
const DAYS_OF_WEB = ['2026-10-01', '2026-11-10', '2026-11-12', '2026-11-14'];
const MODEL_VIEW = [{a: 'web/src/model.ts', b: 'web/src/view.ts', shared: 4, degree: 100}];
const sorted = (values: unknown[]) => values.map(String).sort();
const stats = (result: SourceResult<unknown>, ...labels: string[]) => Object.fromEntries(labels.map(label => [label, stat(result, label)]));
const chips = (result: SourceResult<unknown>) => (result.data as Array<string | {label: string}>).map(item => (typeof item === 'string' ? item : item.label));

/**
 * One row per source that takes a path: what it does with a module id of a graph and with a file. A module id is what
 * a graph node, a deps.matrix row and a git.churn by=module row name, and every reader of a path takes it the way
 * deps.modules draws it; only a tree (a directory view) and an outline (one file) refuse it, saying what to call.
 */
const FORMS: Record<string, {module: Form; file: Form}> = {
  'files.tree': {
    module: {refused: /^files\.tree: "web\/src\/\*" is a module of a graph .*: files\.tree web\/src draws the directory, files\.list web\/src\/\* lists the module's files$/},
    file: {speaks: true, check: result => expect(result.data).toMatchObject({path: FILE, dir: false, files: 1})},
  },
  'files.list': {
    module: {check: result => expect(sorted(column(result, 'path'))).toEqual(MODULE_FILES)},
    file: {check: result => expect(column(result, 'path')).toEqual([FILE])},
  },
  'files.langs': {
    module: {check: result => expect(column(result, 'lang')).toEqual(['TypeScript'])},
    file: {check: result => expect(column(result, 'lang')).toEqual(['TypeScript'])},
  },
  'repo.kpis': {
    // The history of a module is that of its files: three changes in the last 30 days, the start in the 30 before.
    module: {check: result => expect(stats(result, 'Files', 'Modules', 'File cycles', 'Commits (30d)', 'Contributors')).toEqual({Files: 4, Modules: 1, 'File cycles': 1, 'Commits (30d)': 3, Contributors: 1})},
    // A file lies in one module.
    file: {check: result => expect(stats(result, 'Files', 'Modules', 'File cycles', 'Commits (30d)', 'Contributors')).toEqual({Files: 1, Modules: 1, 'File cycles': 1, 'Commits (30d)': 3, Contributors: 1})},
  },
  'repo.stack': {
    module: {check: result => expect(chips(result)).toEqual(['TypeScript', 'React', 'Zod', 'Vite'])},
    file: {check: result => expect(chips(result)).toEqual(['TypeScript', 'React', 'Zod', 'Vite'])},
  },
  'repo.packages': {
    module: {check: result => expect(column(result, 'name')).toEqual(['web'])},
    file: {check: result => expect(column(result, 'name')).toEqual(['web'])},
  },
  'repo.scripts': {
    module: {check: result => expect(column(result, 'script')).toEqual(['dev', 'build'])},
    file: {check: result => expect(column(result, 'script')).toEqual(['dev', 'build'])},
  },
  'deps.modules': {
    module: {check: result => expect(ids(result).filter(id => !id.startsWith('ext:') && id !== 'web/src/util').sort()).toEqual(MODULE_FILES)},
    file: {refused: /^deps\.modules: "web\/src\/model\.ts" is a file; use deps\.files web\/src\/model\.ts$/},
  },
  'deps.files': {
    module: {check: result => {
      expect(result.summary).toMatch(/^a module: drawn as deps\.modules web\/src\/\*; /);
      expect(ids(result).filter(id => !id.startsWith('ext:') && id !== 'web/src/util').sort()).toEqual(MODULE_FILES);
    }},
    file: {speaks: true, check: result => expect(ids(result).sort()).toEqual(['ext:zod', 'web/src/app.tsx', 'web/src/model.ts', 'web/src/view.ts'])},
  },
  'deps.cycles': {
    module: {check: result => expect(column(result, 'members')).toEqual(['web/src/model.ts, web/src/view.ts'])},
    file: {check: result => expect(column(result, 'members')).toEqual(['web/src/model.ts, web/src/view.ts'])},
  },
  'deps.external': {
    module: {check: result => expect(column(result, 'package')).toEqual(['react', 'react-dom', 'zod'])},
    file: {check: result => expect(result.data).toEqual([{package: 'zod', importers: 1, ecosystem: 'npm'}])},
  },
  'deps.matrix': {
    module: {check: result => expect(result.summary).toBe('0 rows; fields from to weight; in web/src/*; 1 module, no imports between them')},
    file: {check: result => expect(result.summary).toBe('0 rows; fields from to weight; in web/src/model.ts; 1 module, no imports between them')},
  },
  'git.log': {
    module: {check: result => expect(column(result, 'subject')).toEqual(COMMITS_OF_WEB)},
    file: {check: result => expect(column(result, 'subject')).toEqual(COMMITS_OF_WEB)},
  },
  'git.activity': {
    module: {check: result => expect(column(result, 'date')).toEqual(DAYS_OF_WEB)},
    file: {check: result => expect(column(result, 'date')).toEqual(DAYS_OF_WEB)},
  },
  'git.timeline': {
    module: {check: result => expect(new Set(column(result, 'module'))).toEqual(new Set([MODULE]))},
    file: {check: result => expect(new Set(column(result, 'module'))).toEqual(new Set([MODULE]))},
  },
  'git.churn': {
    module: {check: result => expect(column(result, 'path').map(String)).toEqual(['web/src/model.ts', 'web/src/view.ts', 'web/src/app.tsx', 'web/src/main.tsx'])},
    file: {check: result => expect(result.data).toMatchObject([{path: FILE, commits: 4}])},
  },
  'git.hotspots': {
    module: {check: result => expect(sorted(column(result, 'path'))).toEqual(MODULE_FILES)},
    file: {check: result => expect(column(result, 'path')).toEqual([FILE])},
  },
  'git.authors': {
    module: {check: result => expect(result.data).toMatchObject([{author: 'Ann Webb', commits: 4, files: 4}])},
    file: {check: result => expect(result.data).toMatchObject([{author: 'Ann Webb', commits: 4, files: 1}])},
  },
  'git.coupling': {
    module: {check: result => expect(result.data).toEqual(MODEL_VIEW)},
    file: {check: result => expect(result.data).toEqual(MODEL_VIEW)},
  },
  'code.symbols': {
    module: {refused: /^code\.symbols reads one file, and "web\/src\/\*" is a module of a graph: files\.list web\/src\/\* lists its files$/},
    file: {speaks: true, check: result => expect(column(result, 'name')).toEqual(['Item', 'parse'])},
  },
  'code.todos': {
    module: {check: result => expect(result.data).toEqual([{tag: 'TODO', file: 'web/src/view.ts#L4', text: 'escape the name'}])},
    file: {check: result => expect(result.data).toEqual([])},
  },
};

describe('a path target', () => {
  it('is covered for every source that takes one', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PATH_SOURCES].sort());
  });

  it.each(PATH_SOURCES)('%s reads only what lies under it', async name => {
    const entry = CASES[name]!;
    const scoped = await run(entry.scoped ?? `${name} web`);
    const whole = await run(entry.whole ?? name);
    // The fixture shows the other part to this source, and the scoped result shows none of it.
    if (!entry.blind) expect(text(whole), `${name}: the whole repository shows zeta`).toMatch(OTHER);
    expect(text(scoped), `${name} web: nothing of zeta`).not.toMatch(OTHER);
    expect(scoped.data).not.toEqual(whole.data);
    // A source that honours a directory says so; a file target speaks for itself.
    if (!entry.scoped) expect(scoped.summary, `${name} web: "${scoped.summary}"`).toMatch(/\bin web\b/);
    entry.check(scoped, whole);
  });

  it.each(PATH_SOURCES.filter(name => !CASES[name]!.scoped))('%s refuses a path that names nothing, never answering for the whole repository', async name => {
    await expect(run(`${name} nowhere`)).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(run(`${name} nowhere/*`)).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(run(`${name} ../outside`)).rejects.toMatchObject({code: 'E_TARGET'});
  });

  it('every source that takes one says what it does with a module id and with a file', () => {
    expect(Object.keys(FORMS).sort()).toEqual([...PATH_SOURCES].sort());
  });

  describe.each(['module', 'file'] as const)('given a %s', form => {
    it.each(PATH_SOURCES)('%s reads it or refuses it saying what to call', async name => {
      const expected = FORMS[name]![form];
      const target = form === 'module' ? MODULE : FILE;
      if ('refused' in expected) {
        const error = await run(`${name} ${target}`).then(() => undefined, (failure: unknown) => failure);
        expect(error, `${name} ${target} is refused`).toMatchObject({code: 'E_TARGET', message: expect.stringMatching(expected.refused)});
        return;
      }
      const result = await run(`${name} ${target}`);
      expect(text(result), `${name} ${target}: nothing of zeta`).not.toMatch(OTHER);
      if (!expected.speaks) expect(result.summary, `${name} ${target}: "${result.summary}"`).toContain(`in ${target}`);
      expected.check(result);
    });
  });

  it('git.churn by=module of a module id has one row: that module', async () => {
    const result = await run('git.churn web/src/* by=module');
    expect(result.data).toEqual([{module: MODULE, commits: 4, authors: 1, files: 4}]);
  });

  it('a path below every manifest reads the package it belongs to, in its own language, and says so', async () => {
    const packages = await run('repo.packages web/src/util');
    expect(column(packages, 'name')).toEqual(['web']);
    expect(packages.summary).toBe('1 row; fields name ecosystem version dir deps; no manifest in web/src/util, so those of web; 1 npm');
    const scripts = await run('repo.scripts zeta/zeta_app');
    expect(column(scripts, 'script')).toEqual(['zeta-run']);
    expect(scripts.summary).toContain('no manifest in zeta/zeta_app, so those of zeta');
  });

  it('a module id of a graph scopes the dependency sources as deps.modules draws it', async () => {
    // 'web/src/*' is the rest cluster of web/src: its own files, without web/src/util.
    expect(ids(await run<GraphData>('deps.modules')).filter(id => id.startsWith('web/'))).toEqual(['web/src/*', 'web/src/util']);
    const external = await run('deps.external web/src/*');
    expect(external.data).toEqual([
      {package: 'react', importers: 2, ecosystem: 'npm'},
      {package: 'react-dom', importers: 1, ecosystem: 'npm'},
      {package: 'zod', importers: 1, ecosystem: 'npm'},
    ]);
    expect(external.summary).toBe('3 rows; fields package importers ecosystem; in web/src/*; top react 2 importers');
    const util = await run('deps.external web/src/util');
    expect(util.data).toEqual([]);
    expect(util.summary).toBe('0 rows; fields package importers ecosystem; no external imports in web/src/util');
    expect(column(await run('deps.cycles web/src/util'), 'members')).toEqual([]);
    expect(column(await run('deps.cycles web/src/*'), 'members')).toEqual(['web/src/model.ts, web/src/view.ts']);
  });
});

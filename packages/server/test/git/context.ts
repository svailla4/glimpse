// Shared by the git, code and sources-git tests: a RepoContext over a fixture repository with a fake RepoIndex.
// The index is hand-written data about the fixture (no analyzer code is loaded), so every number a test expects
// can be read off this file and test/fixtures/repo.ts.
import type {FileEntry, FileFacts, GitInfo, ImportEdge, RepoContext, RepoIndex, RunGit} from '../../src/contracts.ts';
import {readGitInfo} from '../../src/git/index.ts';
import {createRunGit, FIXTURE} from '../fixtures/repo.ts';

/** The clock the fixture history is read with: nine days after the last commit on `feature`. */
export const FIXTURE_NOW = Date.parse('2026-11-20T12:00:00Z');

const LANG_BY_EXTENSION: Record<string, string> = {ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', css: 'CSS', json: 'JSON', md: 'Markdown', toml: 'TOML'};
/** Complexity of the files a hotspot test ranks; every other source file has 10. */
export const COMPLEXITY: Record<string, number> = {'src/auth/service.ts': 40, 'src/auth/session.ts': 20, 'src/orders/service.ts': 30, 'src/index.ts': 5};
/** Some of the fixture's real imports: enough for blast-radius tests. */
export const EDGES: ImportEdge[] = [
  {from: 'src/api/routes.ts', to: 'src/auth/service.ts', kind: 'import'},
  {from: 'src/api/routes.ts', to: 'src/orders/service.ts', kind: 'import'},
  {from: 'src/orders/service.ts', to: 'src/auth/service.ts', kind: 'import'},
  {from: 'src/auth/service.ts', to: 'src/orders/service.ts', kind: 'import'},
  {from: 'src/auth/service.ts', to: 'src/auth/session.ts', kind: 'import'},
  {from: 'test/auth.test.ts', to: 'src/auth/service.ts', kind: 'import'},
  {from: 'tools/report.py', to: 'tools/stats.py', kind: 'import'},
  {from: 'tools/tests/test_stats.py', to: 'tools/stats.py', kind: 'import'},
  {from: 'src/lib/db.ts', to: 'ext:pg', kind: 'import'},
];

const isSource = (path: string): boolean => /\.(tsx?|py|go)$/.test(path);
const isTest = (path: string): boolean => /(^|\/)tests?\//.test(path) || /[._](test|spec)\./.test(path) || /_test\.go$/.test(path);

/** 'src/auth' for files under src/<dir>/, the first directory otherwise, '.' for files at the root. */
export function fixtureModule(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '.';
  return parts[0] === 'src' && parts.length > 2 ? `src/${parts[1]}` : parts[0]!;
}

export function fixtureFiles(): FileEntry[] {
  return [...FIXTURE.tracked, ...FIXTURE.workingTree.untracked].map(path => ({
    path,
    lang: LANG_BY_EXTENSION[path.slice(path.lastIndexOf('.') + 1)],
    loc: 40,
    sloc: 30,
    bytes: 1000,
    binary: false,
    tracked: !(FIXTURE.workingTree.untracked as readonly string[]).includes(path),
    isTest: isTest(path),
    generated: false,
  }));
}

export interface FakeIndex extends RepoIndex {
  /** How often each query ran. */
  calls: {files: number; facts: number; edges: number; moduleOf: number};
}

/** A RepoIndex that answers from the data above. Pass overrides to replace a query (for example one that rejects). */
export function fakeIndex(overrides: Partial<RepoIndex> = {}): FakeIndex {
  const calls = {files: 0, facts: 0, edges: 0, moduleOf: 0};
  const facts = new Map<string, FileFacts>(
    fixtureFiles().filter(file => isSource(file.path)).map(file => [file.path, {
      imports: [],
      symbols: file.path === 'src/auth/tokens.ts'
        ? [
            {name: 'newToken', kind: 'fn', line: 9, endLine: 12, depth: 0, exported: true},
            {name: 'sign', kind: 'fn', line: 5, endLine: 7, depth: 0, exported: true},
          ]
        : [],
      complexity: COMPLEXITY[file.path] ?? 10,
      maxIndent: 2,
      todos: [],
    }]),
  );
  return {
    calls,
    files: () => { calls.files++; return overrides.files ? overrides.files() : Promise.resolve(fixtureFiles()); },
    facts: () => { calls.facts++; return overrides.facts ? overrides.facts() : Promise.resolve(facts); },
    edges: () => { calls.edges++; return overrides.edges ? overrides.edges() : Promise.resolve(EDGES); },
    moduleOf: path => { calls.moduleOf++; return overrides.moduleOf ? overrides.moduleOf(path) : Promise.resolve(fixtureModule(path)); },
    invalidate: () => {},
  };
}

export interface TestContext extends RepoContext {
  index: FakeIndex;
  /** Lines passed to ctx.log. */
  logs: string[];
  /** Arguments of every git invocation, in order. */
  gitCalls: string[][];
  /** Bumps what ctx.rev() returns. */
  bump(): void;
}

export interface ContextOptions {
  /** Replaces what readGitInfo() finds: null simulates a directory that is not a repository. */
  git?: GitInfo | null;
  index?: Partial<RepoIndex>;
}

/** A RepoContext for `root`, with git information read the way the server reads it. */
export async function makeContext(root: string, options: ContextOptions = {}): Promise<TestContext> {
  const run = createRunGit(root);
  const gitCalls: string[][] = [];
  const runGit: RunGit = (args, opts) => {
    gitCalls.push(args);
    return run(args, opts);
  };
  const logs: string[] = [];
  let rev = 1;
  return {
    root,
    name: 'shop',
    git: options.git === undefined ? await readGitInfo(root, run) : options.git,
    runGit,
    index: fakeIndex(options.index),
    rev: () => rev,
    log: message => { logs.push(message); },
    logs,
    gitCalls,
    bump: () => { rev++; },
  };
}

export const never = new AbortController().signal;

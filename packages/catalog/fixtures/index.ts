// packages/catalog/fixtures/index.ts  (import as '@glimpse/catalog/fixtures')
// Hand-written fixture data for tests, the viewer dev harness and demos: one small, realistic, ready Dataset per
// source, canned DataClient answers, and a FixtureHost that serves them. Everything describes one imaginary repo
// ("demo": src/auth, src/api, src/ui; authors Mira, Jon and Ade), the same one the gallery uses.
// `npm run generate` writes the same data as JSON next to this file (datasets/<source>.json, host/*.json).
import type {
  ChipItem, ChurnRow, CommitRow, Dataset, DiffFileRow, DirNode, GraphData, HotspotRow, LangRow, Rows, StatItem, SymbolRow,
} from '../src/datasets.ts';
import {datasetKey, formatRef, parseRef, SOURCE_BY_NAME, SOURCES} from '../src/sources.ts';
import type {
  DataClient, DiffFile, DiffLine, DiffPayload, DiffQuery, FileQuery, FileSlice, HighlightResult, OutlineResult, RowsPage, RowsQuery,
  TokenClass, TokenLine,
} from '../src/transport.ts';

// ---------------------------------------------------------------- a tiny tokenizer, good enough for canned answers
const KEYWORDS = new Set([
  'import', 'from', 'export', 'const', 'let', 'function', 'async', 'await', 'return', 'if', 'else', 'new', 'class', 'interface',
  'type', 'throw', 'for', 'of', 'func', 'package', 'var', 'def',
]);
const CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'nil']);
const TOKEN = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+|.)/g;

/** Splits one line into [text, class] pairs: keywords 1, strings 2, calls 3, capitalised names 4, numbers 5, constants 6, comments 7. */
export function tokenizeLine(line: string): TokenLine {
  const out: TokenLine = [];
  const push = (text: string, cls: TokenClass) => {
    const last = out.at(-1);
    if (last && last[1] === cls) last[0] += text;
    else out.push([text, cls]);
  };
  for (const m of line.matchAll(TOKEN)) {
    const text = m[0];
    if (m[1]) push(text, 7);
    else if (m[2]) push(text, 2);
    else if (m[3]) push(text, 5);
    else if (m[4]) {
      const next = line[m.index + text.length];
      push(text, KEYWORDS.has(text) ? 1 : CONSTANTS.has(text) ? 6 : next === '(' ? 3 : /^[A-Z]/.test(text) ? 4 : 0);
    } else push(text, 0);
  }
  return out;
}
export const tokenize = (code: string): TokenLine[] => code.split('\n').map(tokenizeLine);

// ---------------------------------------------------------------- the imaginary repo
const SERVICE_TS = `import {cache} from './cache';
import {db} from '../lib/db';
import type {Session, User} from './types';

const TTL_SECONDS = 900;

// Issues a session token after checking the password.
export async function login(email: string, password: string): Promise<Session> {
  const user = await db.users.findByEmail(email);
  if (!user || !(await verify(password, user.hash))) {
    throw new AuthError('invalid credentials');
  }
  return issueToken(user);
}

export async function issueToken(user: User): Promise<Session> {
  const token = crypto.randomUUID();
  await cache.set(\`session:\${token}\`, user.id, TTL_SECONDS);
  return {token, userId: user.id, expiresIn: TTL_SECONDS};
}

async function verify(password: string, hash: string): Promise<boolean> {
  // TODO: move to argon2id
  return timingSafeEqual(await digest(password), hash);
}

export class AuthError extends Error {
  readonly status = 401;
}`;

const TREE: DirNode = {
  name: '', path: '', dir: true, files: 9, loc: 4210, bytes: 131072, lang: 'TypeScript', commits: 212, age: 2, complexity: 310,
  children: [
    {
      name: 'src', path: 'src', dir: true, files: 7, loc: 3900, bytes: 120000, lang: 'TypeScript', commits: 140, age: 2, complexity: 310,
      children: [
        {
          name: 'auth', path: 'src/auth', dir: true, files: 3, loc: 1500, bytes: 52000, lang: 'TypeScript', commits: 80, age: 2, complexity: 160,
          children: [
            {name: 'service.ts', path: 'src/auth/service.ts', dir: false, files: 1, loc: 820, bytes: 30000, lang: 'TypeScript', commits: 51, age: 2, complexity: 96},
            {name: 'cache.ts', path: 'src/auth/cache.ts', dir: false, files: 1, loc: 410, bytes: 14000, lang: 'TypeScript', commits: 22, age: 9, complexity: 41},
            {name: 'schema.sql', path: 'src/auth/schema.sql', dir: false, files: 1, loc: 270, bytes: 8000, lang: 'SQL', commits: 7, age: 120, complexity: 4},
          ],
        },
        {
          name: 'api', path: 'src/api', dir: true, files: 2, loc: 1300, bytes: 40000, lang: 'TypeScript', commits: 44, age: 5, complexity: 90,
          children: [
            {name: 'routes.ts', path: 'src/api/routes.ts', dir: false, files: 1, loc: 900, bytes: 28000, lang: 'TypeScript', commits: 33, age: 5, complexity: 70},
            {name: 'limiter.go', path: 'src/api/limiter.go', dir: false, files: 1, loc: 400, bytes: 12000, lang: 'Go', commits: 11, age: 30, complexity: 20},
          ],
        },
        {
          name: 'ui', path: 'src/ui', dir: true, files: 2, loc: 1100, bytes: 28000, lang: 'CSS', commits: 16, age: 40, complexity: 60, more: {files: 12, loc: 800},
          children: [
            {name: 'app.css', path: 'src/ui/app.css', dir: false, files: 1, loc: 700, bytes: 18000, lang: 'CSS', commits: 9, age: 40, complexity: 0},
            {name: 'App.tsx', path: 'src/ui/App.tsx', dir: false, files: 1, loc: 400, bytes: 10000, lang: 'TypeScript', commits: 7, age: 60, complexity: 60},
          ],
        },
      ],
    },
    {name: 'README.md', path: 'README.md', dir: false, files: 1, loc: 210, bytes: 7000, lang: 'Markdown', commits: 12, age: 14, complexity: 0},
    {name: 'package.json', path: 'package.json', dir: false, files: 1, loc: 100, bytes: 4072, lang: 'JSON', commits: 30, age: 3, complexity: 0},
  ],
};

const FILES: Rows = [
  {path: 'src/api/routes.ts', lang: 'TypeScript', loc: 900, bytes: 28000, commits: 33, complexity: 70},
  {path: 'src/auth/service.ts', lang: 'TypeScript', loc: 820, bytes: 30000, commits: 51, complexity: 96},
  {path: 'src/ui/app.css', lang: 'CSS', loc: 700, bytes: 18000, commits: 9, complexity: 0},
  {path: 'src/auth/cache.ts', lang: 'TypeScript', loc: 410, bytes: 14000, commits: 22, complexity: 41},
  {path: 'src/api/limiter.go', lang: 'Go', loc: 400, bytes: 12000, commits: 11, complexity: 20},
  {path: 'src/ui/App.tsx', lang: 'TypeScript', loc: 400, bytes: 10000, commits: 7, complexity: 60},
  {path: 'src/auth/schema.sql', lang: 'SQL', loc: 270, bytes: 8000, commits: 7, complexity: 4},
  {path: 'README.md', lang: 'Markdown', loc: 210, bytes: 7000, commits: 12, complexity: 0},
  {path: 'package.json', lang: 'JSON', loc: 100, bytes: 4072, commits: 30, complexity: 0},
];

const LANGS: LangRow[] = [
  {lang: 'TypeScript', files: 4, loc: 2530, pct: 60.1},
  {lang: 'CSS', files: 1, loc: 700, pct: 16.6},
  {lang: 'Go', files: 1, loc: 400, pct: 9.5},
  {lang: 'SQL', files: 1, loc: 270, pct: 6.4},
  {lang: 'Markdown', files: 1, loc: 210, pct: 5},
  {lang: 'JSON', files: 1, loc: 100, pct: 2.4},
];

const KPIS: StatItem[] = [
  {label: 'Files', value: 9},
  {label: 'Lines', value: 4210, format: 'compact', spark: [3100, 3300, 3500, 3900, 4210]},
  {label: 'Languages', value: 6},
  {label: 'Modules', value: 3},
  {label: 'Cycles', value: 1, tone: 'warn'},
  {label: 'Commits (30d)', value: 38, delta: 6},
  {label: 'Contributors', value: 3},
];

const STACK: ChipItem[] = [
  {label: 'TypeScript', slotKey: 'TypeScript'}, {label: 'CSS', slotKey: 'CSS'}, {label: 'Go', slotKey: 'Go'}, {label: 'SQL', slotKey: 'SQL'},
  'React', 'Vite', 'vitest', {label: 'PostgreSQL', tone: 'info'}, {label: 'Redis', tone: 'info'}, 'Docker', 'GitHub Actions',
];

const MODULES: GraphData = {
  level: 'module',
  groups: [{id: 'srv', label: 'server'}],
  nodes: [
    {id: 'api', label: 'api', sub: '2 files, 1.3k loc', kind: 'cluster', group: 'srv', slotKey: 'api', files: 2, loc: 1300, fanIn: 2, fanOut: 1, cycle: true, file: 'src/api/routes.ts'},
    {id: 'auth', label: 'auth', sub: '3 files, 1.5k loc', kind: 'cluster', group: 'srv', slotKey: 'auth', files: 3, loc: 1500, fanIn: 2, fanOut: 2, cycle: true, file: 'src/auth/service.ts'},
    {id: 'ui', label: 'ui', sub: '2 files, 1.1k loc', kind: 'cluster', slotKey: 'ui', files: 2, loc: 1100, fanIn: 0, fanOut: 2},
    {id: 'ext:redis', label: 'redis', kind: 'external', fanIn: 1, fanOut: 0},
    {id: 'ext:pg', label: 'pg', kind: 'external', fanIn: 1, fanOut: 0},
  ],
  edges: [
    {from: 'api', to: 'auth', weight: 9, cycle: true},
    {from: 'auth', to: 'api', weight: 2, cycle: true},
    {from: 'ui', to: 'api', weight: 6},
    {from: 'ui', to: 'auth', weight: 1, kind: 'dashed'},
    {from: 'auth', to: 'ext:redis', weight: 3},
    {from: 'auth', to: 'ext:pg', weight: 2},
  ],
};

const EGO: GraphData = {
  level: 'file',
  nodes: [
    {id: 'src/auth/service.ts', label: 'service.ts', sub: 'src/auth', kind: 'file', slotKey: 'auth', fanIn: 2, fanOut: 2, cycle: true, file: 'src/auth/service.ts'},
    {id: 'src/auth/cache.ts', label: 'cache.ts', sub: 'src/auth', kind: 'file', slotKey: 'auth', fanIn: 1, fanOut: 1, file: 'src/auth/cache.ts'},
    {id: 'src/api/routes.ts', label: 'routes.ts', sub: 'src/api', kind: 'file', slotKey: 'api', fanIn: 2, fanOut: 2, cycle: true, file: 'src/api/routes.ts'},
    {id: 'src/ui/App.tsx', label: 'App.tsx', sub: 'src/ui', kind: 'file', slotKey: 'ui', fanIn: 0, fanOut: 2, file: 'src/ui/App.tsx'},
    {id: 'ext:pg', label: 'pg', kind: 'external', fanIn: 1, fanOut: 0},
  ],
  edges: [
    {from: 'src/auth/service.ts', to: 'src/auth/cache.ts'},
    {from: 'src/auth/service.ts', to: 'src/api/routes.ts', cycle: true},
    {from: 'src/api/routes.ts', to: 'src/auth/service.ts', cycle: true},
    {from: 'src/ui/App.tsx', to: 'src/auth/service.ts', kind: 'dashed'},
    {from: 'src/auth/service.ts', to: 'ext:pg'},
  ],
};

const COMMITS: CommitRow[] = [
  {sha: '4f2a91c0d1', subject: 'Add sliding-window limiter', author: 'Ade', date: '2026-11-17T10:12:00Z', add: 400, del: 0, files: 3, refs: ['HEAD', 'main']},
  {sha: '9be01d2a77', subject: 'Cache tokens with TTL', author: 'Mira', date: '2026-11-14T16:40:00Z', add: 120, del: 44, files: 2},
  {sha: '77c0a3e145', subject: 'Fix login redirect loop', author: 'Jon', date: '2026-11-10T09:03:00Z', add: 9, del: 12, files: 1},
  {sha: 'c31f08ab9e', subject: 'Split routes by resource', author: 'Jon', date: '2026-11-06T14:21:00Z', add: 210, del: 180, files: 4},
  {sha: '0d94e7b216', subject: 'Constant-time password compare', author: 'Mira', date: '2026-11-03T11:55:00Z', add: 18, del: 6, files: 1, refs: ['v1.4.0']},
  {sha: 'a8e5521f03', subject: 'Restyle the session list', author: 'Jon', date: '2026-10-28T08:30:00Z', add: 64, del: 31, files: 2},
];

const CHURN: ChurnRow[] = [
  {path: 'src/auth/service.ts', commits: 51, authors: 3, owner: 'Mira', ownership: 62.7, first: '2025-03-02', last: '2026-11-17'},
  {path: 'src/api/routes.ts', commits: 33, authors: 2, owner: 'Jon', ownership: 72.7, first: '2025-03-02', last: '2026-11-14'},
  {path: 'package.json', commits: 30, authors: 3, owner: 'Jon', ownership: 46.7, first: '2025-02-20', last: '2026-11-16'},
  {path: 'src/auth/cache.ts', commits: 22, authors: 2, owner: 'Mira', ownership: 86.4, first: '2025-06-11', last: '2026-11-10'},
  {path: 'README.md', commits: 12, authors: 3, owner: 'Ade', ownership: 41.7, first: '2025-02-20', last: '2026-11-05'},
  {path: 'src/api/limiter.go', commits: 11, authors: 1, owner: 'Ade', ownership: 100, first: '2026-09-30', last: '2026-10-20'},
];

const HOTSPOTS: HotspotRow[] = [
  {path: 'src/auth/service.ts', commits: 51, complexity: 96, sloc: 690, score: 1, owner: 'Mira', isTest: false},
  {path: 'src/api/routes.ts', commits: 33, complexity: 70, sloc: 760, score: 0.47, owner: 'Jon', isTest: false},
  {path: 'src/auth/cache.ts', commits: 22, complexity: 41, sloc: 350, score: 0.18, owner: 'Mira', isTest: false},
  {path: 'src/ui/App.tsx', commits: 7, complexity: 60, sloc: 340, score: 0.09, owner: 'Jon', isTest: false},
  {path: 'src/api/limiter.go', commits: 11, complexity: 20, sloc: 330, score: 0.04, owner: 'Ade', isTest: false},
];

const SYMBOLS: SymbolRow[] = [
  {name: 'TTL_SECONDS', kind: 'const', line: 5, depth: 0, exported: false},
  {name: 'login', kind: 'fn', line: 8, endLine: 14, depth: 0, exported: true},
  {name: 'issueToken', kind: 'fn', line: 16, endLine: 20, depth: 0, exported: true},
  {name: 'verify', kind: 'fn', line: 22, endLine: 25, depth: 0, exported: false},
  {name: 'AuthError', kind: 'class', line: 27, endLine: 29, depth: 0, exported: true},
  {name: 'status', kind: 'var', line: 28, depth: 1, exported: false},
];

const DIFF_FILES: DiffFileRow[] = [
  {path: 'src/api/limiter.ts', status: 'A', add: 118, del: 0, delta: {add: 118, del: 0}, lang: 'TypeScript', isTest: false},
  {path: 'src/auth/service.ts', status: 'M', add: 9, del: 4, delta: {add: 9, del: 4}, lang: 'TypeScript', isTest: false},
  {path: 'test/limiter.test.ts', status: 'A', add: 5, del: 0, delta: {add: 5, del: 0}, lang: 'TypeScript', isTest: true},
];

const DIFF_TREE: DirNode = {
  name: '', path: '', dir: true, files: 3, loc: 0, bytes: 0, add: 132, del: 4,
  children: [
    {
      name: 'src', path: 'src', dir: true, files: 2, loc: 0, bytes: 0, add: 127, del: 4,
      children: [
        {name: 'api', path: 'src/api', dir: true, files: 1, loc: 0, bytes: 0, add: 118, del: 0, children: [
          {name: 'limiter.ts', path: 'src/api/limiter.ts', dir: false, files: 1, loc: 118, bytes: 3900, lang: 'TypeScript', add: 118, del: 0, status: 'A'},
        ]},
        {name: 'auth', path: 'src/auth', dir: true, files: 1, loc: 0, bytes: 0, add: 9, del: 4, children: [
          {name: 'service.ts', path: 'src/auth/service.ts', dir: false, files: 1, loc: 825, bytes: 30200, lang: 'TypeScript', add: 9, del: 4, status: 'M'},
        ]},
      ],
    },
    {name: 'test', path: 'test', dir: true, files: 1, loc: 0, bytes: 0, add: 5, del: 0, children: [
      {name: 'limiter.test.ts', path: 'test/limiter.test.ts', dir: false, files: 1, loc: 5, bytes: 180, lang: 'TypeScript', add: 5, del: 0, status: 'A'},
    ]},
  ],
};

const IMPACT: GraphData = {
  level: 'file',
  nodes: [
    {id: 'src/api/limiter.ts', label: 'limiter.ts', sub: 'src/api', kind: 'file', slotKey: 'api', status: 'added', file: 'src/api/limiter.ts'},
    {id: 'src/auth/service.ts', label: 'service.ts', sub: 'src/auth', kind: 'file', slotKey: 'auth', status: 'modified', file: 'src/auth/service.ts'},
    {id: 'src/api/routes.ts', label: 'routes.ts', sub: 'src/api', kind: 'file', slotKey: 'api', status: 'affected', file: 'src/api/routes.ts'},
    {id: 'src/ui/App.tsx', label: 'App.tsx', sub: 'src/ui', kind: 'file', slotKey: 'ui', status: 'affected', file: 'src/ui/App.tsx'},
  ],
  edges: [
    {from: 'src/api/routes.ts', to: 'src/auth/service.ts'},
    {from: 'src/api/routes.ts', to: 'src/api/limiter.ts'},
    {from: 'src/ui/App.tsx', to: 'src/auth/service.ts'},
  ],
};

// ---------------------------------------------------------------- datasets
function ready<T>(source: string, data: T, extra: Partial<Dataset<T>> = {}): Dataset<T> {
  const meta = SOURCE_BY_NAME.get(source);
  if (!meta) throw new Error(`fixture for unknown source ${source}`);
  return {
    $ds: datasetKey({source, args: {}}), kind: meta.kind, status: 'ready', source, data,
    ...(meta.fields ? {fields: meta.fields} : {}), ...(meta.roles ? {roles: meta.roles} : {}),
    ...(Array.isArray(data) ? {total: data.length} : {}),
    ...(meta.pageable ? {pageable: true} : {}), ...(meta.wt ? {wt: true} : {}),
    cache: 'miss', elapsedMs: 12,
    ...extra,
  };
}

/** One ready envelope per source, keyed by source name ('git.churn'). */
export const DATASET_FIXTURES: Readonly<Record<string, Dataset>> = {
  'files.tree': ready('files.tree', TREE, {total: 21, truncated: {total: 21, returned: 9, strategy: 'treecut', by: 'loc'}}),
  'files.list': ready('files.list', FILES),
  'files.langs': ready('files.langs', LANGS),
  'repo.kpis': ready('repo.kpis', KPIS),
  'repo.stack': ready('repo.stack', STACK),
  'repo.packages': ready('repo.packages', [
    {name: 'demo', ecosystem: 'npm', version: '1.4.0', dir: '', deps: 12},
    {name: 'example.com/demo/limiter', ecosystem: 'go', version: '', dir: 'src/api', deps: 2},
  ]),
  'repo.scripts': ready('repo.scripts', [
    {package: 'demo', script: 'dev', command: 'vite'},
    {package: 'demo', script: 'build', command: 'tsc -b && vite build'},
    {package: 'demo', script: 'test', command: 'vitest run'},
  ]),
  'deps.modules': ready('deps.modules', MODULES, {total: 5}),
  'deps.files': ready('deps.files', EGO, {total: 5, source: 'deps.files src/auth/service.ts'}),
  'deps.cycles': ready('deps.cycles', [{id: 1, size: 2, members: 'src/api/routes.ts, src/auth/service.ts'}]),
  'deps.external': ready('deps.external', [
    {package: 'redis', importers: 3, ecosystem: 'npm'},
    {package: 'zod', importers: 3, ecosystem: 'npm'},
    {package: 'pg', importers: 2, ecosystem: 'npm'},
    {package: 'react', importers: 1, ecosystem: 'npm'},
    {package: 'golang.org/x/time', importers: 1, ecosystem: 'go'},
  ]),
  'deps.matrix': ready('deps.matrix', [
    {from: 'api', to: 'auth', weight: 9}, {from: 'auth', to: 'api', weight: 2}, {from: 'ui', to: 'api', weight: 6}, {from: 'ui', to: 'auth', weight: 1},
  ]),
  'git.log': ready('git.log', COMMITS, {total: 212, truncated: {total: 212, returned: 6, strategy: 'topN', by: 'date'}}),
  'git.activity': ready('git.activity', [
    {date: '2026-11-02', commits: 3}, {date: '2026-11-03', commits: 1}, {date: '2026-11-05', commits: 6}, {date: '2026-11-06', commits: 2},
    {date: '2026-11-09', commits: 4}, {date: '2026-11-10', commits: 9}, {date: '2026-11-12', commits: 1}, {date: '2026-11-13', commits: 5},
    {date: '2026-11-16', commits: 2}, {date: '2026-11-17', commits: 7},
  ]),
  'git.timeline': ready('git.timeline', [
    {week: '2026-10-05', module: 'auth', commits: 4}, {week: '2026-10-05', module: 'api', commits: 2}, {week: '2026-10-05', module: 'ui', commits: 1},
    {week: '2026-10-12', module: 'auth', commits: 7}, {week: '2026-10-12', module: 'api', commits: 5}, {week: '2026-10-12', module: 'ui', commits: 0},
    {week: '2026-10-19', module: 'auth', commits: 3}, {week: '2026-10-19', module: 'api', commits: 6}, {week: '2026-10-19', module: 'ui', commits: 2},
    {week: '2026-10-26', module: 'auth', commits: 9}, {week: '2026-10-26', module: 'api', commits: 1}, {week: '2026-10-26', module: 'ui', commits: 3},
    {week: '2026-11-02', module: 'auth', commits: 12}, {week: '2026-11-02', module: 'api', commits: 4}, {week: '2026-11-02', module: 'ui', commits: 0},
    {week: '2026-11-09', module: 'auth', commits: 8}, {week: '2026-11-09', module: 'api', commits: 7}, {week: '2026-11-09', module: 'ui', commits: 1},
  ]),
  'git.churn': ready('git.churn', CHURN, {total: 9}),
  'git.hotspots': ready('git.hotspots', HOTSPOTS, {total: 7}),
  'git.authors': ready('git.authors', [
    {author: 'Mira', commits: 96, files: 7, last: '2026-11-17'},
    {author: 'Jon', commits: 81, files: 8, last: '2026-11-16'},
    {author: 'Ade', commits: 35, files: 4, last: '2026-11-17'},
  ]),
  'git.coupling': ready('git.coupling', [
    {a: 'src/auth/service.ts', b: 'src/auth/cache.ts', shared: 14, degree: 63.6},
    {a: 'src/api/routes.ts', b: 'src/auth/service.ts', shared: 11, degree: 33.3},
    {a: 'src/ui/App.tsx', b: 'src/ui/app.css', shared: 5, degree: 71.4},
  ]),
  'diff.stats': ready('diff.stats', [
    {label: 'Files changed', value: 3}, {label: 'Added', value: 132, tone: 'good'}, {label: 'Removed', value: 4, tone: 'bad'},
    {label: 'Commits', value: 0}, {label: 'Tests touched', value: 1},
  ] satisfies StatItem[], {source: 'diff.stats wt'}),
  'diff.files': ready('diff.files', DIFF_FILES, {source: 'diff.files wt'}),
  'diff.tree': ready('diff.tree', DIFF_TREE, {total: 3, source: 'diff.tree wt'}),
  'diff.impact': ready('diff.impact', IMPACT, {total: 4, source: 'diff.impact wt'}),
  'code.symbols': ready('code.symbols', SYMBOLS, {source: 'code.symbols src/auth/service.ts'}),
  'code.refs': ready('code.refs', [
    {file: 'src/auth/service.ts#L13', text: '  return issueToken(user);'},
    {file: 'src/auth/service.ts#L16', text: 'export async function issueToken(user: User): Promise<Session> {'},
    {file: 'src/api/routes.ts#L41', text: '    const session = await issueToken(user);'},
  ], {source: 'code.refs issueToken'}),
  'code.todos': ready('code.todos', [
    {tag: 'TODO', file: 'src/auth/service.ts#L23', text: 'move to argon2id'},
    {tag: 'FIXME', file: 'src/api/routes.ts#L88', text: 'pagination ignores the cursor'},
    {tag: 'HACK', file: 'src/ui/App.tsx#L12', text: 'force a re-render after login'},
  ]),
};

/**
 * The ready fixture for a source ref ('git.churn' or 'git.churn src top=5'): a deep copy keyed and labelled for that
 * ref, so it can be written straight to `/ds/<datasetKey(ref)>`. `top=N` cuts rows fixtures the way a source would.
 */
export function datasetFixture<T = unknown>(refText: string): Dataset<T> {
  const ref = parseRef(refText);
  const base = DATASET_FIXTURES[ref.source];
  if (!base) throw new Error(`no dataset fixture for source "${ref.source}"`);
  const ds = structuredClone(base) as Dataset<T>;
  const bare = !ref.target && Object.keys(ref.args).length === 0;
  if (!bare) { ds.$ds = datasetKey(ref); ds.source = formatRef(ref); }
  const top = Number(ref.args.top);
  if (Array.isArray(ds.data) && Number.isInteger(top) && top > 0 && top < ds.data.length) {
    const total = ds.total ?? ds.data.length;
    ds.data = ds.data.slice(0, top) as T;
    ds.truncated = {total, returned: top, strategy: 'topN'};
  }
  return ds;
}

/** A pending envelope for a ref: what a component sees before its source settles. */
export function pendingDataset(refText: string, note?: string): Dataset {
  const ref = parseRef(refText);
  const source = formatRef(ref);
  return {$ds: datasetKey(ref), kind: SOURCE_BY_NAME.get(ref.source)?.kind ?? 'rows', status: 'pending', source, note: note ?? `running ${source}`};
}

/** An error envelope for a ref: what a component sees when its source failed. */
export function errorDataset(refText: string, code = 'E_INTERNAL', message = 'not implemented'): Dataset {
  const ref = parseRef(refText);
  return {$ds: datasetKey(ref), kind: SOURCE_BY_NAME.get(ref.source)?.kind ?? 'rows', status: 'error', source: formatRef(ref), error: {code, message}};
}

// ---------------------------------------------------------------- host (DataClient) answers
const serviceLines = tokenize(SERVICE_TS);

const FILE_SLICE: FileSlice = {
  path: 'src/auth/service.ts', lang: 'typescript', total: serviceLines.length, start: 1, end: serviceLines.length,
  lines: serviceLines, size: SERVICE_TS.length, rev: 1,
};

const dl = (t: DiffLine['t'], o: number | undefined, n: number | undefined, text: string, marks?: DiffLine['marks']): DiffLine =>
  ({t, ...(o !== undefined ? {o} : {}), ...(n !== undefined ? {n} : {}), tokens: tokenizeLine(text), ...(marks ? {marks} : {})});

const LIMITER_TS = `import {cache} from '../auth/cache';

const WINDOW_SECONDS = 60;
const LIMIT = 100;

// Sliding-window limiter keyed by client address.
export async function take(ip: string): Promise<boolean> {
  const hits = await cache.incr(\`rl:\${ip}\`, WINDOW_SECONDS);
  return hits <= LIMIT;
}`;

const DIFF_FILES_PAYLOAD: DiffFile[] = [
  {
    path: 'src/api/limiter.ts', status: 'A', add: 10, del: 0, lang: 'typescript',
    hunks: [{
      oldStart: 0, oldLines: 0, newStart: 1, newLines: 10, header: '@@ -0,0 +1,10 @@',
      lines: LIMITER_TS.split('\n').map((text, i) => dl('+', undefined, i + 1, text)),
    }],
  },
  {
    path: 'src/auth/service.ts', status: 'M', add: 3, del: 2, lang: 'typescript',
    hunks: [
      {
        oldStart: 3, oldLines: 5, newStart: 3, newLines: 5, header: '@@ -3,5 +3,5 @@ import {db} from \'../lib/db\';',
        lines: [
          dl(' ', 3, 3, "import type {Session, User} from './types';"),
          dl(' ', 4, 4, ''),
          dl('-', 5, undefined, 'const TTL_SECONDS = 600;', [[20, 23]]),
          dl('+', undefined, 5, 'const TTL_SECONDS = 900;', [[20, 23]]),
          dl(' ', 6, 6, ''),
          dl(' ', 7, 7, '// Issues a session token after checking the password.'),
        ],
      },
      {
        oldStart: 22, oldLines: 4, newStart: 22, newLines: 5, header: '@@ -22,4 +22,5 @@ export async function issueToken(user: User): Promise<Session> {',
        lines: [
          dl(' ', 22, 22, 'async function verify(password: string, hash: string): Promise<boolean> {'),
          dl('-', 23, undefined, '  return (await digest(password)) === hash;', [[9, 42]]),
          dl('+', undefined, 23, '  // TODO: move to argon2id'),
          dl('+', undefined, 24, '  return timingSafeEqual(await digest(password), hash);', [[9, 54]]),
          dl(' ', 24, 25, '}'),
          dl(' ', 25, 26, ''),
        ],
      },
    ],
  },
];

const DIFF: DiffPayload = {
  range: 'wt', head: '4f2a91c', files: DIFF_FILES_PAYLOAD,
  totals: {files: DIFF_FILES_PAYLOAD.length, add: 13, del: 2}, rev: 1,
};

const OUTLINE: OutlineResult = {path: 'src/auth/service.ts', symbols: SYMBOLS};
const ROWS: RowsPage = {rows: FILES, total: FILES.length, offset: 0};

/** Canned DataClient answers. `file` and `outline` describe src/auth/service.ts; `diff` is the working tree; `rows` is the first page of files.list. */
export const HOST_FIXTURES: Readonly<{file: FileSlice; diff: DiffPayload; outline: OutlineResult; rows: RowsPage}> = {
  file: FILE_SLICE, diff: DIFF, outline: OUTLINE, rows: ROWS,
};

// ---------------------------------------------------------------- FixtureHost
export interface FixtureHostCall { method: keyof DataClient; args: unknown[] }
export interface FixtureHost extends DataClient {
  /** Every call so far, in order: assert on it to prove a component fetched (or refetched). */
  readonly calls: FixtureHostCall[];
}

function aborted(signal?: AbortSignal): Promise<never> | undefined {
  return signal?.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : undefined;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

/** Rows a `rows` query sees for a dataset key ('git_churn' or 'git_churn_1a2b3c'): the fixture of the matching source. */
function rowsForKey(key: string): Rows {
  const source = SOURCES.map(s => s.name).sort((a, b) => b.length - a.length).find(name => {
    const base = name.replace(/\./g, '_');
    return key === base || key.startsWith(base + '_');
  });
  const data = source ? DATASET_FIXTURES[source]?.data : undefined;
  return Array.isArray(data) ? (data as Rows) : [];
}

/**
 * A DataClient that answers from the fixtures, synchronously resolved promises, no network.
 *   rows     pages, sorts ('field' / '-field') and filters (`q`, substring over all cells) the fixture rows of the key's source
 *   file     the service.ts slice, relabelled with the requested path and cut to start..end; 'missing.ts' answers skipped: 'missing'
 *   diff     the working-tree payload, relabelled with the requested range and filtered by `path`
 *   highlight / outline   tokenised text / the service.ts symbols relabelled with the requested path
 * Pass `overrides` to replace any method (for example a 100k-row `rows` stub); overridden calls are recorded too.
 */
export function createFixtureHost(overrides: Partial<DataClient> = {}): FixtureHost {
  const calls: FixtureHostCall[] = [];
  const base: DataClient = {
    rows(q: RowsQuery, signal?: AbortSignal): Promise<RowsPage> {
      let rows = rowsForKey(q.key);
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter(row => Object.values(row).some(v => String(v ?? '').toLowerCase().includes(needle)));
      }
      if (q.sort) {
        const desc = q.sort.startsWith('-');
        const field = desc ? q.sort.slice(1) : q.sort;
        rows = [...rows].sort((a, b) => (desc ? -1 : 1) * compare(a[field], b[field]));
      }
      const offset = Math.max(0, q.offset ?? 0);
      const limit = Math.min(500, Math.max(1, q.limit ?? 200));
      return aborted(signal) ?? Promise.resolve(structuredClone({rows: rows.slice(offset, offset + limit), total: rows.length, offset}));
    },
    file(q: FileQuery, signal?: AbortSignal): Promise<FileSlice> {
      if (/(^|\/)missing\.[a-z]+$/.test(q.path)) {
        return aborted(signal) ?? Promise.resolve({path: q.path, lang: 'text', total: 0, start: 0, end: 0, lines: [], size: 0, skipped: 'missing', rev: 1});
      }
      const total = FILE_SLICE.total;
      const start = Math.min(total, Math.max(1, q.start ?? 1));
      const end = Math.min(total, Math.max(start, q.end ?? start + 399));
      return aborted(signal) ?? Promise.resolve(structuredClone({...FILE_SLICE, path: q.path, start, end, lines: FILE_SLICE.lines.slice(start - 1, end)}));
    },
    diff(q: DiffQuery, signal?: AbortSignal): Promise<DiffPayload> {
      const files = q.path ? DIFF.files.filter(f => f.path === q.path) : DIFF.files;
      const totals = {files: files.length, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0)};
      return aborted(signal) ?? Promise.resolve(structuredClone({...DIFF, range: q.range, files, totals}));
    },
    highlight(code: string, lang?: string, signal?: AbortSignal): Promise<HighlightResult> {
      return aborted(signal) ?? Promise.resolve({lang: lang ?? 'text', lines: tokenize(code)});
    },
    outline(path: string, signal?: AbortSignal): Promise<OutlineResult> {
      return aborted(signal) ?? Promise.resolve(structuredClone({...OUTLINE, path}));
    },
  };
  const impl = {...base, ...overrides} as DataClient;
  const record = <K extends keyof DataClient>(method: K): DataClient[K] =>
    ((...args: unknown[]) => {
      calls.push({method, args});
      return (impl[method] as (...a: unknown[]) => unknown)(...args);
    }) as DataClient[K];
  return {calls, rows: record('rows'), file: record('file'), diff: record('diff'), highlight: record('highlight'), outline: record('outline')};
}

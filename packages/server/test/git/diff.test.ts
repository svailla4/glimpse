import {existsSync} from 'node:fs';
import {appendFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {DiffFile, DiffLine, TokenLine} from '@glimpse/catalog';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {createCodeService} from '../../src/code/index.ts';
import type {CodeService} from '../../src/contracts.ts';
import {createDiffService, listChanges, wordMarks} from '../../src/git/diff.ts';
import {FIXTURE, git, makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {makeContext, type TestContext} from './context.ts';

const textOf = (tokens: TokenLine): string => tokens.map(token => token[0]).join('');
const fileOf = (files: DiffFile[], path: string): DiffFile => {
  const file = files.find(candidate => candidate.path === path);
  if (!file) throw new Error(`no ${path} in the payload`);
  return file;
};
const summary = (files: Array<{path: string; status: string; add: number; del: number}>) => files.map(file => [file.path, file.status, file.add, file.del]);

describe('listChanges', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    ctx = await makeContext(repo.root);
  });
  afterAll(async () => { await repo.cleanup(); });

  it('wt: unstaged edits against HEAD, plus untracked files as additions', async () => {
    const changes = await listChanges(ctx, 'wt');
    expect(summary(changes.files)).toEqual([['src/auth/service.ts', 'M', 5, 1], ['src/lib/metrics.ts', 'A', 9, 0], ['tools/stats.py', 'M', 6, 0]]);
    expect(changes.files.map(file => file.untracked)).toEqual([false, true, false]);
    expect(changes.totals).toEqual({files: 3, add: 20, del: 1});
    expect(changes.range.label).toBe('wt');
    expect(changes.warnings).toEqual([]);
    expect(summary((await listChanges(ctx, undefined)).files)).toEqual(summary(changes.files));
  });

  it('staged: only what is in the index', async () => {
    expect((await listChanges(ctx, 'staged')).totals).toEqual({files: 0, add: 0, del: 0});
    await git(repo.root, ['add', 'tools/stats.py']);
    try {
      const staged = await listChanges(ctx, 'staged');
      expect(summary(staged.files)).toEqual([['tools/stats.py', 'M', 6, 0]]);
      // the working tree against HEAD still shows everything
      expect((await listChanges(ctx, 'wt')).totals.files).toBe(3);
    } finally {
      await git(repo.root, ['reset', '-q', 'HEAD', 'tools/stats.py']);
    }
  });

  it('a commit range: status, counts and no working-tree files', async () => {
    const changes = await listChanges(ctx, 'main..feature');
    expect(summary(changes.files)).toEqual([
      ['src/api/limiter.ts', 'A', 12, 0], ['src/api/middleware.ts', 'M', 6, 0], ['src/api/routes.ts', 'M', 3, 0], ['test/limiter.test.ts', 'A', 8, 0],
    ]);
    expect(changes.files.filter(file => file.status === 'A').map(file => file.path)).toEqual([...FIXTURE.feature.added]);
    expect(changes.totals).toEqual({files: 4, add: 29, del: 0});
    // reversed, the additions are deletions
    expect(summary((await listChanges(ctx, 'feature..main')).files)[0]).toEqual(['src/api/limiter.ts', 'D', 0, 12]);
    // a bare ref is "what HEAD adds since it left that ref": nothing, feature is ahead of main
    expect((await listChanges(ctx, 'feature')).files).toEqual([]);
  });

  it('reports a rename with its previous path', async () => {
    const changes = await listChanges(ctx, 'main~4..main~3');
    expect(changes.files.find(file => file.status === 'R')).toEqual({path: FIXTURE.rename.to, from: FIXTURE.rename.from, status: 'R', add: 4, del: 0, binary: false, untracked: false});
    expect(changes.files).toHaveLength(4);
  });

  it('rejects text that is not a range before git runs, and unknown revisions after', async () => {
    ctx.gitCalls.length = 0;
    await expect(listChanges(ctx, '--output=x')).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(listChanges(ctx, 'main --output=x')).rejects.toMatchObject({code: 'E_TARGET'});
    expect(ctx.gitCalls).toEqual([]);
    expect(existsSync(join(repo.root, 'x'))).toBe(false);
    await expect(listChanges(ctx, 'nope')).rejects.toMatchObject({code: 'E_TARGET', message: 'unknown revision "nope"'});
    await expect(listChanges({...ctx, git: null}, 'wt')).rejects.toMatchObject({code: 'E_NO_GIT'});
  });
});

describe('listChanges with unusual working trees', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    ctx = await makeContext(repo.root);
  });
  afterAll(async () => { await repo.cleanup(); });
  afterEach(async () => {
    await git(repo.root, ['checkout', '-q', '--', '.']);
    await git(repo.root, ['clean', '-q', '-fd']);
  });

  it('is empty on a clean tree', async () => {
    expect(await listChanges(ctx, 'wt')).toMatchObject({files: [], totals: {files: 0, add: 0, del: 0}});
  });

  it('marks binary files, counts a last line without newline, and ignores ignored files', async () => {
    await writeFile(join(repo.root, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    await writeFile(join(repo.root, 'notes.txt'), 'one\ntwo\nthree');
    await writeFile(join(repo.root, 'empty.txt'), '');
    await writeFile(join(repo.root, 'debug.log'), 'ignored by .gitignore\n');
    await writeFile(join(repo.root, 'file with space.md'), '# title\n');
    await rm(join(repo.root, 'src/ui/app.css'));
    const changes = await listChanges(ctx, 'wt');
    expect(changes.files.map(file => [file.path, file.status, file.add, file.del, file.binary])).toEqual([
      ['empty.txt', 'A', 0, 0, false],
      ['file with space.md', 'A', 1, 0, false],
      ['logo.bin', 'A', 0, 0, true],
      ['notes.txt', 'A', 3, 0, false],
      ['src/ui/app.css', 'D', 0, 14, false],
    ]);
  });

  it('lists a staged rename and a staged new file once', async () => {
    await git(repo.root, ['mv', 'src/lib/db.ts', 'src/lib/database.ts']);
    await writeFile(join(repo.root, 'src/lib/extra.ts'), 'export const extra = 1;\n');
    await git(repo.root, ['add', 'src/lib/extra.ts']);
    const changes = await listChanges(ctx, 'wt');
    expect(changes.files.map(file => [file.path, file.status, file.from, file.untracked])).toEqual([
      ['src/lib/database.ts', 'R', 'src/lib/db.ts', false], ['src/lib/extra.ts', 'A', undefined, false],
    ]);
    await git(repo.root, ['reset', '-q', '--hard', 'HEAD']);
  });
});

describe('createDiffService', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  let code: CodeService;
  beforeAll(async () => {
    repo = await makeFixtureRepo();
    ctx = await makeContext(repo.root);
    code = createCodeService(ctx);
  });
  afterAll(async () => { await repo.cleanup(); });

  it('answers the working tree with hunks, line numbers, tokens and word marks', async () => {
    const payload = await createDiffService(ctx, code).diff({range: 'wt'});
    expect(payload).toMatchObject({range: 'wt', head: ctx.git!.head, totals: {files: 3, add: 20, del: 1}, rev: 1});
    expect(payload.base).toBeUndefined();
    expect(summary(payload.files)).toEqual([['src/auth/service.ts', 'M', 5, 1], ['src/lib/metrics.ts', 'A', 9, 0], ['tools/stats.py', 'M', 6, 0]]);

    const service = fileOf(payload.files, 'src/auth/service.ts');
    expect(service.lang).toBe('typescript');
    expect(service.hunks!.map(hunk => hunk.header)).toEqual([
      '@@ -10,7 +10,7 @@ interface UserRow {',
      '@@ -47,3 +47,7 @@ export async function canSeeOrder(session: Session, orderId: string): Promise<bo',
    ]);
    const [first, second] = service.hunks!;
    expect(first).toMatchObject({oldStart: 10, oldLines: 7, newStart: 10, newLines: 7});
    expect(first!.lines.map(line => [line.t, line.o, line.n])).toEqual([
      [' ', 10, 10], [' ', 11, 11], [' ', 12, 12], ['-', 13, undefined], ['+', undefined, 13], [' ', 14, 14], [' ', 15, 15], [' ', 16, 16],
    ]);
    const removed = first!.lines[3]!;
    const added = first!.lines[4]!;
    expect(textOf(removed.tokens)).toBe('const MAX_ATTEMPTS = 5;');
    expect(textOf(added.tokens)).toBe('const MAX_ATTEMPTS = 3;');
    // word level: only the number changed
    expect(removed.marks).toEqual([[21, 22]]);
    expect(added.marks).toEqual([[21, 22]]);
    expect(removed.tokens).toEqual([['const', 1], [' MAX_ATTEMPTS = ', 0], ['5', 5], [';', 0]]);
    expect(first!.lines[2]!.tokens).toEqual([]);
    expect('marks' in first!.lines[0]!).toBe(false);
    // the second hunk only adds lines: new numbers run on, old numbers stop
    expect(second!.lines.filter(line => line.t === '+').map(line => line.n)).toEqual([50, 51, 52, 53]);
    expect(second!.lines.filter(line => line.t === '+').every(line => line.o === undefined && line.marks === undefined)).toBe(true);
    expect(second!.lines[4]!.tokens.slice(0, 5)).toEqual([['export', 1], [' ', 0], ['function', 1], [' ', 0], ['isLockedOut', 3]]);

    const python = fileOf(payload.files, 'tools/stats.py');
    expect(python.lang).toBe('python');
    const def = python.hunks![0]!.lines.find(line => textOf(line.tokens).startsWith('def spread'))!;
    expect(def).toMatchObject({t: '+', n: 21});
    expect(def.tokens.slice(0, 3)).toEqual([['def', 1], [' ', 0], ['spread', 3]]);
  });

  it('shows an untracked file as one hunk of additions read from disk', async () => {
    const payload = await createDiffService(ctx, code).diff({range: 'wt'});
    const metrics = fileOf(payload.files, 'src/lib/metrics.ts');
    expect(metrics).toMatchObject({status: 'A', add: 9, del: 0, lang: 'typescript'});
    expect(metrics.hunks).toHaveLength(1);
    expect(metrics.hunks![0]).toMatchObject({oldStart: 0, oldLines: 0, newStart: 1, newLines: 9, header: '@@ -0,0 +1,9 @@'});
    const source = (await readFile(join(repo.root, 'src/lib/metrics.ts'), 'utf8')).trimEnd().split('\n');
    expect(metrics.hunks![0]!.lines.map(line => [line.t, line.n, textOf(line.tokens)])).toEqual(source.map((text, index) => ['+', index + 1, text]));
  });

  it('answers a commit range with base and head, and one file when asked for a path', async () => {
    const service = createDiffService(ctx, code);
    const payload = await service.diff({range: 'main..feature'});
    expect(payload).toMatchObject({
      range: 'main..feature',
      base: (await git(repo.root, ['rev-parse', 'main'])).slice(0, 7),
      head: (await git(repo.root, ['rev-parse', 'feature'])).slice(0, 7),
      totals: {files: 4, add: 29, del: 0},
    });
    expect(payload.files.every(file => Array.isArray(file.hunks) && file.hunks.length > 0)).toBe(true);
    const routes = fileOf(payload.files, 'src/api/routes.ts').hunks![0]!;
    expect(routes.lines.filter(line => line.t === '+').map(line => textOf(line.tokens))).toEqual([
      '  if (url.length > 2048) {', "    return {status: 414, body: {error: 'url too long'}};", '  }',
    ]);

    const one = await service.diff({range: 'main..feature', path: 'src/api/routes.ts'});
    expect(summary(one.files)).toEqual([['src/api/routes.ts', 'M', 3, 0]]);
    expect(one.totals).toEqual({files: 1, add: 3, del: 0});
    expect(one.files[0]!.hunks).toEqual(fileOf(payload.files, 'src/api/routes.ts').hunks);
    expect(await service.diff({range: 'main..feature', path: 'README.md'})).toMatchObject({files: [], totals: {files: 0, add: 0, del: 0}});
  });

  it('keeps a renamed file together, also when it is fetched by path', async () => {
    const service = createDiffService(ctx, code);
    const expected = {path: FIXTURE.rename.to, from: FIXTURE.rename.from, status: 'R', add: 4, del: 0};
    const all = await service.diff({range: 'main~4..main~3'});
    const renamed = fileOf(all.files, FIXTURE.rename.to);
    expect(renamed).toMatchObject(expected);
    expect(renamed.hunks).toHaveLength(1);
    expect(renamed.hunks![0]!.lines.filter(line => line.t !== ' ').map(line => line.t).join('')).toBe('++++');
    const one = await service.diff({range: 'main~4..main~3', path: FIXTURE.rename.to});
    expect(one.files).toEqual([renamed]);
  });

  it('highlights each side of a hunk as one block and survives a code service that fails', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const recording: CodeService = {
      ...code,
      highlight: async (text, lang) => {
        calls.push([text, lang]);
        return {lang: lang ?? 'text', lines: text.split('\n').map((line): TokenLine => [[line, 6]])};
      },
    };
    const payload = await createDiffService(ctx, recording).diff({range: 'wt', path: 'src/auth/service.ts'});
    const first = payload.files[0]!.hunks![0]!;
    // hunk 1 has both sides, hunk 2 only additions: three blocks in all
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call[1] === 'typescript')).toBe(true);
    expect(calls.map(call => call[0])).toContain(first.lines.filter(line => line.t !== '-').map(line => textOf(line.tokens)).join('\n'));
    expect(calls.map(call => call[0])).toContain(first.lines.filter(line => line.t !== '+').map(line => textOf(line.tokens)).join('\n'));
    expect(first.lines.every(line => line.tokens.every(token => token[1] === 6))).toBe(true);

    const failing: CodeService = {...code, highlight: () => Promise.reject(new Error('highlighter down'))};
    await expect(createDiffService(ctx, failing).diff({range: 'wt'})).rejects.toThrow('highlighter down');
  });

  it('refuses bad ranges and paths outside the repository', async () => {
    const service = createDiffService(ctx, code);
    await expect(service.diff({range: '--output=x'})).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(service.diff({range: 'wt', path: '../outside.ts'})).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(service.diff({range: 'nope..main'})).rejects.toMatchObject({code: 'E_TARGET'});
    await expect(createDiffService({...ctx, git: null}, code).diff({range: 'wt'})).rejects.toMatchObject({code: 'E_NO_GIT'});
    expect(existsSync(join(repo.root, 'x'))).toBe(false);
  });

  it('reports the working-tree revision it was read at', async () => {
    ctx.bump();
    expect((await createDiffService(ctx, code).diff({range: 'staged'})).rev).toBe(2);
  });
});

describe('createDiffService budget and odd content', () => {
  let repo: FixtureRepo;
  let ctx: TestContext;
  let code: CodeService;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    ctx = await makeContext(repo.root);
    code = createCodeService(ctx);
  });
  afterAll(async () => { await repo.cleanup(); });
  afterEach(async () => {
    await git(repo.root, ['checkout', '-q', '--', '.']);
    await git(repo.root, ['clean', '-q', '-fd']);
  });

  it('sends hunks for at most 30 files and loads the rest by path', async () => {
    await mkdir(join(repo.root, 'gen'));
    for (let i = 0; i < 34; i++) await writeFile(join(repo.root, 'gen', `f${String(i).padStart(2, '0')}.ts`), `export const v${i} = ${i};\n`);
    await appendFile(join(repo.root, 'src/index.ts'), '// tail\n');
    const service = createDiffService(ctx, code);
    const payload = await service.diff({range: 'wt'});
    expect(payload.totals).toEqual({files: 35, add: 35, del: 0});
    expect(payload.files).toHaveLength(35);
    expect(payload.files.filter(file => file.hunks !== undefined)).toHaveLength(30);
    const late = payload.files.find(file => file.hunks === undefined)!;
    const loaded = await service.diff({range: 'wt', path: late.path});
    expect(loaded.files).toHaveLength(1);
    expect(loaded.files[0]!.hunks).toHaveLength(1);
  });

  it('leaves out the hunks of a file that alone exceeds the line budget, until it is asked for', async () => {
    await writeFile(join(repo.root, 'big.ts'), Array.from({length: 3_200}, (_, i) => `export const n${i} = ${i};`).join('\n') + '\n');
    await appendFile(join(repo.root, 'src/index.ts'), '// tail\n');
    const service = createDiffService(ctx, code);
    const payload = await service.diff({range: 'wt'});
    expect(fileOf(payload.files, 'big.ts')).toMatchObject({add: 3_200, del: 0});
    expect(fileOf(payload.files, 'big.ts').hunks).toBeUndefined();
    expect(fileOf(payload.files, 'src/index.ts').hunks).toHaveLength(1);
    const big = (await service.diff({range: 'wt', path: 'big.ts'})).files[0]!;
    expect(big.hunks![0]!.lines).toHaveLength(3_200);
    expect(big.hunks![0]!.lines.at(-1)).toMatchObject({t: '+', n: 3_200});
  });

  it('matches hunks to files whose names have spaces, non-ASCII characters, quotes or tabs', async () => {
    const names = ['dir with space/ünï cödé.py', 'we"ird.ts', 'tab\there.ts', 'zz-plain.ts', '日本語/ファイル.go'];
    for (const name of names) {
      await mkdir(join(repo.root, name, '..'), {recursive: true});
      await writeFile(join(repo.root, name), `line one of ${JSON.stringify(name)}\nline two\n`);
    }
    await git(repo.root, ['add', '-A']);
    await git(repo.root, ['commit', '-q', '-m', 'Add oddly named files']);
    for (const name of names) await appendFile(join(repo.root, name), `added to ${JSON.stringify(name)}\n`);
    const payload = await createDiffService(ctx, code).diff({range: 'wt'});
    await git(repo.root, ['reset', '-q', '--hard', 'HEAD~1']);

    expect(payload.files.map(file => file.path).sort()).toEqual([...names].sort());
    for (const name of names) {
      const file = fileOf(payload.files, name);
      expect(file, name).toMatchObject({status: 'M', add: 1, del: 0});
      // each file got its own hunk, not a neighbour's
      expect(file.hunks!.flatMap(hunk => hunk.lines).filter(line => line.t === '+').map(line => textOf(line.tokens)), name).toEqual([`added to ${JSON.stringify(name)}`]);
    }
    const one = await createDiffService(ctx, code).diff({range: 'HEAD', path: 'README.md'});
    expect(one.files).toEqual([]);
  });

  it('handles binary files, deletions, mode changes, CRLF and a missing final newline', async () => {
    await writeFile(join(repo.root, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(repo.root, 'tsconfig.json'), Buffer.from([0x7b, 0, 0x7d]));
    await rm(join(repo.root, 'src/ui/app.css'));
    await writeFile(join(repo.root, 'README.md'), (await readFile(join(repo.root, 'README.md'), 'utf8')).trimEnd() + '\r\nlast line without newline');
    await git(repo.root, ['update-index', '--chmod=+x', 'go.mod']);
    const payload = await createDiffService(ctx, code).diff({range: 'wt'});
    await git(repo.root, ['update-index', '--chmod=-x', 'go.mod']);

    expect(fileOf(payload.files, 'logo.bin')).toMatchObject({status: 'A', binary: true, hunks: []});
    expect(fileOf(payload.files, 'tsconfig.json')).toMatchObject({status: 'M', binary: true, hunks: []});
    const css = fileOf(payload.files, 'src/ui/app.css');
    expect(css).toMatchObject({status: 'D', add: 0, del: 14, lang: 'css'});
    expect(css.hunks![0]!.lines.every(line => line.t === '-' && line.n === undefined)).toBe(true);
    expect(css.hunks![0]!.lines.map(line => line.o)).toEqual(Array.from({length: 14}, (_, i) => i + 1));

    const readme = fileOf(payload.files, 'README.md');
    const changed = readme.hunks!.flatMap(hunk => hunk.lines).filter(line => line.t !== ' ');
    // no carriage return, and no "\ No newline at end of file" pseudo line
    expect(changed.map((line: DiffLine) => [line.t, textOf(line.tokens)])).toEqual([
      ['-', '- `services/gateway` rate-limiting reverse proxy'],
      ['+', '- `services/gateway` rate-limiting reverse proxy'],
      ['+', 'last line without newline'],
    ]);
    expect(payload.totals.files).toBe(payload.files.length);
  });
});

describe('wordMarks', () => {
  it('marks the characters that differ on each side', () => {
    expect(wordMarks('  return (await digest(password)) === hash;', '  return timingSafeEqual(await digest(password), hash);')).toEqual({
      removed: [[32, 33], [34, 38]],
      added: [[9, 24], [47, 48], [53, 54]],
    });
    expect(wordMarks("import {log} from './lib/log';", "import {log} from './lib/logger';")).toEqual({removed: [[25, 28]], added: [[25, 31]]});
  });

  it('marks nothing when the lines are equal, share too little, or are very long', () => {
    expect(wordMarks('same', 'same')).toBeNull();
    expect(wordMarks('const a = 1;', 'function totallyDifferent() {')).toBeNull();
    expect(wordMarks('', 'added')).toBeNull();
    expect(wordMarks(`const a = '${'x'.repeat(600)}';`, `const a = '${'y'.repeat(600)}';`)).toBeNull();
  });
});

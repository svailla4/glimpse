import {appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOKEN_CLASSES, type FileSlice, type TokenLine} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {locate, MAX_FILE_BYTES, MAX_LINE_CHARS, repoPath} from '../../src/code/file.ts';
import {createCodeService} from '../../src/code/index.ts';
import type {CodeService} from '../../src/contracts.ts';
import {makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {makeContext, type TestContext} from '../git/context.ts';

const textOf = (line: TokenLine): string => line.map(token => token[0]).join('');
const tagged = (line: TokenLine): string => line.map(([text, cls]) => (cls === 0 ? text : `${text}«${TOKEN_CLASSES[cls]}»`)).join('');
const SKIPPED = {total: 0, start: 0, end: 0, lines: []};

describe('code service: file', () => {
  let repo: FixtureRepo;
  let outside: string;
  let ctx: TestContext;
  let code: CodeService;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    outside = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-outside-')));
    await writeFile(join(outside, 'secret.txt'), 'outside the project\n');
    ctx = await makeContext(repo.root);
    code = createCodeService(ctx);
  });
  afterAll(async () => {
    await repo.cleanup();
    await rm(outside, {recursive: true, force: true});
  });

  it('returns a highlighted TypeScript file', async () => {
    const source = (await readFile(join(repo.root, 'src/auth/tokens.ts'), 'utf8')).trimEnd().split('\n');
    const slice = await code.file({path: 'src/auth/tokens.ts'});
    expect(slice).toMatchObject({path: 'src/auth/tokens.ts', lang: 'typescript', total: source.length, start: 1, end: source.length, rev: 1});
    expect(slice.skipped).toBeUndefined();
    expect(slice.size).toBe(Buffer.byteLength(`${source.join('\n')}\n`));
    expect(slice.lines.map(textOf)).toEqual(source);
    expect(slice.lines.slice(0, 6).map(tagged)).toEqual([
      "import«kw» {createHmac, randomBytes} from«kw» 'node:crypto'«str»;",
      "import«kw» {config} from«kw» '../lib/config'«str»;",
      '',
      '// TODO: rotate the signing key«com»',
      'export«kw» function«kw» sign«fn»(payload: string«type»): string«type» {',
      "  return«kw» createHmac«fn»('sha256'«str», config.tokenSecret).update«fn»(payload).digest«fn»('hex'«str»);",
    ]);
  });

  it('returns a highlighted Python file and a Go file', async () => {
    const python = await code.file({path: 'tools/stats.py', start: 1, end: 6});
    expect(python).toMatchObject({lang: 'python', start: 1, end: 6});
    expect(python.lines.map(tagged)).toEqual([
      'import«kw» statistics',
      '',
      'from«kw» .util import«kw» chunks',
      '',
      '',
      'def«kw» summarize«fn»(values: list[float«type»]) -> dict[str«type», float«type»]:',
    ]);
    const go = await code.file({path: 'services/gateway/limiter/limiter.go', start: 8, end: 9});
    expect(go.lines.map(tagged)).toEqual(['// Limiter is a fixed-window counter per key.«com»', 'type«kw» Limiter«type» struct«kw» {']);
  });

  it('serves windows: default 400 lines, clamped to the file, never more than 2,000', async () => {
    const lines = Array.from({length: 2_600}, (_, i) => `export const value${i + 1} = ${i + 1};`);
    await writeFile(join(repo.root, 'long.ts'), `${lines.join('\n')}\n`);
    const first = await code.file({path: 'long.ts'});
    expect(first).toMatchObject({total: 2_600, start: 1, end: 400});
    expect(first.lines).toHaveLength(400);
    const middle = await code.file({path: 'long.ts', start: 1_200, end: 1_210});
    expect(middle).toMatchObject({start: 1_200, end: 1_210});
    expect(middle.lines.map(textOf)).toEqual(lines.slice(1_199, 1_210));
    expect(tagged(middle.lines[0]!)).toBe('export«kw» const«kw» value1200 = 1200«num»;');
    expect(await code.file({path: 'long.ts', start: 2_590})).toMatchObject({start: 2_590, end: 2_600});
    expect(await code.file({path: 'long.ts', start: 5_000, end: 6_000})).toMatchObject({start: 2_600, end: 2_600});
    expect(await code.file({path: 'long.ts', start: -5, end: 3})).toMatchObject({start: 1, end: 3});
    expect(await code.file({path: 'long.ts', start: 10, end: 2})).toMatchObject({start: 10, end: 10});
    expect((await code.file({path: 'long.ts', start: 1, end: 9_999})).lines).toHaveLength(2_000);
    expect(await code.file({path: 'long.ts', start: Number.NaN, end: Number.POSITIVE_INFINITY})).toMatchObject({start: 1, end: 400});
    expect(await code.file({path: 'long.ts', start: 2.9, end: 4.2})).toMatchObject({start: 2, end: 4});
    await rm(join(repo.root, 'long.ts'));
  });

  it('a window in the middle of a multi-line construct is highlighted in context', async () => {
    const lines = ['const text = `', ...Array.from({length: 900}, (_, i) => `row ${i}`), '`;', 'export const after = 1;'];
    await writeFile(join(repo.root, 'template.ts'), `${lines.join('\n')}\n`);
    const window = await code.file({path: 'template.ts', start: 700, end: 701});
    expect(window.lines).toEqual([[['row 698', 2]], [['row 699', 2]]]);
    // an earlier window afterwards, and the end of the file: all from one consistent pass
    expect((await code.file({path: 'template.ts', start: 2, end: 2})).lines).toEqual([[['row 0', 2]]]);
    expect(tagged((await code.file({path: 'template.ts', start: 903})).lines[0]!)).toBe('export«kw» const«kw» after = 1«num»;');
    await rm(join(repo.root, 'template.ts'));
  });

  it('answers concurrent windows of one file consistently', async () => {
    const lines = Array.from({length: 1_500}, (_, i) => `const n${i} = ${i};`);
    await writeFile(join(repo.root, 'parallel.ts'), lines.join('\n'));
    const slices = await Promise.all([900, 1, 400, 1_400, 650].map(start => code.file({path: 'parallel.ts', start, end: start + 49})));
    for (const slice of slices) expect(slice.lines.map(textOf)).toEqual(lines.slice(slice.start - 1, slice.end));
    for (const slice of slices) expect(slice.lines.every(line => line[0]![0] === 'const' && line[0]![1] === 1)).toBe(true);
    await rm(join(repo.root, 'parallel.ts'));
  });

  it('re-reads a file when it changes on disk and reports the revision', async () => {
    const path = join(repo.root, 'changing.ts');
    await writeFile(path, 'export const a = 1;\n');
    expect(await code.file({path: 'changing.ts'})).toMatchObject({total: 1, rev: 1});
    await appendFile(path, 'export const b = 2;\n');
    ctx.bump();
    const again = await code.file({path: 'changing.ts'});
    expect(again).toMatchObject({total: 2, rev: 2});
    expect(textOf(again.lines[1]!)).toBe('export const b = 2;');
    // same size, new content, new mtime
    await writeFile(path, 'export const a = 1;\nexport const c = 3;\n');
    await utimes(path, new Date(), new Date(Date.now() + 5_000));
    expect(textOf((await code.file({path: 'changing.ts'})).lines[1]!)).toBe('export const c = 3;');
    await rm(path);
    expect(await code.file({path: 'changing.ts'})).toMatchObject({skipped: 'missing'});
  });

  it('skips missing files, directories, binary files and files over 2 MB, with the reason', async () => {
    expect(await code.file({path: 'src/nope.ts'})).toEqual({path: 'src/nope.ts', lang: 'typescript', size: 0, skipped: 'missing', rev: ctx.rev(), ...SKIPPED});
    expect(await code.file({path: 'src'})).toMatchObject({skipped: 'missing', ...SKIPPED});
    expect(await code.file({path: ''})).toMatchObject({skipped: 'missing', ...SKIPPED});
    expect(await code.file({path: 'src/auth/tokens.ts/child'})).toMatchObject({skipped: 'missing'});
    expect(await code.file({path: 'a\0b'})).toMatchObject({skipped: 'missing'});
    expect(await code.file({} as never)).toMatchObject({skipped: 'missing'});

    await writeFile(join(repo.root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
    expect(await code.file({path: 'logo.png'})).toMatchObject({path: 'logo.png', lang: 'text', size: 8, skipped: 'binary', ...SKIPPED});
    await writeFile(join(repo.root, 'big.json'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x20));
    expect(await code.file({path: 'big.json'})).toMatchObject({lang: 'json', size: MAX_FILE_BYTES + 1, skipped: 'too-large', ...SKIPPED});
    await writeFile(join(repo.root, 'limit.txt'), Buffer.alloc(MAX_FILE_BYTES, 0x61));
    expect((await code.file({path: 'limit.txt'})).skipped).toBeUndefined();
    for (const name of ['logo.png', 'big.json', 'limit.txt']) await rm(join(repo.root, name));
  });

  it('refuses every way out of the root', async () => {
    const refused = async (path: string): Promise<FileSlice> => {
      const slice = await code.file({path});
      expect(slice, path).toMatchObject({skipped: 'outside-root', ...SKIPPED});
      expect(JSON.stringify(slice)).not.toContain('outside the project');
      return slice;
    };
    await refused('../secret.txt');
    await refused('src/../../secret.txt');
    await refused(join(outside, 'secret.txt'));
    await refused(`${repo.root}-sibling/secret.txt`);
    await refused('..');
    // links are resolved first: a file link, a directory link and a link in the middle of the path
    await symlink(join(outside, 'secret.txt'), join(repo.root, 'link.txt'));
    await symlink(outside, join(repo.root, 'linked-dir'));
    await refused('link.txt');
    await refused('linked-dir/secret.txt');
    // a link that stays inside the root is fine, and is reported under the name that was asked for
    await symlink(join(repo.root, 'README.md'), join(repo.root, 'readme-link.md'));
    expect(await code.file({path: 'readme-link.md', start: 1, end: 1})).toMatchObject({path: 'readme-link.md', lang: 'markdown', start: 1, end: 1});
    // an absolute path inside the root is accepted and answered with the relative one
    expect(await code.file({path: join(repo.root, 'go.mod')})).toMatchObject({path: 'go.mod', total: 5});
    for (const name of ['link.txt', 'linked-dir', 'readme-link.md']) await rm(join(repo.root, name));
  });

  it('shows files without a grammar as plain text, cuts very long lines and handles odd endings', async () => {
    expect(await code.file({path: '.gitignore'})).toMatchObject({lang: 'text', total: 4, lines: [[['node_modules/', 0]], [['dist/', 0]], [['__pycache__/', 0]], [['*.log', 0]]]});
    await writeFile(join(repo.root, 'empty.ts'), '');
    expect(await code.file({path: 'empty.ts'})).toMatchObject({lang: 'typescript', size: 0, ...SKIPPED});
    expect((await code.file({path: 'empty.ts'})).skipped).toBeUndefined();
    await writeFile(join(repo.root, 'crlf.ts'), '\ufeffconst a = 1;\r\nconst b = 2;');
    expect((await code.file({path: 'crlf.ts'})).lines.map(textOf)).toEqual(['const a = 1;', 'const b = 2;']);
    await writeFile(join(repo.root, 'min.js'), `var a="${'x'.repeat(MAX_LINE_CHARS * 2)}";\nvar b=1;\n`);
    const minified = await code.file({path: 'min.js'});
    expect(minified.total).toBe(2);
    expect(textOf(minified.lines[0]!)).toHaveLength(MAX_LINE_CHARS + ` … (+${MAX_LINE_CHARS + 9} characters)`.length);
    expect(textOf(minified.lines[0]!).endsWith(`… (+${MAX_LINE_CHARS + 9} characters)`)).toBe(true);
    expect(tagged(minified.lines[1]!)).toBe('var«kw» b=1«num»;');
    await mkdir(join(repo.root, 'dir with space'));
    await writeFile(join(repo.root, 'dir with space', 'ünï cödé.py'), 'x = 1\n');
    expect(await code.file({path: 'dir with space/ünï cödé.py'})).toMatchObject({path: 'dir with space/ünï cödé.py', lang: 'python', total: 1});
    for (const name of ['empty.ts', 'crlf.ts', 'min.js', 'dir with space']) await rm(join(repo.root, name), {recursive: true});
  });

  it('keeps answering correctly after more files than the cache holds', async () => {
    await mkdir(join(repo.root, 'many'));
    for (let i = 0; i < 60; i++) await writeFile(join(repo.root, 'many', `m${i}.ts`), `export const m${i} = ${i};\n`);
    for (let i = 0; i < 60; i++) expect(textOf((await code.file({path: `many/m${i}.ts`})).lines[0]!)).toBe(`export const m${i} = ${i};`);
    expect(textOf((await code.file({path: 'many/m0.ts'})).lines[0]!)).toBe('export const m0 = 0;');
    await rm(join(repo.root, 'many'), {recursive: true});
  });
});

describe('path helpers', () => {
  it('repoPath normalises repo-relative paths and rejects everything else', () => {
    expect(repoPath('src/a.ts')).toBe('src/a.ts');
    expect(repoPath('./src//auth/')).toBe('src/auth');
    expect(repoPath('src/a.ts#L10-20')).toBe('src/a.ts');
    expect(repoPath('  src/a b.ts  ')).toBe('src/a b.ts');
    expect(repoPath('')).toBe('');
    expect(repoPath(undefined)).toBe('');
    expect(repoPath('.')).toBe('');
    for (const bad of ['..', '../x', 'a/../../x', 'src/../x', '/etc/passwd', 'C:\\Users\\x', 'c:/x', 'a\0b']) expect(repoPath(bad), bad).toBeNull();
    // dots that are part of a name are fine
    expect(repoPath('a/..b/c...d')).toBe('a/..b/c...d');
  });

  it('locate answers the real path of what is inside the root', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'glimpse-locate-')));
    try {
      await mkdir(join(root, 'sub'));
      await writeFile(join(root, 'sub', 'a.txt'), 'a');
      expect(await locate(root, 'sub/a.txt')).toEqual({ok: true, abs: join(root, 'sub', 'a.txt'), rel: 'sub/a.txt'});
      expect(await locate(root, './sub/../sub/a.txt')).toMatchObject({ok: true, rel: 'sub/a.txt'});
      expect(await locate(root, 'sub')).toMatchObject({ok: true, rel: 'sub'});
      expect(await locate(root, 'sub/missing.txt')).toEqual({ok: false, reason: 'missing'});
      expect(await locate(root, '')).toEqual({ok: false, reason: 'missing'});
      expect(await locate(root, '../x')).toEqual({ok: false, reason: 'outside-root'});
      expect(await locate(root, `${root}x`)).toEqual({ok: false, reason: 'outside-root'});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});

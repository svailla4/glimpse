import {TOKEN_CLASSES, type TokenClass, type TokenLine} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createCodeService} from '../../src/code/index.ts';
import {plainLines, prepareLang, splitLines, tokenizeLines} from '../../src/code/highlight.ts';
import {GRAMMARS, grammarOfName, langOfPath} from '../../src/code/langs.ts';
import {classOfColor, glimpseTheme} from '../../src/code/theme.ts';
import type {CodeService} from '../../src/contracts.ts';
import {makeFixtureRepo, type FixtureRepo} from '../fixtures/repo.ts';
import {makeContext} from '../git/context.ts';

const textOf = (line: TokenLine): string => line.map(token => token[0]).join('');
/** 'export«kw» function«kw» take«fn»(…': the line with every non-plain token tagged by its class. */
const tagged = (line: TokenLine): string => line.map(([text, cls]) => (cls === 0 ? text : `${text}«${TOKEN_CLASSES[cls]}»`)).join('');
/** The class of the token that is exactly `text`. */
const classOf = (lines: TokenLine[], text: string): string | undefined => {
  for (const line of lines) for (const [value, cls] of line) if (value === text) return TOKEN_CLASSES[cls];
  return undefined;
};

const TYPESCRIPT = `import {createHmac} from 'node:crypto';
// Signs a payload.
export async function sign<T extends Payload>(payload: T, rounds = 3): Promise<string> {
  const secret = await loadSecret(\`key:\${payload.id + 1}\`);
  if (typeof secret !== 'string') throw new AuthError('no secret');
  return rounds > LIMIT ? null : createHmac('sha256', secret).digest('hex');
}
export class Signer extends Base { readonly status = 401; }`;

const PYTHON = `import statistics
from typing import Optional


class Report(Base):
    """Builds a report."""

    def build(self, count: int = 3) -> Optional[str]:
        # FIXME: empty input
        if count > 2 and not self.rows:
            return f"rows: {count}"
        return None if True else len([1.5])
`;

describe('code service: highlight', () => {
  let repo: FixtureRepo;
  let code: CodeService;
  beforeAll(async () => {
    repo = await makeFixtureRepo({dirty: false});
    code = createCodeService(await makeContext(repo.root));
  });
  afterAll(async () => { await repo.cleanup(); });

  it('classifies a TypeScript sample', async () => {
    const result = await code.highlight(TYPESCRIPT, 'typescript');
    expect(result.lang).toBe('typescript');
    expect(result.lines.map(textOf)).toEqual(TYPESCRIPT.split('\n'));
    expect(result.lines.map(tagged)).toEqual([
      "import«kw» {createHmac} from«kw» 'node:crypto'«str»;",
      '// Signs a payload.«com»',
      'export«kw» async«kw» function«kw» sign«fn»<T«type» extends«kw» Payload«type»>(payload: T«type», rounds = 3«num»): Promise«type»<string«type»> {',
      // (the interpolation is written in two pieces so this stays a plain string)
      '  const«kw» secret = await«kw» loadSecret«fn»(`key:«str»$' + '{payload.id + 1«num»}`«str»);',
      "  if«kw» (typeof«kw» secret !== 'string'«str») throw«kw» new«kw» AuthError«fn»('no secret'«str»);",
      "  return«kw» rounds > LIMIT ? null«const» : createHmac«fn»('sha256'«str», secret).digest«fn»('hex'«str»);",
      '}',
      'export«kw» class«kw» Signer«type» extends«kw» Base«type» { readonly«kw» status = 401«num»; }',
    ]);
    // every class of the contract occurs: kw str fn type num const com
    const used = new Set(result.lines.flatMap(line => line.map(token => token[1])));
    expect([...used].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('classifies a Python sample', async () => {
    const result = await code.highlight(PYTHON, 'python');
    expect(result.lang).toBe('python');
    // the trailing newline does not make a line
    expect(result.lines.map(textOf)).toEqual(PYTHON.trimEnd().split('\n'));
    expect(result.lines.map(tagged)).toEqual([
      'import«kw» statistics',
      'from«kw» typing import«kw» Optional',
      '',
      '',
      'class«kw» Report«type»(Base«type»):',
      '    """Builds a report."""«str»',
      '',
      '    def«kw» build«fn»(self, count: int«type» = 3«num») -> Optional[str«type»]:',
      '        # FIXME: empty input«com»',
      '        if«kw» count > 2«num» and«kw» not«kw» self«const».rows:',
      '            return«kw» f«kw»"rows: «str»{«const»count}«const»"«str»',
      '        return«kw» None«const» if«kw» True«const» else«kw» len«fn»([1.5«num»])',
    ]);
  });

  it('accepts language aliases and file extensions', async () => {
    for (const [name, lang] of [['ts', 'typescript'], ['TypeScript', 'typescript'], ['py', 'python'], ['golang', 'go'], ['sh', 'shellscript'], ['yml', 'yaml'], ['c++', 'cpp'], ['C#', 'csharp'], ['docker', 'dockerfile'], ['md', 'markdown']] as const) {
      expect((await code.highlight('x', name)).lang, name).toBe(lang);
    }
  });

  it('returns plain lines for an unknown or missing language', async () => {
    for (const lang of ['brainfuck', '', undefined, '../../etc/passwd', 'constructor', '__proto__']) {
      expect(await code.highlight('a = 1\n\n  b', lang)).toEqual({lang: 'text', lines: [[['a = 1', 0]], [], [['  b', 0]]]});
    }
  });

  it('handles empty input, CRLF line ends and non-string input', async () => {
    expect(await code.highlight('', 'ts')).toEqual({lang: 'typescript', lines: []});
    expect((await code.highlight('const a = 1;\r\nconst b = 2;\r\n', 'ts')).lines.map(textOf)).toEqual(['const a = 1;', 'const b = 2;']);
    expect((await code.highlight('\n\n', 'ts')).lines).toEqual([[], []]);
    expect(await code.highlight(undefined as unknown as string, 'ts')).toEqual({lang: 'text', lines: []});
  });

  it('never merges markup into tokens: text comes back verbatim', async () => {
    const hostile = '<script>alert("x")</script> & <b>';
    const result = await code.highlight(hostile, 'html');
    expect(result.lines.map(textOf)).toEqual([hostile]);
  });

  it('returns very large snippets as plain text and does not tokenise very long lines', async () => {
    const huge = `const a = '${'x'.repeat(600_000)}';`;
    expect(await code.highlight(huge, 'ts')).toEqual({lang: 'text', lines: [[[huge, 0]]]});
    const long = `const a = '${'x'.repeat(5_000)}';`;
    const result = await code.highlight(`${long}\nconst b = 2;`, 'ts');
    expect(result.lines[0]).toEqual([[long, 0]]);
    expect(tagged(result.lines[1]!)).toBe('const«kw» b = 2«num»;');
  });
});

describe('tokenizeLines', () => {
  it('carries the grammar state across chunks and across calls', async () => {
    const grammar = (await prepareLang('ts'))!;
    // a template string that spans 1,000 lines: every line inside it is a string, the code after it is code again
    const lines = ['const text = `', ...Array.from({length: 1_000}, (_, i) => `line ${i}`), '`;', 'const after = 1;'];
    const whole = await tokenizeLines(lines, grammar);
    expect(whole.lines).toHaveLength(lines.length);
    expect(whole.lines[500]).toEqual([['line 499', 2]]);
    expect(whole.lines[1_000]).toEqual([['line 999', 2]]);
    expect(whole.lines.at(-1)!.map(token => token[1])).toContain(1);

    const head = await tokenizeLines(lines.slice(0, 300), grammar);
    const tail = await tokenizeLines(lines.slice(300), grammar, head.state);
    expect([...head.lines, ...tail.lines]).toEqual(whole.lines);
    // without the state the same lines read as code
    expect((await tokenizeLines(lines.slice(300, 302), grammar)).lines).not.toEqual(whole.lines.slice(300, 302));
  });

  it('yields to the event loop between chunks', async () => {
    const grammar = (await prepareLang('ts'))!;
    let turns = 0;
    const timer = setInterval(() => { turns++; }, 0);
    await tokenizeLines(Array.from({length: 4_000}, (_, i) => `export const value${i}: number = ${i};`), grammar);
    clearInterval(timer);
    expect(turns).toBeGreaterThan(2);
  });
});

describe('languages and theme', () => {
  it('maps paths to a grammar and a display name', () => {
    expect(langOfPath('src/a.ts')).toEqual({id: 'typescript', name: 'TypeScript'});
    expect(langOfPath('src/ui/App.tsx')).toEqual({id: 'tsx', name: 'TypeScript'});
    expect(langOfPath('tools/cli.py')).toEqual({id: 'python', name: 'Python'});
    expect(langOfPath('services/gateway/main.go')).toEqual({id: 'go', name: 'Go'});
    expect(langOfPath('Dockerfile')).toEqual({id: 'dockerfile', name: 'Dockerfile'});
    expect(langOfPath('deploy/Dockerfile.prod')?.id).toBe('dockerfile');
    expect(langOfPath('a/b/Gemfile')?.id).toBe('ruby');
    expect(langOfPath('include/x.HPP')?.id).toBe('cpp');
    expect(langOfPath('.zshrc')?.id).toBe('shellscript');
    for (const path of ['LICENSE', 'a/b/noext', '.gitignore', 'image.png', 'archive.tar.gz', 'x.constructor', '']) expect(langOfPath(path), path).toBeUndefined();
  });

  it('resolves every grammar id, and every language the table names has a grammar', async () => {
    expect(Object.keys(GRAMMARS).sort()).toEqual([
      'c', 'cpp', 'csharp', 'css', 'dart', 'diff', 'dockerfile', 'go', 'html', 'java', 'javascript', 'json', 'jsx', 'kotlin', 'markdown', 'php',
      'python', 'ruby', 'rust', 'shellscript', 'sql', 'swift', 'toml', 'tsx', 'typescript', 'yaml',
    ]);
    for (const id of Object.keys(GRAMMARS)) {
      expect(grammarOfName(id)).toBe(id);
      expect(await prepareLang(id), id).toBe(id);
    }
    for (const path of ['a.kt', 'a.rb', 'a.cs', 'a.php', 'a.swift', 'a.dart', 'a.c', 'a.rs', 'a.java', 'a.sql', 'a.toml', 'a.html', 'a.css', 'a.json', 'a.jsx', 'a.patch']) {
      expect(Object.hasOwn(GRAMMARS, langOfPath(path)!.id), path).toBe(true);
    }
  });

  it('tokenises a line of each language without losing text', async () => {
    const samples: Record<string, string> = {
      go: 'func (l *Limiter) Allow(key string) bool { return true }', rust: 'pub fn main() -> Result<(), Error> { Ok(()) }',
      java: 'public class Foo extends Bar { private final int x = 3; }', kotlin: 'class Foo(val x: Int) : Bar() { fun name(): Int = 0 }',
      ruby: 'def name(x = 1) = x.to_s + "a"', csharp: 'public class Foo : Bar { private readonly int x = 3; }', php: '<?php function name(int $x = 1): ?string { return null; }',
      swift: 'struct Foo: Bar { let x: Int = 3 }', dart: "class Foo extends Bar { final int x = 3; String name() => 'a'; }", c: 'int main(void) { return 0; } /* c */',
      cpp: 'template <typename T> class Foo : public Bar { int x = 3; };', css: '.app > a:hover { color: #fff; margin: 2rem auto; }', html: '<div class="a">text<!-- c --></div>',
      markdown: '# Title with `code` and [link](https://example.test)', yaml: 'name: ci # comment', toml: 'name = "shop" # c', sql: "SELECT id FROM users WHERE email = 'a' -- c",
      shellscript: 'for f in *.ts; do echo "$f"; done # c', dockerfile: 'FROM node:22 AS build', diff: '+added line', json: '{"name": "shop", "n": 1, "ok": true}',
      javascript: 'export const f = (a) => a * 2; // c', jsx: 'const a = <b className="c">{d}</b>;', tsx: 'const a = <B c={d as string} />;',
    };
    for (const [lang, sample] of Object.entries(samples)) {
      const grammar = (await prepareLang(lang))!;
      const {lines} = await tokenizeLines([sample], grammar);
      expect(lines.map(textOf), lang).toEqual([sample]);
      expect(lines[0]!.some(token => token[1] !== 0), `${lang} has at least one classified token`).toBe(true);
      expect(lines[0]!.every(token => Number.isInteger(token[1]) && token[1] >= 0 && token[1] <= 7 && token[0] !== ''), lang).toBe(true);
    }
  });

  it('keeps operators plain and word operators as keywords', async () => {
    const {lines} = await tokenizeLines(['const ok = a + b === c && typeof d !== "x" ? new E() : (f) => g;'], (await prepareLang('ts'))!);
    for (const operator of ['+', '===', '&&', '=>', '?', ':', '=']) expect(classOf(lines, operator), operator).toBeUndefined();
    expect(tagged(lines[0]!)).toBe('const«kw» ok = a + b === c && typeof«kw» d !== "x"«str» ? new«kw» E«fn»() : (f) => g;');
  });

  it('maps sentinel colours back to classes and everything else to plain', () => {
    const classes: TokenClass[] = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(classes.map(cls => classOfColor(`#00000${cls}`))).toEqual(classes);
    for (const color of [undefined, '', '#000000', '#000008', '#0000010', '#FFFFFF', 'red']) expect(classOfColor(color)).toBe(0);
    // every rule of the theme uses a sentinel
    const colors = (glimpseTheme.tokenColors ?? []).map(rule => rule.settings.foreground);
    expect(colors.every(color => /^#00000[0-7]$/.test(color ?? ''))).toBe(true);
    expect(new Set(colors.map(classOfColor))).toEqual(new Set(classes));
  });

  it('splits and wraps lines consistently', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(plainLines(['a', '', ' b'])).toEqual([[['a', 0]], [], [[' b', 0]]]);
  });
});

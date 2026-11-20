import {describe, expect, it} from 'vitest';
import {blankBlockComments, scanFile} from '../../src/analyze/facts.ts';
import {languageOf} from '../../src/analyze/languages.ts';

const scan = (path: string, text: string) => scanFile(text, languageOf(path)!);
const imports = (path: string, text: string) => scan(path, text).imports.map(i => `${i.spec} ${i.kind} ${i.line}`);
const symbols = (path: string, text: string) =>
  scan(path, text).symbols.map(s => `${'  '.repeat(s.depth)}${s.kind} ${s.name} ${s.line}${s.endLine ? `-${s.endLine}` : ''}${s.exported ? ' +' : ''}`);

describe('imports', () => {
  it('TypeScript and JavaScript', () => {
    const text = [
      "import {a} from './a';",
      "import type {B} from '../b';",
      "import def, * as ns from \"pkg\";",
      "import './side-effect.css';",
      'import {',
      '  one,',
      '  two,',
      "} from '@scope/multi';",
      "export * from './re';",
      "export type {T} from './types';",
      "const lazy = await import('./lazy');",
      "const fs = require('node:fs');",
      "export const notAnImport = 'from somewhere';",
      "// import {gone} from './commented-line';",
    ].join('\n');
    expect(imports('src/x.ts', text)).toEqual([
      './a static 1', '../b type 2', 'pkg static 3', './side-effect.css static 4', '@scope/multi static 5', './re reexport 9', './types type 10',
      './lazy dynamic 11', 'node:fs require 12', './commented-line static 14',
    ]);
  });

  it('TypeScript: block comments and JSDoc import types are not imports; long specifier lists are found', () => {
    const names = Array.from({length: 400}, (_, i) => `name${i}`).join(',\n  ');
    const text = `/**\n * @param {import('./jsdoc').T} x\n * import {no} from './no';\n */\nimport {\n  ${names},\n} from './big';\n`;
    expect(imports('src/x.ts', text)).toEqual(['./big static 406']);
  });

  it('Python', () => {
    const text = [
      'import os, sys as system',
      'import a.b.c',
      'from . import sibling',
      'from ..pkg import (one,',
      '    two)',
      'from x.y import z  # trailing',
      '"""',
      'from docstring import nothing',
      '"""',
    ].join('\n');
    const facts = scan('pkg/mod.py', text);
    expect(facts.imports.map(i => `${i.spec} ${i.line}`)).toEqual(['os 1', 'sys 1', 'a.b.c 2', '. 3', '..pkg 4', 'x.y 6']);
    expect(facts.imports.find(i => i.spec === '..pkg')?.names).toEqual(['one', 'two']);
    expect(facts.imports.find(i => i.spec === '.')?.names).toEqual(['sibling']);
  });

  it('Go: single imports and import blocks, with the line of each entry', () => {
    const text = 'package main\n\nimport "fmt"\nimport (\n\t"net/http"\n\talias "example.com/shop/pkg/a"\n\t_ "embed"\n)\n';
    expect(imports('main.go', text)).toEqual(['fmt package 3', 'net/http package 5', 'example.com/shop/pkg/a package 6', 'embed package 7']);
    expect(scan('main.go', text).pkg).toBe('main');
  });

  it('Rust: use paths, brace lists, mod declarations', () => {
    const text = 'mod parser;\npub mod ast;\nuse crate::ast::Node;\nuse super::{lexer::Token, util};\nuse std::collections::HashMap;\nextern crate serde;\n';
    expect(imports('src/lib.rs', text)).toEqual([
      'parser mod 1', 'ast mod 2', 'crate::ast::Node static 3', 'super::lexer::Token static 4', 'super::util static 4', 'std::collections::HashMap static 5', 'serde static 6',
    ]);
  });

  it('Java, Kotlin, C#, PHP, Ruby, Swift, Dart, C', () => {
    expect(imports('A.java', 'package com.acme.app;\nimport com.acme.util.Strings;\nimport static com.acme.util.Maths.max;\nimport java.util.*;\n'))
      .toEqual(['com.acme.util.Strings static 2', 'com.acme.util.Maths.max member 3', 'java.util wildcard 4']);
    expect(scan('A.java', 'package com.acme.app;\n').pkg).toBe('com.acme.app');
    expect(imports('A.kt', 'package com.acme\nimport com.acme.util.Strings\nimport com.acme.io.* \nimport com.acme.x.Y as Z\n'))
      .toEqual(['com.acme.util.Strings static 2', 'com.acme.io wildcard 3', 'com.acme.x.Y static 4']);
    expect(imports('A.cs', 'using System;\nusing Acme.Core.Models;\nusing static Acme.Util.Maths;\nnamespace Acme.App;\n'))
      .toEqual(['System package 1', 'Acme.Core.Models package 2', 'Acme.Util.Maths package 3']);
    expect(scan('A.cs', 'namespace Acme.App;\n').pkg).toBe('Acme.App');
    expect(imports('a.php', "<?php\nnamespace App\\Http;\nuse App\\Models\\User;\nuse function App\\helpers\\fmt;\nrequire_once __DIR__ . '/boot.php';\n"))
      .toEqual(['App\\Models\\User static 3', 'App\\helpers\\fmt static 4', '/boot.php relative 5']);
    expect(imports('a.rb', "require 'json'\nrequire_relative 'lib/thing'\n")).toEqual(['json static 1', 'lib/thing relative 2']);
    expect(imports('A.swift', 'import Foundation\n@testable import AppCore\nimport struct Models.User\n'))
      .toEqual(['Foundation package 1', 'AppCore package 2', 'Models.User package 3']);
    expect(imports('a.dart', "import 'dart:io';\nimport 'package:app/src/a.dart';\nexport 'src/b.dart';\npart 'a.g.dart';\n"))
      .toEqual(['dart:io static 1', 'package:app/src/a.dart static 2', 'src/b.dart reexport 3', 'a.g.dart part 4']);
    expect(imports('a.c', '#include <stdio.h>\n#include "util/list.h"\n  # include "x.h"\n')).toEqual(['stdio.h system 1', 'util/list.h relative 2', 'x.h relative 3']);
  });
});

describe('symbols', () => {
  it('TypeScript: declarations, members of a class, nesting and export state', () => {
    const text = [
      "export interface Config { port: number }",              // 1
      'export type Id = string;',                              // 2
      'const LIMIT = 5;',                                      // 3
      'export const handler = async (req: Request) => {',     // 4
      '  const inner = (x: number) => x + 1;',                 // 5
      '  return inner(1);',                                    // 6
      '};',                                                    // 7
      'export class Store<T> extends Base {',                  // 8
      '  private items: T[] = [];',                            // 9
      '  static create(): Store<unknown> {',                   // 10
      '    return new Store();',                               // 11
      '  }',                                                   // 12
      '  async add(',                                          // 13
      '    item: T,',                                          // 14
      '  ): Promise<void> {',                                  // 15
      '    if (item) {',                                       // 16
      '      this.items.push(item);',                          // 17
      '    }',                                                 // 18
      '  }',                                                   // 19
      '  #secret = () => {',                                   // 20
      '    return 1;',                                         // 21
      '  };',                                                  // 22
      '}',                                                     // 23
      'function helper(a: number) {',                          // 24
      '  function nested() {}',                                // 25
      '  return a;',                                           // 26
      '}',                                                     // 27
      'export default function main(): void {}',               // 28
      'export enum Mode { A, B }',                             // 29
      'declare namespace Legacy {}',                           // 30
    ].join('\n');
    expect(symbols('src/x.ts', text)).toEqual([
      'iface Config 1 +',
      'type Id 2 +',
      'const LIMIT 3',
      'fn handler 4-7 +',
      '  fn inner 5',
      'class Store 8-23 +',
      '  var items 9',
      '  method create 10-12 +',
      '  method add 13-19 +',
      '  method #secret 20-22',
      'fn helper 24-27',
      '  fn nested 25',
      'fn main 28 +',
      'enum Mode 29 +',
      'mod Legacy 30',
    ]);
  });

  it('TypeScript: calls and control flow inside bodies are not symbols', () => {
    const text = [
      "describe('suite', () => {",
      "  it('works', async () => {",
      '    expect(run(1)).toBe(2);',
      '  });',
      '});',
      'export class A {',
      '  run() {',
      '    if (this.x) {',
      '      setTimeout(() => {',
      '        go();',
      '      }, 1);',
      '    }',
      '    for (const a of b) {',
      '      count = a;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(symbols('a.test.ts', text)).toEqual(['class A 6-17 +', '  method run 7-16 +']);
  });

  it('Python: classes, methods, nested functions, constants', () => {
    const text = [
      'MAX_SIZE = 10',
      'class Report(Base):',
      '    def __init__(self) -> None:',
      '        self.x = 1',
      '',
      '    async def build(',
      '        self,',
      '    ) -> dict:',
      '        def helper():',
      '            return 1',
      '        return {}',
      '',
      'def _private():',
      '    pass',
    ].join('\n');
    expect(symbols('a.py', text)).toEqual([
      'const MAX_SIZE 1 +', 'class Report 2-11 +', '  method __init__ 3-4', '  method build 6-11 +', '    fn helper 9-10', 'fn _private 13-14',
    ]);
  });

  it('Go: functions, methods, types', () => {
    const text = 'package a\n\nconst Max = 3\n\ntype Limiter struct {\n\tn int\n}\n\ntype Doer interface {\n\tDo()\n}\n\ntype ID string\n\nfunc New() *Limiter {\n\treturn nil\n}\n\nfunc (l *Limiter) allow() bool {\n\treturn true\n}\n';
    expect(symbols('a.go', text)).toEqual(['const Max 3 +', 'class Limiter 5-7 +', 'iface Doer 9-11 +', 'type ID 13 +', 'fn New 15-17 +', 'method allow 19-21']);
  });

  it('Rust: items, impl methods and visibility', () => {
    const text = 'pub struct Parser {\n    pos: usize,\n}\n\nimpl Parser {\n    pub fn new() -> Self {\n        Parser { pos: 0 }\n    }\n    fn step(&mut self) {}\n}\n\npub(crate) trait Visit {\n    fn visit(&self);\n}\n\nenum Kind { A }\nconst LIMIT: usize = 4;\nfn main() {}\n';
    expect(symbols('a.rs', text)).toEqual([
      'class Parser 1-3 +', 'method new 6-8 +', 'method step 9', 'iface Visit 12-14 +', '  method visit 13', 'enum Kind 16', 'const LIMIT 17', 'fn main 18',
    ]);
  });

  it('Java and C#: types and methods', () => {
    const java = 'package x;\npublic class Service {\n    private final Repo repo;\n    public Service(Repo repo) {\n        this.repo = repo;\n    }\n    public List<String> names(int limit) throws IOException {\n        return repo.names();\n    }\n    interface Hook {}\n}\n';
    expect(symbols('Service.java', java)).toEqual(['class Service 2-11 +', '  method names 7-9 +', '  iface Hook 10']);
    const cs = 'namespace X;\npublic class Service\n{\n    public async Task<int> RunAsync(int n)\n    {\n        return n;\n    }\n}\npublic enum Mode { A }\n';
    expect(symbols('Service.cs', cs)).toEqual(['class Service 2-8 +', '  method RunAsync 4-7 +', 'enum Mode 9 +']);
  });

  it('Kotlin, Swift, Ruby, PHP, Dart, C', () => {
    expect(symbols('a.kt', 'package x\nconst val LIMIT = 3\ndata class User(val id: String)\nenum class Mode { A }\ninterface Repo {\n    fun find(id: String): User?\n}\nprivate fun helper() = 1\n'))
      .toEqual(['const LIMIT 2 +', 'class User 3 +', 'enum Mode 4 +', 'iface Repo 5-7 +', '  method find 6 +', 'fn helper 8']);
    expect(symbols('a.swift', 'public struct Point {\n    func length() -> Double { 0 }\n}\nprotocol Shape {}\nprivate func helper() {}\nextension Point: Shape {}\n'))
      .toEqual(['class Point 1-3 +', '  method length 2 +', 'iface Shape 4 +', 'fn helper 5', 'class Point 6 +']);
    expect(symbols('a.rb', 'module Shop\n  LIMIT = 3\n  class Cart\n    def total\n      1\n    end\n    def _hidden; end\n  end\nend\n'))
      .toEqual(['mod Shop 1-9 +', '  const LIMIT 2 +', '  class Cart 3-8 +', '    method total 4-6 +', '    method _hidden 7']);
    expect(symbols('a.php', '<?php\nfinal class Cart\n{\n    const LIMIT = 3;\n    public function total(): int\n    {\n        return 1;\n    }\n    private function hidden() {}\n}\nfunction helper() {}\n'))
      .toEqual(['class Cart 2-10 +', '  const LIMIT 4 +', '  method total 5-8 +', '  method hidden 9', 'fn helper 11 +']);
    expect(symbols('a.dart', 'class Cart {\n  int total() {\n    return 1;\n  }\n}\nenum Mode { a }\nvoid main() {\n  run();\n}\ntypedef Fn = void Function();\n'))
      .toEqual(['class Cart 1-5 +', '  method total 2-4 +', 'enum Mode 6 +', 'fn main 7-9 +', 'type Fn 10 +']);
    expect(symbols('a.c', '#include "a.h"\nstruct point {\n  int x;\n};\nstatic int helper(int a)\n{\n  return a;\n}\nint main(void) {\n  if (helper(1)) {\n    return 0;\n  }\n  return 1;\n}\nint declared(void);\n'))
      .toEqual(['class point 2-4 +', 'fn helper 5-8', 'fn main 9-14 +']);
  });

  it('caps the outline of a file with thousands of declarations, and says how many there were', () => {
    const text = Array.from({length: 5000}, (_, i) => `export function f${i}() {}`).join('\n');
    const facts = scan('big.ts', text);
    expect(facts.symbols).toHaveLength(2000);
    expect(facts.symbolsFound).toBe(5000);
    // a file inside the cap carries no count: its outline is complete
    expect(scan('small.ts', 'export function f() {}\n').symbolsFound).toBeUndefined();
  });

  it('Python: module constants with a type annotation, private ones included', () => {
    const text = [
      'PRESERVED: Final[set[str]] = load()',
      '_DEFAULT_VERSION: Final[str] = "0.9"',
      '_LOCALIZABLE: Final[tuple[str, ...]] = (',
      '    "a.json",',
      ')',
      '__ALL_CAPS = 1',
      '_not_a_constant = 2',
      'value == OTHER',
      'def f():',
      '    LOCAL = 1',
    ].join('\n');
    expect(symbols('consts.py', text)).toEqual(['const PRESERVED 1 +', 'const _DEFAULT_VERSION 2', 'const _LOCALIZABLE 3-5', 'const __ALL_CAPS 6', 'fn f 9-10 +']);
  });

  it('Dart: generic return types with spaces and signatures that break after the parenthesis', () => {
    const text = [
      'class Processor<T> {',
      '  PayloadValidator<T, Impl> validatorFor(',
      '    Catalog<T, Impl> catalog, {',
      '    Version version = Version.v1,',
      '  }) {',
      '    return make(catalog);',
      '  }',
      '',
      '  Catalog<T, Impl> catalogFor(String id) {',
      '    for (final Catalog<T, Impl> catalog in catalogs) {',
      '      if (catalog.id == id) return catalog;',
      '    }',
      '    throw StateError(',
      "      'none',",
      '    );',
      '  }',
      '',
      '  Future<Object?> callAgent(',
      '    String surfaceId,',
      '  ) async {',
      '    final result = await run(',
      '      surfaceId,',
      '    );',
      '    return Scaffold(',
      '      body: Container(',
      '        child: Text(surfaceId),',
      '      ),',
      '    );',
      '  }',
      '',
      '  static Map<String, Object?> _normalize(Map<String, Object?> raw) => raw;',
      '  String? _name() => null;',
      '}',
    ].join('\n');
    // every declaration, and nothing from the bodies: calls that break after their parenthesis are not signatures
    expect(scan('p.dart', text).symbols.map(symbol => `${symbol.kind} ${symbol.name} ${symbol.line}`)).toEqual([
      'class Processor 1', 'method validatorFor 2', 'method catalogFor 9', 'method callAgent 18', 'method _normalize 31', 'method _name 32',
    ]);
  });
});

// F092: SymbolOutline on a README was always the empty state.
describe('Markdown outline', () => {
  const README = [
    '---',
    '# not a heading: a YAML comment in the front matter',
    'title: x',
    '---',
    '# Glimpse',
    '',
    'Intro.',
    '',
    '## Install `npm i`',
    '',
    '```sh',
    '# a shell comment, not a heading',
    '```',
    '',
    '### From [source](https://example.com) ###',
    '',
    '## Usage',
    '#hashtag is no heading',
    '####### seven is no heading',
    '',
  ].join('\n');

  it('lists ATX headings as symbols, nested by level, each running to the next heading of its level or higher', () => {
    const facts = scan('README.md', README);
    expect(facts.symbols).toEqual([
      {name: 'Glimpse', kind: 'heading', line: 5, endLine: 19, depth: 0, exported: true},
      {name: 'Install npm i', kind: 'heading', line: 9, endLine: 16, depth: 1, exported: true},
      {name: 'From source', kind: 'heading', line: 15, endLine: 16, depth: 2, exported: true},
      {name: 'Usage', kind: 'heading', line: 17, endLine: 19, depth: 1, exported: true},
    ]);
    // no imports, no complexity: prose stays prose
    expect(facts.imports).toEqual([]);
    expect(facts.complexity).toBe(0);
  });

  it('ignores headings in code fences of either kind and keeps a fence open until its own closing run', () => {
    const text = '~~~~\n# in tilde fence\n~~~\n# still inside\n~~~~\n# Out\n````md\n```\n# inside\n````\n## Last\n';
    expect(scan('notes.md', text).symbols.map(symbol => `${symbol.name} ${symbol.line}`)).toEqual(['Out 6', 'Last 11']);
  });

  it('skips HTML comments, reads setext headings, and takes a leading --- for front matter only when it holds keys (V073)', () => {
    const outline = (text: string) => scan('README.md', text).symbols.map(symbol => `${symbol.name}@${symbol.line}${symbol.endLine ? `-${symbol.endLine}` : ''}/d${symbol.depth}`);
    expect(outline('# A\n<!--\n# commented out\n-->\n## B\n')).toEqual(['A@1-5/d0', 'B@5/d1']);
    expect(outline('# A\n<!-- one line --> text\n## B\n')).toEqual(['A@1-3/d0', 'B@3/d1']);
    expect(outline('---\n# Title\n\nIntro\n\n---\n\n## Usage\ntext\n')).toEqual(['Title@2-9/d0', 'Usage@8-9/d1']);
    expect(outline('---\ntitle: x\n# comment\n---\n# Real\n')).toEqual(['Real@5/d0']);
    expect(outline('Title\n=====\n\nSub\nline two\n---\n# Atx\n')).toEqual(['Title@1-6/d0', 'Sub line two@4-6/d1', 'Atx@7/d0']);
    // a rule after a blank line, or under a list item, is no heading; neither is an empty closing run
    expect(outline('# A\n\ntext\n\n---\n- item\n---\n### ###\n')).toEqual(['A@1-8/d0']);
  });

  it('is empty for a file with no headings, and source files keep their own outline', () => {
    expect(scan('NOTES.md', 'just text\n').symbols).toEqual([]);
    expect(scan('a.ts', '# not markdown\nexport function f() {}\n').symbols.map(symbol => symbol.kind)).toEqual(['fn']);
  });
});

describe('complexity', () => {
  it('sums indentation levels over code lines; blank and comment-only lines do not count', () => {
    const text = 'function a() {\n  if (x) {\n    // only a comment\n\n    go();\n  }\n}\n';
    expect(scan('a.ts', text)).toMatchObject({complexity: 1 + 2 + 1, maxIndent: 2});
  });

  it('takes the most frequent indent step as the unit, so JSDoc continuation lines do not make it 1', () => {
    const text = [
      '/**',
      ' * A long comment.',
      ' * With many lines.',
      ' * That start at column 1.',
      ' */',
      'export function a() {',
      '  if (x) {',
      '    for (;;) {',
      '      go();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(scan('a.ts', text)).toMatchObject({maxIndent: 3, complexity: 1 + 2 + 3 + 2 + 1});
  });

  it('reads tabs and four-space indentation as one level each', () => {
    expect(scan('a.go', 'func a() {\n\tif x {\n\t\tgo()\n\t}\n}\n')).toMatchObject({maxIndent: 2, complexity: 4});
    expect(scan('a.py', 'def a():\n    if x:\n        go()\n    return 1\n')).toMatchObject({maxIndent: 2, complexity: 4});
  });

  it('is zero for data, prose and markup, which still report TODO tags where they have comments', () => {
    expect(scan('a.json', '{\n  "a": {\n    "b": 1\n  }\n}\n')).toMatchObject({complexity: 0, maxIndent: 0, symbols: [], imports: []});
    expect(scan('a.yaml', 'a:\n  b: 1 # TODO: tune\n')).toMatchObject({complexity: 0, todos: [{tag: 'TODO', line: 2, text: 'tune'}]});
  });
});

describe('block comments', () => {
  const ts = languageOf('a.ts')!;
  it('are blanked with every newline kept', () => {
    const text = 'a();\n/* one\n   two */ b();\n';
    const blank = blankBlockComments(text, ts);
    expect(blank).toHaveLength(text.length);
    expect(blank.split('\n')).toEqual(['a();', '      ', '          b();', '']);
  });

  it('a comment opener inside a string or after a line comment is text', () => {
    const text = "const glob = 'src/*.ts';\nexport function kept() {}\n// see /* this\nexport function alsoKept() {}\nconst other = 'lib/*/x'; /* real */\n";
    expect(symbols('a.ts', text)).toEqual(['const glob 1', 'fn kept 2 +', 'fn alsoKept 4 +', 'const other 5']);
    expect(blankBlockComments(text, ts)).toContain("'lib/*/x';           ");
  });

  it('an unterminated comment blanks to the end without failing', () => {
    expect(scan('a.ts', 'export const a = 1;\n/* never closed\nexport const b = 2;\n').symbols.map(s => s.name)).toEqual(['a']);
  });

  it('Python docstrings and Ruby =begin blocks are blanked', () => {
    expect(symbols('a.py', 'def a():\n    """\n    def not_a_function():\n    """\n    return 1\n')).toEqual(['fn a 1-5 +']);
    expect(symbols('a.rb', '=begin\ndef hidden\nend\n=end\ndef shown\nend\n')).toEqual(['fn shown 5-6 +']);
  });
});

describe('todos', () => {
  it('finds tags in comments only, once per line, with the text after the tag', () => {
    const text = [
      '// TODO: rotate the signing key',
      'const TODO = 1;',
      "const s = 'FIXME later';",
      '/* HACK(ana): works around #12 */',
      ' * XXX - in a doc block',
      'x(); // TODO TODO twice',
      '// todo: lower case is prose',
    ].join('\n');
    expect(scan('a.ts', text).todos).toEqual([
      {tag: 'TODO', line: 1, text: 'rotate the signing key'},
      {tag: 'HACK', line: 4, text: 'works around #12', owner: 'ana'},
      {tag: 'XXX', line: 5, text: 'in a doc block'},
      {tag: 'TODO', line: 6, text: 'TODO twice'},
    ]);
    expect(scan('a.py', 'x = 1  # FIXME: median of an empty list\n').todos).toEqual([{tag: 'FIXME', line: 1, text: 'median of an empty list'}]);
    expect(scan('a.sql', '-- TODO index\nselect 1;\n').todos).toEqual([{tag: 'TODO', line: 1, text: 'index'}]);
    expect(scan('a.html', '<!-- TODO: alt text -->\n').todos).toEqual([{tag: 'TODO', line: 1, text: 'alt text'}]);
    expect(scan('README.md', '# TODO\n- TODO: write docs\n').todos).toEqual([]);
  });

  // Finding V039: the diff preset's Open TODOs showed '(https://github.com/…/issues/1698): remove once…' as the text.
  it('puts the parenthetical after the tag in owner, however long, and keeps the message as the text', () => {
    const url = 'https://github.com/example-org/example/issues/1698';
    expect(scan('a.ts', `// TODO(${url}): remove once the renderer ships\n`).todos).toEqual([{tag: 'TODO', line: 1, text: 'remove once the renderer ships', owner: url}]);
    expect(scan('a.py', '# FIXME (later) tidy\n').todos).toEqual([{tag: 'FIXME', line: 1, text: '(later) tidy'}]);
    expect(scan('a.ts', '// TODO(): nothing inside\n').todos).toEqual([{tag: 'TODO', line: 1, text: '(): nothing inside'}]);
  });

  it('keeps at most 50 per file', () => {
    expect(scan('a.ts', '// TODO: x\n'.repeat(300)).todos).toHaveLength(50);
  });
});

describe('hostile input', () => {
  it('handles empty files, lone carriage returns and files without a final newline', () => {
    expect(scan('a.ts', '')).toEqual({imports: [], symbols: [], complexity: 0, maxIndent: 0, todos: [], scan: 'ts'});
    expect(scan('a.ts', '\r\n\r\n')).toMatchObject({complexity: 0, symbols: []});
    expect(symbols('a.ts', 'export function a() {\r\n  return 1;\r\n}')).toEqual(['fn a 1-3 +']);
  });

  it('scans a minified-looking file with very long lines quickly and keeps the declarations on short lines', () => {
    const long = `const data = "${'x '.repeat(200_000)}";`;
    const text = `export function before() {}\n${long}\n${'a b '.repeat(100_000)}\nexport function after() {}\n`;
    const started = performance.now();
    const facts = scan('a.ts', text);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(facts.symbols.map(s => s.name)).toEqual(['before', 'data', 'after']);
  });

  it('never throws on token soup, in any language, and what it returns is well formed', () => {
    const words = [
      'import', 'export', 'from', 'class', 'function', 'def', 'fn', 'func', 'pub', 'use', 'mod', 'type', 'interface', 'struct', 'enum', 'const', 'public',
      'static', 'async', 'return', 'if', 'package', 'namespace', 'require', 'include', '#include', 'impl', 'end', 'TODO', 'FIXME', 'Name', 'x', '_y', 'a.b',
      '{', '}', '(', ')', '[', ']', '<', '>', ';', ':', ',', '=', '=>', '->', '::', '.', '*', '/*', '*/', '//', '#', '"""', "'''", '"', "'", '`', '\\', '\n', '\n',
      '\n  ', '\n    ', '\n\t', '\r\n', ' ', ' ', 'é', '\u{1F600}', '\0',
    ];
    let seed = 20261120;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (const path of ['a.ts', 'a.tsx', 'a.py', 'a.go', 'a.rs', 'A.java', 'a.kt', 'a.rb', 'a.cs', 'a.php', 'a.swift', 'a.dart', 'a.c', 'a.ex', 'a.sql', 'a.yaml', 'a.html']) {
      for (let round = 0; round < 40; round++) {
        const text = Array.from({length: 50 + (next() % 400)}, () => words[next() % words.length]).join(next() % 3 === 0 ? '' : ' ');
        const lines = text.split('\n').length;
        const facts = scan(path, text);
        expect(facts.complexity >= 0 && facts.maxIndent >= 0 && facts.maxIndent <= 20, path).toBe(true);
        for (const symbol of facts.symbols) {
          expect(symbol.line >= 1 && symbol.line <= lines && (symbol.endLine ?? symbol.line) >= symbol.line && (symbol.endLine ?? 1) <= lines, `${path} ${symbol.name}`).toBe(true);
          expect(symbol.depth >= 0 && symbol.depth <= 3 && symbol.name.length > 0).toBe(true);
        }
        for (const imported of facts.imports) expect(imported.line >= 1 && imported.line <= lines && imported.spec.length > 0, path).toBe(true);
        for (const todo of facts.todos) expect(todo.line >= 1 && todo.line <= lines && todo.text.length <= 160, path).toBe(true);
      }
    }
  });

  it('stays linear on text built to make the patterns backtrack', () => {
    // Lines just under the length at which they are cut, repeated to about 2 MB: the worst a file can do.
    const fill = (unit: string) => unit.repeat(Math.ceil(940 / unit.length)).slice(0, 940);
    const cases: Array<[string, string]> = [
      ['A.java', `    public ${fill('List<Map<String, Object>> ')}`],
      ['A.java', `    public static final ${fill('a b c d ')}`],
      ['A.cs', `    public ${fill('List<Map<String, Object>> ')}`],
      ['a.dart', `  ${fill('Future<List<int>> ')}(`],
      ['a.ts', `  ${fill('public static async ')}`],
      ['a.ts', `  foo${fill('(a, b) ')}`],
      ['a.ts', `  name: ${fill('x | y ')}`],
      ['a.ts', `import {${fill('a, ')}`],
      ['a.kt', `fun ${fill('A.B<C, D>.')}`],
      ['a.swift', fill('@available(iOS 13, *) ')],
      ['a.rs', `use crate::{${fill('a::b, ')}`],
      ['a.py', `from x import (${fill('a, ')}`],
      ['a.py', `import ${fill('a as b, ')}`],
      ['a.c', `${fill('int ')}(`],
    ];
    for (const [path, line] of cases) {
      const text = `${line}\n`.repeat(2000);
      const started = performance.now();
      scan(path, text);
      expect(performance.now() - started, `${path}: ${line.slice(0, 40)}`).toBeLessThan(1500);
    }
    // and lines past that length are cut before any pattern runs
    const started = performance.now();
    scan('A.java', `    public ${'List<Map<String, Object>> '.repeat(40_000)}\n`.repeat(3));
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe('floods', () => {
  // Each of these made an earlier version of a pattern or a scan quadratic. About 2 MB each, the most a file can be.
  const cases: Array<[string, string, string]> = [
    ['whitespace after import', 'a.ts', `import${'\n'.repeat(1000)}`.repeat(2000)],
    ['comment openers inside one long string', 'a.ts', `const s = "${'/*'.repeat(1_000_000)}";\n`],
    ['comment openers after line comments', 'a.ts', '// /* \n'.repeat(280_000)],
    ['unterminated block comments', 'a.go', '/* a\n'.repeat(400_000)],
    ['Ruby =begin without =end', 'a.rb', '=begin\n'.repeat(280_000)],
    ['triple quotes in comments', 'a.py', '# """\n'.repeat(330_000)],
    ['TODO tags on one comment line', 'a.ts', `// ${'TODO '.repeat(400_000)}\n`],
    ['TODO tags outside comments', 'a.py', `x = "${'TODO '.repeat(400_000)}"\n`],
    ['a staircase of nested declarations', 'a.py', Array.from({length: 4000}, (_, i) => `${' '.repeat(i % 900)}def f${i}():`).join('\n')],
  ];
  it.each(cases)('%s', (_name, path, text) => {
    const started = performance.now();
    const facts = scan(path, text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(facts.todos.length).toBeLessThanOrEqual(50);
    expect(facts.symbols.length).toBeLessThanOrEqual(2000);
  });

  it('still reads what surrounds a flood', () => {
    expect(scan('a.rb', '=begin\ndef hidden\nend\n=end\ndef shown\nend\n=begin\nnever closed\ndef lost\nend\n').symbols.map(s => s.name)).toEqual(['shown']);
    expect(scan('a.ts', `// ${'TODO '.repeat(1000)}\n// FIXME: real\n`).todos).toEqual([{tag: 'TODO', line: 1, text: expect.stringMatching(/^TODO TODO/)}, {tag: 'FIXME', line: 2, text: 'real'}]);
    expect(imports('a.ts', "import\n\n  {a}\n  from\n  './spread';\n")).toEqual(['./spread static 1']);
  });
});

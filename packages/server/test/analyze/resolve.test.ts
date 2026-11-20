// Resolver tables per language, on small in-memory repositories: no disk, no git.
import {describe, expect, it} from 'vitest';
import {scanFile, type ScannedFacts} from '../../src/analyze/facts.ts';
import {isGeneratedPath, isTestPath, languageOf} from '../../src/analyze/languages.ts';
import {readManifests} from '../../src/analyze/manifests.ts';
import {ecosystemOf, resolveImports} from '../../src/analyze/resolve.ts';
import type {FileEntry} from '../../src/contracts.ts';

function resolve(tree: Record<string, string>) {
  const paths = Object.keys(tree).sort();
  const files: FileEntry[] = paths.map(path => ({
    path, lang: languageOf(path)?.name, loc: tree[path]!.split('\n').length, sloc: 1, bytes: tree[path]!.length,
    binary: false, tracked: true, isTest: isTestPath(path), generated: isGeneratedPath(path),
  }));
  const facts = new Map<string, ScannedFacts>();
  for (const path of paths) {
    const language = languageOf(path);
    if (language?.kind === 'code') facts.set(path, scanFile(tree[path]!, language));
  }
  const manifests = readManifests(paths, path => tree[path], 'repo');
  const resolution = resolveImports(files, facts, manifests);
  return {...resolution, lines: resolution.edges.map(edge => `${edge.from} -> ${edge.to} (${edge.kind})`).sort()};
}

describe('TypeScript and JavaScript', () => {
  it('relative paths with extension and index probing, .js specifiers of .ts files, built-ins and packages', () => {
    const {lines, unresolved} = resolve({
      'src/index.ts': "import {a} from './a';\nimport b from './b.js';\nimport {c} from './dir';\nimport './style.css';\nimport data from '../data.json';\nimport fs from 'node:fs';\nimport path from 'path';\nimport React from 'react';\nimport {x} from '@scope/pkg/deep/x';\nimport gone from './missing';\nimport raw from './a?raw';\n",
      'src/a.ts': 'export const a = 1;\n',
      'src/b.tsx': 'export default 1;\n',
      'src/dir/index.ts': 'export const c = 1;\n',
      'src/style.css': '.a {}\n',
      'data.json': '{}\n',
    });
    expect(lines).toEqual([
      'src/index.ts -> data.json (static)',
      'src/index.ts -> ext:@scope/pkg (static)',
      'src/index.ts -> ext:react (static)',
      'src/index.ts -> src/a.ts (static)',
      'src/index.ts -> src/b.tsx (static)',
      'src/index.ts -> src/dir/index.ts (static)',
      'src/index.ts -> src/style.css (static)',
    ]);
    expect(unresolved).toBe(1);
  });

  it('an edge is type-only only while every import behind it is', () => {
    const {lines} = resolve({
      'a.ts': "import type {T} from './t';\nimport type {U} from './u';\nimport {u} from './u';\n",
      't.ts': 'export type T = 1;\n',
      'u.ts': 'export type U = 1;\nexport const u = 1;\n',
    });
    expect(lines).toEqual(['a.ts -> t.ts (type)', 'a.ts -> u.ts (static)']);
  });

  it('tsconfig paths, baseUrl, workspace package names and the @/ convention', () => {
    const {lines} = resolve({
      'tsconfig.json': '{\n  // comments are allowed\n  "compilerOptions": {"baseUrl": ".", "paths": {"@app/*": ["apps/web/src/*"], "config": ["packages/config/index.ts"],},},\n}\n',
      'apps/web/package.json': '{"name": "web"}',
      'apps/web/src/main.ts': "import {util} from '@app/lib/util';\nimport cfg from 'config';\nimport {ui} from '@acme/ui';\nimport {deep} from '@acme/ui/deep/part';\nimport {here} from '@/lib/util';\nimport {base} from 'packages/config/index';\n",
      'apps/web/src/lib/util.ts': 'export const util = 1;\n',
      'packages/config/index.ts': 'export default 1;\n',
      'packages/ui/package.json': '{"name": "@acme/ui", "main": "./dist/index.js", "exports": {".": {"import": "./dist/index.js"}, "./deep/part": "./dist/deep/part.js"}}',
      'packages/ui/src/index.ts': 'export const ui = 1;\n',
      'packages/ui/src/deep/part.ts': 'export const deep = 1;\n',
    });
    expect(lines).toEqual([
      'apps/web/src/main.ts -> apps/web/src/lib/util.ts (static)',
      'apps/web/src/main.ts -> packages/config/index.ts (static)',
      'apps/web/src/main.ts -> packages/ui/src/deep/part.ts (static)',
      'apps/web/src/main.ts -> packages/ui/src/index.ts (static)',
    ]);
  });
});

describe('Python', () => {
  it('relative dots, dotted modules, packages, the standard library and third-party modules', () => {
    const {lines} = resolve({
      'pyproject.toml': '[project]\nname = "tools"\n',
      'tools/__init__.py': '',
      'tools/cli.py': 'import argparse\nfrom pathlib import Path\nfrom tools import util\nfrom tools.report import build\nfrom . import stats\nfrom .sub.deep import thing\nimport requests\nimport tools.report\n',
      'tools/util.py': 'import csv\n',
      'tools/report.py': 'from .util import read\nfrom ..outside import nope\n',
      'tools/stats.py': '',
      'tools/sub/__init__.py': '',
      'tools/sub/deep.py': 'from .. import util\n',
    });
    expect(lines).toEqual([
      'tools/cli.py -> ext:requests (static)',
      'tools/cli.py -> tools/report.py (static)',
      'tools/cli.py -> tools/stats.py (static)',
      'tools/cli.py -> tools/sub/deep.py (static)',
      'tools/cli.py -> tools/util.py (static)',
      'tools/report.py -> tools/util.py (static)',
      'tools/sub/deep.py -> tools/util.py (static)',
    ]);
  });

  it('a one-segment import binds to a sibling or a top-level module, never to an unrelated deep file', () => {
    const {lines} = resolve({
      'app/main.py': 'import helpers\nimport utils\nimport json\n',
      'app/helpers.py': '',
      'vendor_copy/deep/inside/utils.py': '',
      'json.py': '',
    });
    expect(lines).toEqual(['app/main.py -> app/helpers.py (static)', 'app/main.py -> ext:utils (static)']);
  });
});

describe('Go', () => {
  it('module-prefixed imports are package directories; the standard library is dropped; others are named by go.mod', () => {
    const {lines} = resolve({
      'go.mod': 'module example.com/shop\n\ngo 1.23\n\nrequire (\n\tgolang.org/x/time v0.9.0\n\tgithub.com/acme/kit/v2 v2.1.0\n)\n',
      'cmd/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"net/http"\n\t"example.com/shop/internal/limiter"\n\t"example.com/shop"\n\t"golang.org/x/time/rate"\n\t"github.com/acme/kit/v2/log"\n\t"github.com/other/lib/sub/pkg"\n\t"example.com/shop/missing"\n)\n',
      'internal/limiter/limiter.go': 'package limiter\n',
      'root.go': 'package shop\n',
    });
    expect(lines).toEqual([
      'cmd/main.go ->  (package)',
      'cmd/main.go -> ext:github.com/acme/kit/v2 (package)',
      'cmd/main.go -> ext:github.com/other/lib (package)',
      'cmd/main.go -> ext:golang.org/x/time (package)',
      'cmd/main.go -> internal/limiter (package)',
    ]);
  });
});

describe('Rust', () => {
  it('crate::, super::, self::, mod declarations, workspace crates and external crates', () => {
    const {lines} = resolve({
      'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
      'src/main.rs': 'mod parser;\nmod util;\nuse crate::parser::lexer::Token;\nuse util::helper;\nuse std::fmt;\nuse serde::Serialize;\nuse shared_types::Thing;\n',
      'src/parser/mod.rs': 'pub mod lexer;\nuse super::util;\nuse self::lexer::Token;\n',
      'src/parser/lexer.rs': 'use super::super::util::helper;\nuse crate::{util, parser};\n',
      'src/util.rs': '',
      'crates/shared-types/Cargo.toml': '[package]\nname = "shared-types"\nversion = "0.1.0"\n',
      'crates/shared-types/src/lib.rs': '',
    });
    expect(lines).toEqual([
      'src/main.rs -> crates/shared-types/src/lib.rs (static)',
      'src/main.rs -> ext:serde (static)',
      'src/main.rs -> src/parser/lexer.rs (static)',
      'src/main.rs -> src/parser/mod.rs (mod)',
      'src/main.rs -> src/util.rs (mod)',
      'src/parser/lexer.rs -> src/parser/mod.rs (static)',
      'src/parser/lexer.rs -> src/util.rs (static)',
      'src/parser/mod.rs -> src/parser/lexer.rs (mod)',
      'src/parser/mod.rs -> src/util.rs (static)',
    ]);
  });
});

describe('JVM, C#, PHP, Ruby, Swift, Dart, C', () => {
  it('Java and Kotlin: fully-qualified classes, static members, wildcards, the JDK and libraries', () => {
    const {lines} = resolve({
      'src/main/java/com/acme/app/Main.java': 'package com.acme.app;\nimport com.acme.util.Strings;\nimport static com.acme.util.Maths.max;\nimport com.acme.model.*;\nimport java.util.List;\nimport org.springframework.boot.SpringApplication;\nimport com.acme.kt.topLevel;\n',
      'src/main/java/com/acme/util/Strings.java': 'package com.acme.util;\n',
      'src/main/java/com/acme/util/Maths.java': 'package com.acme.util;\n',
      'src/main/java/com/acme/model/User.java': 'package com.acme.model;\n',
      'src/main/kotlin/com/acme/kt/Helpers.kt': 'package com.acme.kt\nfun topLevel() = 1\n',
    });
    expect(lines).toEqual([
      'src/main/java/com/acme/app/Main.java -> ext:org.springframework.boot (static)',
      'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/model (package)',
      'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/util/Maths.java (member)',
      'src/main/java/com/acme/app/Main.java -> src/main/java/com/acme/util/Strings.java (static)',
      'src/main/java/com/acme/app/Main.java -> src/main/kotlin/com/acme/kt/Helpers.kt (static)',
    ]);
  });

  it('C#: namespaces resolve to the directory that declares them', () => {
    const {lines} = resolve({
      'App/Program.cs': 'using System;\nusing System.Linq;\nusing Acme.Core.Models;\nusing Newtonsoft.Json;\nnamespace Acme.App;\n',
      'Core/Models/User.cs': 'namespace Acme.Core.Models\n{\n}\n',
    });
    expect(lines).toEqual(['App/Program.cs -> Core/Models (package)', 'App/Program.cs -> ext:Newtonsoft.Json (package)']);
  });

  it('PHP: namespaced classes and relative includes', () => {
    const {lines} = resolve({
      'src/Http/Kernel.php': "<?php\nnamespace App\\Http;\nuse App\\Models\\User;\nuse Symfony\\Component\\HttpFoundation\\Request;\nuse Exception;\nrequire_once __DIR__ . '/boot.php';\n",
      'src/Models/User.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'src/Http/boot.php': '<?php\n',
    });
    expect(lines).toEqual([
      'src/Http/Kernel.php -> ext:Symfony\\Component (static)',
      'src/Http/Kernel.php -> src/Http/boot.php (relative)',
      'src/Http/Kernel.php -> src/Models/User.php (static)',
    ]);
  });

  it('Ruby: require_relative, lib/ paths, the standard library and gems', () => {
    const {lines} = resolve({
      'lib/shop.rb': "require 'json'\nrequire 'shop/cart'\nrequire_relative 'shop/version'\nrequire 'sinatra/base'\n",
      'lib/shop/cart.rb': '',
      'lib/shop/version.rb': '',
    });
    expect(lines).toEqual(['lib/shop.rb -> ext:sinatra (static)', 'lib/shop.rb -> lib/shop/cart.rb (static)', 'lib/shop.rb -> lib/shop/version.rb (relative)']);
  });

  it('Swift: modules under Sources/, system frameworks and packages', () => {
    const {lines} = resolve({
      'Sources/App/main.swift': 'import Foundation\nimport Core\nimport Alamofire\n',
      'Sources/Core/Model/User.swift': 'import Foundation\n',
    });
    expect(lines).toEqual(['Sources/App/main.swift -> Sources/Core (module)', 'Sources/App/main.swift -> ext:Alamofire (package)']);
  });

  it('Dart: package: imports of local packages, relative imports, the SDK and pub packages', () => {
    const {lines} = resolve({
      'pubspec.yaml': 'name: app\ndependencies:\n  http: ^1.0.0\n',
      'lib/main.dart': "import 'dart:io';\nimport 'package:app/src/a.dart';\nimport 'src/b.dart';\nimport 'package:http/http.dart';\n",
      'lib/src/a.dart': "import 'b.dart';\n",
      'lib/src/b.dart': '',
    });
    expect(lines).toEqual([
      'lib/main.dart -> ext:http (static)', 'lib/main.dart -> lib/src/a.dart (static)', 'lib/main.dart -> lib/src/b.dart (static)', 'lib/src/a.dart -> lib/src/b.dart (static)',
    ]);
  });

  it('C and C++: quoted includes by directory then by path suffix; system headers are dropped', () => {
    const {lines} = resolve({
      'src/main.c': '#include <stdio.h>\n#include "util.h"\n#include "net/http.h"\n#include <project/config.h>\n#include "nowhere.h"\n',
      'src/util.h': '',
      'include/net/http.h': '',
      'include/project/config.h': '',
    });
    expect(lines).toEqual(['src/main.c -> include/net/http.h (relative)', 'src/main.c -> include/project/config.h (system)', 'src/main.c -> src/util.h (relative)']);
  });
});

describe('robustness', () => {
  it('a file never imports itself, duplicates collapse, and files without patterns produce nothing', () => {
    const {edges, imports} = resolve({
      'a.ts': "import {a} from './a';\nimport {b} from './b';\nimport {c} from './b';\n",
      'b.ts': '',
      'lib/app.ex': 'import Foo.Bar\n',
      'notes.md': "import x from 'y'\n",
    });
    expect(edges).toEqual([{from: 'a.ts', to: 'b.ts', kind: 'static'}]);
    expect(imports).toBe(3);
  });

  it('names the ecosystem from the language of the importing file', () => {
    expect([ecosystemOf('TypeScript'), ecosystemOf('Python'), ecosystemOf('Go'), ecosystemOf('Kotlin'), ecosystemOf('C#'), ecosystemOf(undefined), ecosystemOf('Elixir')])
      .toEqual(['npm', 'pypi', 'go', 'maven', 'nuget', 'other', 'other']);
  });
});

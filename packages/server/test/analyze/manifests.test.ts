import {describe, expect, it} from 'vitest';
import {isManifestPath, joinPath, parseJsonc, readManifests} from '../../src/analyze/manifests.ts';

const read = (tree: Record<string, string>) => readManifests(Object.keys(tree), path => tree[path], 'repo');
const summary = (tree: Record<string, string>) => read(tree).packages.map(pkg => `${pkg.ecosystem} ${pkg.name} ${pkg.version || '-'} [${pkg.dir}] ${pkg.deps.join(',')}`);

describe('readManifests', () => {
  it('reads one package per ecosystem with its name, version and dependencies', () => {
    expect(summary({
      'package.json': '{"name": "shop", "version": "0.3.0", "dependencies": {"pg": "^8"}, "devDependencies": {"vitest": "^3"}, "scripts": {"test": "vitest run"}}',
      'py/pyproject.toml': '[project]\nname = "shop-tools"\nversion = "0.3.0"\ndependencies = ["click>=8.1", "rich[jupyter]>=13"]\n[project.optional-dependencies]\ndev = ["pytest"]\n',
      'py/requirements-dev.txt': '# comment\nruff==0.4\n-r other.txt\nmypy>=1\n',
      'rs/Cargo.toml': '[package]\nname = "engine"\nversion = "1.2.0"\n[dependencies]\nserde = "1"\ntokio = {version = "1"}\n[dev-dependencies]\ninsta = "1"\n',
      'go/go.mod': 'module example.com/shop\n\ngo 1.23\n\nrequire golang.org/x/time v0.9.0\n\nrequire (\n\tgithub.com/acme/kit v1.0.0 // indirect\n)\n',
      'dart/pubspec.yaml': 'name: app\nversion: 2.0.0\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.0.0\ndev_dependencies:\n  test: any\n',
      'jvm/pom.xml': '<project><parent><artifactId>parent</artifactId><version>9</version></parent><artifactId>service</artifactId><version>1.0</version><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>',
      'android/build.gradle.kts': 'plugins { id("com.android.application") }\ndependencies {\n    implementation("io.ktor:ktor-server-core:2.3.0")\n    testImplementation("junit:junit:4.13")\n}\n',
      'ruby/Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem \"pg\"\n",
      'ruby/shop.gemspec': "Gem::Specification.new do |s|\n  s.name = 'shop'\n  s.version = '0.1.0'\n  s.add_dependency 'rack'\nend\n",
      'php/composer.json': '{"name": "acme/shop", "require": {"php": ">=8.2", "slim/slim": "^4"}, "scripts": {"test": ["phpunit", "phpstan"]}}',
      'cs/App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.1" /></ItemGroup></Project>',
      'swift/Package.swift': 'let package = Package(\n  name: "Core",\n  dependencies: [.package(url: "https://github.com/apple/swift-collections.git", from: "1.0.0")]\n)\n',
      'deno/deno.jsonc': '{\n  // tasks\n  "name": "@acme/edge",\n  "tasks": {"dev": "deno run main.ts"},\n  "imports": {"hono": "npm:hono@4"},\n}\n',
    })).toEqual([
      'npm shop 0.3.0 [] pg,vitest',
      'gradle android - [android] io.ktor:ktor-server-core,junit:junit,com.android.application',
      'nuget App - [cs] Newtonsoft.Json',
      'pub app 2.0.0 [dart] flutter,http,test',
      'deno @acme/edge - [deno] hono',
      'go example.com/shop - [go] golang.org/x/time,github.com/acme/kit',
      'maven service 1.0 [jvm] org.springframework.boot:spring-boot-starter',
      'composer acme/shop - [php] slim/slim',
      'pypi py (requirements-dev.txt) - [py] ruff,mypy',
      'pypi shop-tools 0.3.0 [py] click,rich,pytest',
      'cargo engine 1.2.0 [rs] serde,tokio,insta',
      'gem ruby (Gemfile) - [ruby] rails,pg',
      'gem shop 0.1.0 [ruby] rack',
      'swiftpm Core - [swift] swift-collections',
    ]);
  });

  it('collects scripts: npm, composer (arrays joined), pyproject entry points, deno tasks and phony make targets', () => {
    const {packages} = read({
      'package.json': '{"name": "shop", "scripts": {"dev": "vite", "build": "tsc -b"}}',
      'composer.json': '{"name": "acme/shop", "scripts": {"test": ["phpunit", "phpstan"]}}',
      'pyproject.toml': '[project]\nname = "tools"\n[project.scripts]\nreport = "tools.cli:main"\n',
      'Makefile': '.PHONY: build test\nCC := gcc\nbuild: main.o\n\tgcc -o app main.o\ntest:\n\t./run-tests\nmain.o: main.c\n\tgcc -c main.c\n',
    });
    expect(packages.flatMap(pkg => pkg.scripts.map(script => `${pkg.name}: ${script.name} = ${script.command}`))).toEqual([
      'acme/shop: test = phpunit && phpstan',
      'repo (Makefile): build = make build',
      'repo (Makefile): test = make test',
      'shop: dev = vite',
      'shop: build = tsc -b',
      'tools: report = tools.cli:main',
    ]);
  });

  it('reads tsconfig paths and baseUrl, keeping the directory the rule belongs to', () => {
    const manifests = read({'web/tsconfig.json': '{"compilerOptions": {"baseUrl": "./src", "paths": {"@/*": ["./*"], "~lib": ["../lib/index.ts"]}}}'});
    expect(manifests.tsBaseUrls).toEqual([{dir: 'web', base: 'web/src'}]);
    expect(manifests.tsPaths).toEqual([
      {dir: 'web', prefix: '@/', wildcard: true, targets: ['web/src/']},
      {dir: 'web', prefix: '~lib', wildcard: false, targets: ['web/lib/index.ts']},
    ]);
  });

  it('skips what does not parse or cannot be read, and says how many', () => {
    const manifests = readManifests(['package.json', 'a/package.json', 'b/pyproject.toml', 'c/package.json', 'd/package.json'], path =>
      ({'package.json': '{not json', 'a/package.json': '[1, 2]', 'b/pyproject.toml': '= = =', 'c/package.json': '{"name": 7, "dependencies": "nope", "scripts": [1]}'} as Record<string, string>)[path], 'repo');
    expect(manifests.packages.map(pkg => `${pkg.name} [${pkg.dir}] ${pkg.deps.length} ${pkg.scripts.length}`)).toEqual(['7 [c] 0 0']);
    expect(manifests.warnings).toEqual(['2 manifests could not be parsed']);
  });

  it('ignores manifests inside dependency, fixture and build directories', () => {
    expect(['node_modules/x/package.json', 'vendor/a/composer.json', 'test/fixtures/app/package.json', 'dist/package.json', 'testdata/go.mod'].filter(isManifestPath)).toEqual([]);
    expect(['package.json', 'apps/web/package.json', 'tsconfig.build.json', 'svc/App.csproj', 'requirements.txt'].every(isManifestPath)).toBe(true);
  });

  it('recognises tooling from paths alone', () => {
    const {tools} = read({'Dockerfile': '', '.github/workflows/ci.yml': '', 'infra/main.tf': '', 'Makefile': '', 'deploy/k8s/app.yaml': '', 'src/a.ts': ''});
    expect(tools).toEqual(['Docker', 'GitHub Actions', 'Terraform', 'Kubernetes', 'Make']);
  });
});

describe('floods', () => {
  // Inputs built to make a pattern quadratic: each must be read, or given up on, quickly.
  const cases: Array<[string, string]> = [
    ['go.mod', `module x\n\nrequire ${'a.'.repeat(1_000_000)}\n`],
    ['build.gradle', `${'\n'.repeat(1_500_000)}implementation 'a:b:1'\n`],
    ['build.gradle.kts', `id${' '.repeat(1_500_000)}x\n`],
    ['pom.xml', '<parent>'.repeat(250_000)],
    ['tsconfig.json', `{${'/*'.repeat(900_000)}`],
    ['tsconfig.json', `{"a": [${'1,'.repeat(400_000)}], // c\n}`],
    ['Gemfile', `${'\n'.repeat(1_500_000)}gem 'x'\n`],
    ['x.gemspec', `add_dependency${' '.repeat(1_500_000)}`],
    ['Makefile', `${'a'.repeat(1_500_000)}\n`],
    ['pyproject.toml', `[project]\nname = "x"\ndependencies = [${'"a",'.repeat(200_000)}]\n`],
    ['pubspec.yaml', `name: x\ndependencies:\n${'  a: 1\n'.repeat(1000)}`],
  ];
  it.each(cases)('%s', (path, text) => {
    const started = performance.now();
    const manifests = readManifests([path], () => text, 'repo');
    expect(performance.now() - started).toBeLessThan(3000);
    expect(manifests.packages.length + manifests.warnings.length).toBeLessThanOrEqual(1);
  });
});

describe('helpers', () => {
  it('joinPath resolves dots and refuses to leave the root', () => {
    expect(joinPath('src/api', '../lib/x')).toBe('src/lib/x');
    expect(joinPath('', './a/./b')).toBe('a/b');
    expect(joinPath('src', '.')).toBe('src');
    expect(joinPath('src', '../..')).toBeUndefined();
  });

  it('parseJsonc accepts comments and trailing commas, and keeps comment-like text inside strings', () => {
    expect(parseJsonc('{\n  // line\n  "a": "http://x/*y*/", /* block */\n  "b": [1, 2,],\n}')).toEqual({a: 'http://x/*y*/', b: [1, 2]});
    expect(parseJsonc('{"a": ",}", "b": "\\"//x", /* c */ "c": [/* d */],}')).toEqual({a: ',}', b: '"//x', c: []});
    expect(() => parseJsonc('{nope')).toThrow();
    expect(() => parseJsonc('{"a": "unterminated')).toThrow();
    expect(() => parseJsonc('{"a": 1 /* never closed')).toThrow();
  });
});

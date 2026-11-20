// Package manifests across ecosystems, read by well-known file name. Parsing is forgiving: a manifest that does not
// parse is skipped and reported, never thrown.
import {parse as parseToml} from 'smol-toml';
import {parse as parseYaml} from 'yaml';
import {baseName, dirName} from './languages.ts';

export interface PackageInfo {
  ecosystem: 'npm' | 'pypi' | 'go' | 'cargo' | 'pub' | 'maven' | 'gradle' | 'gem' | 'composer' | 'nuget' | 'swiftpm' | 'deno' | 'make';
  /** Repo-relative path of the manifest file. */
  manifest: string;
  /** Directory of the manifest; '' for the repository root. */
  dir: string;
  name: string;
  version: string;
  /** Declared dependency names, all kinds. */
  deps: string[];
  scripts: Array<{name: string; command: string}>;
  /** package.json entry fields, for resolving imports of workspace packages. */
  entry?: {main?: string; module?: string; source?: string; types?: string; exports?: unknown};
}
export interface TsPathRule {
  /** Directory of the tsconfig: the rule applies to files beneath it. */
  dir: string;
  prefix: string;
  wildcard: boolean;
  /** Repo-relative replacements for the prefix; a wildcard rule appends the rest of the specifier to each. */
  targets: string[];
}
export interface Manifests {
  packages: PackageInfo[];
  tsPaths: TsPathRule[];
  /** tsconfig `baseUrl` directories: bare specifiers may resolve against them. */
  tsBaseUrls: Array<{dir: string; base: string}>;
  /** Tooling recognised from file paths alone (CI, containers, infrastructure). */
  tools: string[];
  warnings: string[];
}

const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|testdata|fixtures?|__fixtures__|dist|build)\//;
const MAX_MANIFESTS = 2000;
const MAX_SCRIPTS = 60;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const keys = (value: unknown): string[] => (isObject(value) ? Object.keys(value) : []);

/** Repo-relative join with `.` and `..` resolved; '' is the root. Returns undefined when the result leaves the root. */
export function joinPath(dir: string, rel: string): string | undefined {
  const out: string[] = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

/** JSON with comments and trailing commas (tsconfig, deno.jsonc). One pass, so no input can make it slow. */
export function parseJsonc(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    // not plain JSON: strip comments and trailing commas below
  }
  const out: string[] = [];
  // Index in `out` of a comma that is trailing if the next significant character closes a bracket.
  let comma = -1;
  const n = source.length;
  for (let i = 0; i < n; ) {
    const ch = source[i]!;
    if (ch === '"') {
      let end = i + 1;
      while (end < n && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      out.push(source.slice(i, end + 1));
      comma = -1;
      i = end + 1;
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      if (ch === ',') comma = out.length;
      else if (ch === '}' || ch === ']') {
        if (comma !== -1) out[comma] = '';
        comma = -1;
      } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') comma = -1;
      out.push(ch);
      i++;
    }
  }
  return JSON.parse(out.join(''));
}

const requirementName = (line: string): string => line.split(/[\s<>=!~;[(@]/)[0] ?? '';

function scriptsOf(value: unknown): PackageInfo['scripts'] {
  if (!isObject(value)) return [];
  return Object.entries(value).filter(([, command]) => typeof command === 'string' || Array.isArray(command)).slice(0, MAX_SCRIPTS)
    .map(([name, command]) => ({name, command: Array.isArray(command) ? command.map(text).join(' && ') : text(command)}));
}

type Reader = (path: string) => string | undefined;

function readOne(path: string, source: string, repoName: string, out: Manifests): void {
  const base = baseName(path);
  const dir = dirName(path);
  const dirLabel = dir ? baseName(dir) : repoName;
  const add = (pkg: Omit<PackageInfo, 'manifest' | 'dir'>) => out.packages.push({...pkg, manifest: path, dir});

  if (base === 'package.json') {
    const json = JSON.parse(source) as unknown;
    if (!isObject(json)) return;
    const deps = [...keys(json.dependencies), ...keys(json.devDependencies), ...keys(json.peerDependencies), ...keys(json.optionalDependencies)];
    add({
      ecosystem: 'npm', name: text(json.name) || dirLabel, version: text(json.version), deps: [...new Set(deps)], scripts: scriptsOf(json.scripts),
      entry: {main: text(json.main) || undefined, module: text(json.module) || undefined, source: text(json.source) || undefined, types: text(json.types) || undefined, exports: json.exports},
    });
  } else if (base === 'deno.json' || base === 'deno.jsonc') {
    const json = parseJsonc(source);
    if (!isObject(json)) return;
    add({ecosystem: 'deno', name: text(json.name) || dirLabel, version: text(json.version), deps: keys(json.imports), scripts: scriptsOf(json.tasks)});
  } else if (/^tsconfig.*\.json$/.test(base) || base === 'jsconfig.json') {
    const json = parseJsonc(source);
    const options = isObject(json) && isObject(json.compilerOptions) ? json.compilerOptions : undefined;
    if (!options) return;
    const baseUrl = typeof options.baseUrl === 'string' ? joinPath(dir, options.baseUrl) : undefined;
    if (baseUrl !== undefined) out.tsBaseUrls.push({dir, base: baseUrl});
    if (!isObject(options.paths)) return;
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets)) continue;
      const resolved: string[] = [];
      for (const target of targets) {
        if (typeof target !== 'string') continue;
        const stem = target.replace(/\*$/, '');
        const joined = joinPath(baseUrl ?? dir, stem);
        // Keep the trailing slash of 'src/*' so the rest of the specifier can simply be appended.
        if (joined !== undefined) resolved.push(joined && (stem.endsWith('/') || stem === '') ? `${joined}/` : joined);
      }
      out.tsPaths.push({dir, prefix: pattern.replace(/\*$/, ''), wildcard: pattern.endsWith('*'), targets: resolved});
    }
  } else if (base === 'pyproject.toml') {
    const toml = parseToml(source) as Json;
    const tool = isObject(toml.tool) ? toml.tool : {};
    const poetry = isObject(tool.poetry) ? tool.poetry : undefined;
    const project = isObject(toml.project) ? toml.project : poetry;
    if (!project) return;
    const declared = Array.isArray(project.dependencies) ? project.dependencies.map(text).map(requirementName) : keys(project.dependencies);
    const optional = isObject(project['optional-dependencies']) ? Object.values(project['optional-dependencies']) : [];
    const groups = isObject(toml['dependency-groups']) ? Object.values(toml['dependency-groups']) : [];
    for (const group of [...optional, ...groups]) if (Array.isArray(group)) for (const item of group) if (typeof item === 'string') declared.push(requirementName(item));
    add({
      ecosystem: 'pypi', name: text(project.name) || dirLabel, version: text(project.version),
      deps: [...new Set(declared.filter(name => name && name !== 'python'))], scripts: scriptsOf(project.scripts),
    });
  } else if (/^requirements[\w.-]*\.txt$/.test(base)) {
    const deps = source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('-')).map(requirementName).filter(Boolean);
    add({ecosystem: 'pypi', name: `${dirLabel} (${base})`, version: '', deps: [...new Set(deps)], scripts: []});
  } else if (base === 'Cargo.toml') {
    const toml = parseToml(source) as Json;
    if (!isObject(toml.package)) return;
    const deps = [...keys(toml.dependencies), ...keys(toml['dev-dependencies']), ...keys(toml['build-dependencies'])];
    add({ecosystem: 'cargo', name: text(toml.package.name) || dirLabel, version: text(toml.package.version), deps: [...new Set(deps)], scripts: []});
  } else if (base === 'go.mod') {
    const deps = [...source.matchAll(/^[ \t]*(?:require[ \t]+)?([\w.-]+(?:\/[\w.~-]+)*)[ \t]+v[\w.+-]+/gm)].map(m => m[1]!).filter(name => name.split('/')[0]!.includes('.'));
    add({ecosystem: 'go', name: /^module\s+(\S+)/m.exec(source)?.[1] ?? dirLabel, version: '', deps: [...new Set(deps)], scripts: []});
  } else if (base === 'pubspec.yaml') {
    const yaml = parseYaml(source) as unknown;
    if (!isObject(yaml)) return;
    add({ecosystem: 'pub', name: text(yaml.name) || dirLabel, version: text(yaml.version), deps: [...keys(yaml.dependencies), ...keys(yaml.dev_dependencies)], scripts: []});
  } else if (base === 'pom.xml') {
    const deps = [...source.matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)].map(m => `${m[1]}:${m[2]}`);
    // The project's own coordinates: what precedes the dependencies, without the <parent> block.
    const parentAt = source.indexOf('<parent>');
    const parentEnd = parentAt === -1 ? -1 : source.indexOf('</parent>', parentAt);
    const body = parentEnd === -1 ? source : source.slice(0, parentAt) + source.slice(parentEnd + 9);
    const depsAt = body.indexOf('<dependenc');
    const head = depsAt === -1 ? body : body.slice(0, depsAt);
    add({ecosystem: 'maven', name: /<artifactId>([^<]+)</.exec(head)?.[1] ?? dirLabel, version: /<version>([^<]+)</.exec(head)?.[1] ?? '', deps: [...new Set(deps)], scripts: []});
  } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
    const deps = [...source.matchAll(/^[ \t]*(?:implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|kapt|ksp|classpath)[ \t]{0,8}\(?[ \t]{0,8}(?:platform\()?["']([^"'\n]+)["']/gm)]
      .map(m => m[1]!.split(':').slice(0, 2).join(':'));
    const plugins = [...source.matchAll(/\bid[ \t]{0,8}\(?[ \t]{0,8}["']([\w.-]+)["']/g)].map(m => m[1]!);
    add({ecosystem: 'gradle', name: dirLabel, version: '', deps: [...new Set([...deps, ...plugins])], scripts: []});
  } else if (base === 'Gemfile') {
    const deps = [...source.matchAll(/^[ \t]*gem[ \t]+['"]([^'"\n]+)['"]/gm)].map(m => m[1]!);
    add({ecosystem: 'gem', name: `${dirLabel} (Gemfile)`, version: '', deps: [...new Set(deps)], scripts: []});
  } else if (base.endsWith('.gemspec')) {
    const deps = [...source.matchAll(/add_(?:development_|runtime_)?dependency[ \t]{0,8}\(?[ \t]{0,8}['"]([^'"\n]+)['"]/g)].map(m => m[1]!);
    add({ecosystem: 'gem', name: /\.name\s*=\s*['"]([^'"\n]+)/.exec(source)?.[1] ?? base.replace(/\.gemspec$/, ''), version: /\.version\s*=\s*['"]([^'"\n]+)/.exec(source)?.[1] ?? '', deps: [...new Set(deps)], scripts: []});
  } else if (base === 'composer.json') {
    const json = JSON.parse(source) as unknown;
    if (!isObject(json)) return;
    add({ecosystem: 'composer', name: text(json.name) || dirLabel, version: text(json.version), deps: [...keys(json.require), ...keys(json['require-dev'])].filter(name => name !== 'php'), scripts: scriptsOf(json.scripts)});
  } else if (/\.(cs|fs|vb)proj$/.test(base)) {
    const deps = [...source.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map(m => m[1]!);
    add({ecosystem: 'nuget', name: base.replace(/\.\w+$/, ''), version: /<Version>([^<]+)</.exec(source)?.[1] ?? '', deps: [...new Set(deps)], scripts: []});
  } else if (base === 'Package.swift') {
    const deps = [...source.matchAll(/\.package\(\s*(?:name:\s*"[^"\n]+",\s*)?(?:url|path):\s*"([^"\n]+)"/g)].map(m => baseName(m[1]!.replace(/\.git$/, '').replace(/\/$/, '')));
    add({ecosystem: 'swiftpm', name: /Package\(\s*name:\s*"([^"\n]+)"/.exec(source)?.[1] ?? dirLabel, version: '', deps: [...new Set(deps)], scripts: []});
  } else if (base === 'Makefile' || base === 'makefile' || base === 'GNUmakefile') {
    const phony = new Set([...source.matchAll(/^\.PHONY:[ \t]*([^\n]+)/gm)].flatMap(m => m[1]!.trim().split(/\s+/)));
    const targets = [...source.matchAll(/^([A-Za-z0-9][\w.-]*):(?!=)/gm)].map(m => m[1]!);
    const names = [...new Set(targets)].filter(name => phony.size === 0 || phony.has(name)).slice(0, MAX_SCRIPTS);
    if (names.length > 0) add({ecosystem: 'make', name: `${dirLabel} (${base})`, version: '', deps: [], scripts: names.map(name => ({name, command: `make ${name}`}))});
  }
}

const MANIFEST_NAME = /^(package\.json|deno\.jsonc?|tsconfig.*\.json|jsconfig\.json|pyproject\.toml|requirements[\w.-]*\.txt|Cargo\.toml|go\.mod|pubspec\.yaml|pom\.xml|build\.gradle(\.kts)?|Gemfile|.+\.gemspec|composer\.json|.+\.(cs|fs|vb)proj|Package\.swift|Makefile|makefile|GNUmakefile)$/;

const TOOL_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)(Dockerfile(\.[^/]+)?|Containerfile|[^/]+\.dockerfile)$/i, 'Docker'],
  [/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/, 'Docker Compose'],
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, 'GitHub Actions'],
  [/^\.gitlab-ci\.yml$/, 'GitLab CI'],
  [/^\.circleci\/config\.yml$/, 'CircleCI'],
  [/(^|\/)Jenkinsfile$/, 'Jenkins'],
  [/^azure-pipelines\.yml$/, 'Azure Pipelines'],
  [/\.tf$/, 'Terraform'],
  [/(^|\/)Chart\.yaml$/, 'Helm'],
  [/(^|\/)(k8s|kubernetes)\/.*\.ya?ml$/, 'Kubernetes'],
  [/(^|\/)(WORKSPACE(\.bazel)?|MODULE\.bazel|BUILD\.bazel)$/, 'Bazel'],
  [/(^|\/)flake\.nix$/, 'Nix'],
  [/(^|\/)(Makefile|GNUmakefile)$/, 'Make'],
  [/(^|\/)CMakeLists\.txt$/, 'CMake'],
  [/(^|\/)(turbo|nx)\.json$/, 'Monorepo tooling'],
  [/(^|\/)pnpm-workspace\.yaml$/, 'pnpm'],
  [/(^|\/)\.pre-commit-config\.yaml$/, 'pre-commit'],
];

/** True for a path readManifests would read: lets the caller know which files matter. */
export function isManifestPath(path: string): boolean {
  return MANIFEST_NAME.test(baseName(path)) && !SKIP_DIR.test(path);
}

/**
 * Reads every manifest among `paths`. `read` returns the file text, or undefined when it cannot be read; it is only
 * called with paths from `paths`.
 */
export function readManifests(paths: readonly string[], read: Reader, repoName: string): Manifests {
  const out: Manifests = {packages: [], tsPaths: [], tsBaseUrls: [], tools: [], warnings: []};
  const tools = new Set<string>();
  let failed = 0;
  let seen = 0;
  for (const path of paths) {
    for (const [pattern, tool] of TOOL_PATHS) if (!tools.has(tool) && pattern.test(path)) tools.add(tool);
    if (!isManifestPath(path) || seen >= MAX_MANIFESTS) continue;
    seen++;
    const source = read(path);
    if (source === undefined) continue;
    try {
      readOne(path, source, repoName, out);
    } catch {
      failed++;
    }
  }
  out.tools = TOOL_PATHS.map(([, tool]) => tool).filter((tool, index, all) => tools.has(tool) && all.indexOf(tool) === index);
  if (failed > 0) out.warnings.push(`${failed} manifest${failed === 1 ? '' : 's'} could not be parsed`);
  // Root first, then by directory and name, so tables read top-down.
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  out.packages.sort((a, b) => order(a.dir, b.dir) || order(a.name, b.name));
  return out;
}

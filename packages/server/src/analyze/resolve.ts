// Import resolution, in memory: every specifier found by the scanner is matched against the set of repository paths
// and the indexes built from manifests and package declarations. No file is opened here.
import type {FileEntry, ImportEdge} from '../contracts.ts';
import type {ScannedFacts, ScannedImport} from './facts.ts';
import {baseName, dirName} from './languages.ts';
import {joinPath, type Manifests, type PackageInfo} from './manifests.ts';

export interface Resolution {
  /**
   * One edge per (from, to). `to` is a file, 'ext:<package>', or a directory when `kind` is 'package' (the import
   * names a whole package: Go, C#, JVM wildcards) or 'module' (a whole tree: Swift modules).
   */
  edges: ImportEdge[];
  /** Imports seen, standard-library ones included. */
  imports: number;
  /** Imports that look internal but match no file. */
  unresolved: number;
}

type Target = {file: string} | {dir: string; recursive?: boolean} | {ext: string} | 'builtin' | 'unresolved' | 'skip';

const NODE_BUILTINS = new Set(
  ('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https ' +
    'inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty ' +
    'url util v8 vm wasi worker_threads zlib test sqlite').split(' '),
);
const PYTHON_STDLIB = new Set(
  ('__future__ abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 calendar cmath cmd code codecs collections colorsys ' +
    'compileall concurrent configparser contextlib contextvars copy copyreg cProfile csv ctypes curses dataclasses datetime dbm decimal difflib dis ' +
    'doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob ' +
    'graphlib grp gzip hashlib heapq hmac html http idlelib imaplib importlib inspect io ipaddress itertools json keyword linecache locale logging ' +
    'lzma mailbox marshal math mimetypes mmap modulefinder multiprocessing netrc numbers operator optparse os pathlib pdb pickle pickletools pkgutil ' +
    'platform plistlib poplib posix pprint profile pstats pty pwd py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter ' +
    'runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep ' +
    'struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib ' +
    'trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref ' +
    'xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread typing_extensions').split(' '),
);
const RUBY_STDLIB = new Set(
  ('abbrev base64 benchmark bigdecimal bundler cgi coverage csv date delegate digest drb English erb etc fcntl fiddle fileutils find forwardable ' +
    'getoptlong io ipaddr irb json logger matrix minitest monitor net nkf objspace observer open3 open-uri openssl optparse ostruct pathname pp ' +
    'prettyprint prime pstore psych racc rake rbconfig rdoc readline reline resolv ripper rubygems securerandom set shellwords singleton socket ' +
    'stringio strscan syslog tempfile test time timeout tmpdir tsort un uri weakref yaml zlib').split(' '),
);
const SWIFT_SYSTEM = new Set(
  ('Foundation SwiftUI UIKit AppKit Combine XCTest Testing Swift Dispatch os OSLog CoreGraphics CoreData CoreLocation CoreImage CoreText CoreMedia ' +
    'CoreVideo CoreAudio CoreBluetooth CoreML Observation MapKit AVFoundation AVKit WebKit StoreKit CryptoKit Network Security SwiftData Charts ' +
    'Darwin Glibc Accelerate Metal MetalKit SpriteKit SceneKit ARKit RealityKit Vision NaturalLanguage PhotosUI Photos UserNotifications WidgetKit ' +
    'QuartzCore Cocoa WatchKit CloudKit GameKit HealthKit Intents PDFKit SafariServices AuthenticationServices LocalAuthentication SystemConfiguration ' +
    'UniformTypeIdentifiers RegexBuilder _Concurrency Synchronization Distributed PackageDescription PackagePlugin').split(' '),
);
const JVM_BUILTIN = /^(java|javax|jdk|sun|kotlin|scala)\./;
const JVM_TLD = new Set(['com', 'org', 'io', 'net', 'dev', 'app', 'me', 'co', 'edu', 'gov', 'de', 'uk', 'fr']);
const GO_HOSTED = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'golang.org', 'google.golang.org', 'gopkg.in', 'k8s.io', 'sigs.k8s.io', 'go.uber.org']);
const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.vue', '.svelte', '.astro'];

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** The candidate sharing the longest path prefix with the importer; ties go to the shortest, then the first by name. */
function closest(candidates: readonly string[], from: string): string {
  let best = candidates[0]!;
  let bestShared = -1;
  for (const candidate of candidates) {
    let shared = 0;
    const limit = Math.min(candidate.length, from.length);
    while (shared < limit && candidate.charCodeAt(shared) === from.charCodeAt(shared)) shared++;
    if (shared > bestShared || (shared === bestShared && (candidate.length < best.length || (candidate.length === best.length && candidate < best)))) {
      best = candidate;
      bestShared = shared;
    }
  }
  return best;
}

const under = (path: string, dir: string) => dir === '' || path === dir || path.startsWith(dir + '/');
/** A Python distribution or module name as PEP 503 compares them: lower case, runs of '-', '_' and '.' as one '_'. */
const pyName = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '_');

/** How binding an import is: erased types, then lazy `import()`, then everything that runs when the file loads. */
const strength = (kind: string): number => (kind === 'type' ? 0 : kind === 'dynamic' ? 1 : 2);

export function resolveImports(files: readonly FileEntry[], facts: ReadonlyMap<string, ScannedFacts>, manifests: Manifests): Resolution {
  const fileSet = new Set<string>();
  const dirSet = new Set<string>(['']);
  for (const file of files) {
    fileSet.add(file.path);
    for (let dir = dirName(file.path); dir !== '' && !dirSet.has(dir); dir = dirName(dir)) dirSet.add(dir);
  }

  // ---- indexes from manifests
  const npmByName = new Map<string, PackageInfo>();
  const dartByName = new Map<string, string>();
  const crates = new Map<string, string>();
  const goModules: Array<{module: string; dir: string; requires: string[]}> = [];
  const pythonRoots = new Set<string>(['', 'src']);
  const npmDirs: string[] = [];
  for (const pkg of manifests.packages) {
    if (pkg.ecosystem === 'npm') {
      if (!npmByName.has(pkg.name)) npmByName.set(pkg.name, pkg);
      npmDirs.push(pkg.dir);
    } else if (pkg.ecosystem === 'pub') dartByName.set(pkg.name, pkg.dir);
    else if (pkg.ecosystem === 'cargo') crates.set(pkg.name.replace(/-/g, '_'), pkg.dir);
    else if (pkg.ecosystem === 'go') goModules.push({module: pkg.name, dir: pkg.dir, requires: [...pkg.deps].sort((a, b) => b.length - a.length)});
    else if (pkg.ecosystem === 'pypi') {
      pythonRoots.add(pkg.dir);
      pythonRoots.add(pkg.dir ? `${pkg.dir}/src` : 'src');
    }
  }
  goModules.sort((a, b) => b.module.length - a.module.length);
  npmDirs.sort((a, b) => b.length - a.length);

  // ---- indexes from the scanned files
  const pyIndex = new Map<string, string[]>();
  const classIndex = new Map<string, string[]>();
  const namespaceFiles = new Map<string, string[]>();
  const rubyLib = new Map<string, string[]>();
  // Swift modules are imported by target name. Package.swift names them (its `path:` may be a folder of another name,
  // and two targets may share a folder name); the folder after Sources/ or Tests/ is the fallback for the rest.
  const swiftModules = new Map<string, string>();
  const swiftDirs = new Set<string>();
  for (const pkg of manifests.packages) {
    for (const target of pkg.targets ?? []) {
      if (swiftModules.has(target.name) || !dirSet.has(target.dir)) continue;
      swiftModules.set(target.name, target.dir);
      swiftDirs.add(target.dir);
    }
  }
  const headerIndex = new Map<string, string[]>();
  for (const [path, fact] of facts) {
    const stem = baseName(path).replace(/\.[^.]+$/, '');
    switch (fact.scan) {
      case 'py': {
        const parts = path.replace(/\.pyi?$/, '').split('/');
        if (parts.at(-1) === '__init__') parts.pop();
        for (let i = parts.length - 1; i >= 0 && parts.length - i <= 8; i--) pushTo(pyIndex, parts.slice(i).join('.'), path);
        break;
      }
      case 'java': case 'kt': {
        const pkg = fact.pkg ?? '';
        pushTo(classIndex, pkg ? `${pkg}.${stem}` : stem, path);
        if (fact.scan === 'kt') for (const symbol of fact.symbols) if (symbol.depth === 0) pushTo(classIndex, pkg ? `${pkg}.${symbol.name}` : symbol.name, path);
        pushTo(namespaceFiles, `jvm:${pkg}`, path);
        break;
      }
      case 'cs':
        if (fact.pkg) pushTo(namespaceFiles, `cs:${fact.pkg}`, path);
        break;
      case 'php':
        pushTo(classIndex, `php:${fact.pkg ? `${fact.pkg}\\` : ''}${stem}`, path);
        break;
      case 'rb': {
        const lib = path.lastIndexOf('lib/');
        if (lib !== -1 && (lib === 0 || path[lib - 1] === '/')) pushTo(rubyLib, path.slice(lib + 4).replace(/\.rb$/, ''), path);
        break;
      }
      case 'swift': {
        const m = /(?:^|\/)(?:Sources|Tests)\/([^/]+)\//.exec(path);
        const dir = m ? path.slice(0, m.index + m[0].length - 1) : undefined;
        if (m && dir !== undefined && !swiftModules.has(m[1]!) && !swiftDirs.has(dir)) swiftModules.set(m[1]!, dir);
        break;
      }
      case 'c': {
        const parts = path.split('/');
        for (let i = parts.length - 1; i >= 0 && parts.length - i <= 4; i--) pushTo(headerIndex, parts.slice(i).join('/'), path);
        break;
      }
      default:
    }
  }

  // ---- TypeScript / JavaScript
  const probeTs = (path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    if (fileSet.has(path)) return path;
    for (const ext of TS_EXTENSIONS) if (fileSet.has(path + ext)) return path + ext;
    const js = /\.([mc]?)jsx?$/.exec(path);
    if (js) {
      const stem = path.slice(0, -js[0].length);
      for (const ext of [`.${js[1]}ts`, '.tsx', '.ts', '.d.ts']) if (fileSet.has(stem + ext)) return stem + ext;
    }
    if (dirSet.has(path)) for (const ext of TS_EXTENSIONS) if (fileSet.has(`${path}/index${ext}`)) return `${path}/index${ext}`;
    return undefined;
  };
  const sourceTwin = (target: string) => target.replace(/^(\.\/)?(dist|lib|build|out)\//, 'src/').replace(/\.d\.ts$|\.[mc]?js$/, '');
  const exportTarget = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value;
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    return exportTarget(record.source) ?? exportTarget(record.import) ?? exportTarget(record.default) ?? exportTarget(record.types);
  };
  const npmEntry = (pkg: PackageInfo, sub: string): string | undefined => {
    const exports = typeof pkg.entry?.exports === 'object' && pkg.entry.exports !== null ? (pkg.entry.exports as Record<string, unknown>) : undefined;
    if (sub) {
      const direct = probeTs(joinPath(pkg.dir, sub)) ?? probeTs(joinPath(pkg.dir, `src/${sub}`));
      if (direct) return direct;
      const target = exportTarget(exports?.[`./${sub}`]);
      return target ? (probeTs(joinPath(pkg.dir, target)) ?? probeTs(joinPath(pkg.dir, sourceTwin(target)))) : undefined;
    }
    const rootExport = typeof pkg.entry?.exports === 'string' ? pkg.entry.exports : exportTarget(exports?.['.']);
    for (const candidate of [pkg.entry?.source, rootExport, pkg.entry?.module, pkg.entry?.main, pkg.entry?.types]) {
      if (!candidate) continue;
      const hit = probeTs(joinPath(pkg.dir, candidate)) ?? probeTs(joinPath(pkg.dir, sourceTwin(candidate)));
      if (hit) return hit;
    }
    return probeTs(joinPath(pkg.dir, 'src/index')) ?? probeTs(joinPath(pkg.dir, 'index'));
  };
  const resolveTs = (from: string, raw: string): Target => {
    const spec = raw.replace(/[?#].*$/, '');
    const dir = dirName(from);
    if (spec.startsWith('.')) {
      const hit = probeTs(joinPath(dir, spec));
      return hit ? {file: hit} : 'unresolved';
    }
    if (/^(node|bun|deno|cloudflare|astro|virtual):/.test(spec) || NODE_BUILTINS.has(spec.split('/')[0]!)) return 'builtin';
    if (/^(https?|data|file):/.test(spec)) return 'skip';
    for (const rule of manifests.tsPaths) {
      if (!under(from, rule.dir) || !(rule.wildcard ? spec.startsWith(rule.prefix) : spec === rule.prefix)) continue;
      for (const target of rule.targets) {
        const hit = probeTs(rule.wildcard ? target + spec.slice(rule.prefix.length) : target.replace(/\/$/, ''));
        if (hit) return {file: hit};
      }
    }
    const bare = spec.replace(/^npm:/, '');
    const parts = bare.split('/');
    const scoped = bare.startsWith('@') && parts.length > 1;
    const name = scoped ? `${parts[0]}/${parts[1]!.replace(/@[^/]*$/, '')}` : parts[0]!.replace(/(?!^)@.*$/, '');
    const workspace = npmByName.get(name);
    if (workspace) {
      const hit = npmEntry(workspace, parts.slice(scoped ? 2 : 1).join('/'));
      return hit ? {file: hit} : {dir: workspace.dir};
    }
    if (/^[@~]\//.test(spec)) {
      const home = npmDirs.find(pkgDir => under(from, pkgDir)) ?? '';
      const hit = probeTs(joinPath(home, `src/${spec.slice(2)}`)) ?? probeTs(joinPath(home, spec.slice(2)));
      return hit ? {file: hit} : 'unresolved';
    }
    for (const base of manifests.tsBaseUrls) {
      if (!under(from, base.dir)) continue;
      const hit = probeTs(joinPath(base.base, spec));
      if (hit) return {file: hit};
    }
    if (/^[/#$~]/.test(spec) || !/^[@\w]/.test(name)) return 'unresolved';
    return {ext: name};
  };

  // ---- Python
  const isPackageDir = (dir: string) => fileSet.has(dir ? `${dir}/__init__.py` : '__init__.py');
  /** Import names of the dependencies the Python manifests at or above a directory declare (PEP 503 normalized). */
  const pyDeclared: Array<{dir: string; names: ReadonlySet<string>}> = manifests.packages
    .filter(pkg => pkg.ecosystem === 'pypi')
    .map(pkg => ({dir: pkg.dir, names: new Set(pkg.deps.map(pyName))}));
  const declaredAbove = (from: string, top: string): boolean => pyDeclared.some(declared => under(from, declared.dir) && declared.names.has(pyName(top)));
  /**
   * Directory an absolute import of `module` must start from to reach `pick`: the pick's module path without the
   * module's own segments ('a2a' -> '.../src/a2ui/a2a/__init__.py' starts from '.../src/a2ui').
   */
  const anchorOf = (pick: string, module: string): string => {
    const parts = pick.replace(/\.pyi?$/, '').split('/');
    if (parts.at(-1) === '__init__') parts.pop();
    return parts.slice(0, Math.max(0, parts.length - module.split('.').length)).join('/');
  };
  /**
   * Whether `import <module>` in `from` can reach `pick` in Python 3, where there are no implicit relative imports:
   * the module's first segment must sit in a directory on the import path. That is a declared Python root (a manifest
   * directory or its src/), the importer's own directory (a script's directory is on the path), or, for a dotted name,
   * any directory that is not itself a package. The importer's own package and its ancestors are never reached this
   * way: inside a2ui/a2a/, `a2a` is the external `a2a` and the package itself is `a2ui.a2a` (V025).
   *
   * When the importer's directory is a package (it has an __init__.py), a script run from it still imports its sibling
   * module files by their bare names (`from engine import X` next to engine.py), unless the name is a dependency a
   * manifest above declares; a sibling package there is taken for the external package of that name, as above.
   */
  const reachable = (from: string, pick: string, module: string): boolean => {
    const anchor = anchorOf(pick, module);
    if (pythonRoots.has(anchor)) return true;
    const dir = dirName(from);
    if (anchor === dir) {
      if (!isPackageDir(dir)) return true;
      return !module.includes('.') && baseName(pick) !== '__init__.py' && !declaredAbove(from, module);
    }
    return module.includes('.') && !isPackageDir(anchor);
  };
  const resolvePy = (from: string, imp: ScannedImport): Target => {
    const spec = imp.spec;
    const dir = dirName(from);
    const moduleFile = (base: string | undefined): string | undefined => {
      if (base === undefined) return undefined;
      if (fileSet.has(`${base}.py`)) return `${base}.py`;
      if (fileSet.has(`${base}.pyi`)) return `${base}.pyi`;
      if (fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
      return undefined;
    };
    if (spec.startsWith('.')) {
      const dots = /^\.+/.exec(spec)![0].length;
      let base: string | undefined = dir;
      for (let i = 1; i < dots && base !== undefined; i++) base = base === '' ? undefined : dirName(base);
      if (base === undefined) return 'unresolved';
      const rest = spec.slice(dots).replace(/\./g, '/');
      for (const name of imp.names ?? []) {
        const hit = moduleFile(joinPath(base, rest ? `${rest}/${name}` : name));
        if (hit) return {file: hit};
      }
      const hit = rest ? moduleFile(joinPath(base, rest)) : moduleFile(base);
      return hit ? {file: hit} : 'unresolved';
    }
    const top = spec.split('.')[0]!;
    // A one-segment name the standard library owns is never taken for a local module.
    const pickFor = (module: string): string | undefined => {
      if (!module.includes('.') && PYTHON_STDLIB.has(module)) return undefined;
      const candidates = pyIndex.get(module)?.filter(path => reachable(from, path, module));
      return candidates && candidates.length > 0 ? closest(candidates, from) : undefined;
    };
    if (spec.includes('.') || !PYTHON_STDLIB.has(spec)) {
      for (const name of imp.names ?? []) {
        const pick = pickFor(`${spec}.${name}`);
        if (pick) return {file: pick};
      }
    }
    // `import utils` must not bind to some unrelated deep/utils.py, nor `from a2a import x` to the importer's own
    // package a2a: see reachable().
    for (let module = spec; ; module = module.slice(0, module.lastIndexOf('.'))) {
      const pick = pickFor(module);
      if (pick) return {file: pick};
      if (!module.includes('.')) break;
    }
    return PYTHON_STDLIB.has(top) ? 'builtin' : {ext: top};
  };

  // ---- Go
  const resolveGo = (spec: string): Target => {
    for (const mod of goModules) {
      if (spec !== mod.module && !spec.startsWith(`${mod.module}/`)) continue;
      const dir = joinPath(mod.dir, spec.slice(mod.module.length + 1));
      return dir !== undefined && dirSet.has(dir) ? {dir} : 'unresolved';
    }
    const parts = spec.split('/');
    if (!parts[0]!.includes('.')) return spec === 'C' ? 'skip' : 'builtin';
    for (const mod of goModules) {
      const required = mod.requires.find(dep => spec === dep || spec.startsWith(`${dep}/`));
      if (required) return {ext: required};
    }
    return {ext: parts.slice(0, GO_HOSTED.has(parts[0]!) ? 3 : 2).join('/')};
  };

  // ---- Rust
  const rustFile = (base: string | undefined): string | undefined => {
    if (base === undefined) return undefined;
    if (fileSet.has(`${base}.rs`)) return `${base}.rs`;
    if (fileSet.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
    return undefined;
  };
  const resolveRust = (from: string, imp: ScannedImport, fact: ScannedFacts): Target => {
    const dir = dirName(from);
    const isRootFile = /(?:^|\/)(mod|lib|main)\.rs$/.test(from);
    const selfDir = isRootFile ? dir : from.replace(/\.rs$/, '');
    if (imp.kind === 'mod') {
      const hit = rustFile(joinPath(selfDir, imp.spec)) ?? rustFile(joinPath(dir, imp.spec));
      return hit ? {file: hit} : 'unresolved';
    }
    const segments = imp.spec.replace(/^::/, '').split('::').filter(Boolean);
    const head = segments[0];
    if (head === undefined) return 'skip';
    let root: string | undefined;
    if (head === 'crate') {
      for (let probe: string | undefined = dir; probe !== undefined; probe = probe === '' ? undefined : dirName(probe)) {
        if (fileSet.has(probe ? `${probe}/lib.rs` : 'lib.rs') || fileSet.has(probe ? `${probe}/main.rs` : 'main.rs')) {
          root = probe;
          break;
        }
      }
      if (root === undefined) return 'unresolved';
      segments.shift();
    } else if (head === 'super') {
      root = isRootFile ? dirName(dir) : dir;
      segments.shift();
      while (segments[0] === 'super') {
        root = dirName(root);
        segments.shift();
      }
    } else if (head === 'self') {
      root = selfDir;
      segments.shift();
    } else if (crates.has(head)) {
      const crateDir = crates.get(head)!;
      root = crateDir ? `${crateDir}/src` : 'src';
      segments.shift();
    } else if (fact.imports.some(other => other.kind === 'mod' && other.spec === head)) {
      root = selfDir;
    } else if (head === 'std' || head === 'core' || head === 'alloc' || head === 'proc_macro' || head === 'test') return 'builtin';
    else return /^[a-z]/.test(head) ? {ext: head} : 'skip';
    for (let take = segments.length; take > 0; take--) {
      const hit = rustFile(joinPath(root, segments.slice(0, take).join('/')));
      if (hit) return {file: hit};
    }
    for (const entry of ['lib.rs', 'main.rs', 'mod.rs']) {
      const candidate = root ? `${root}/${entry}` : entry;
      if (fileSet.has(candidate)) return {file: candidate};
    }
    return 'unresolved';
  };

  // ---- JVM, C#, PHP, Ruby, Swift, Dart, C
  const resolveJvm = (from: string, imp: ScannedImport): Target => {
    const spec = imp.spec.replace(/`/g, '');
    let name = spec;
    for (let strip = 0; strip < 3; strip++) {
      const candidates = classIndex.get(name);
      if (candidates) return {file: closest(candidates, from)};
      const dot = name.lastIndexOf('.');
      if (dot === -1) break;
      name = name.slice(0, dot);
    }
    const sameNamespace = namespaceFiles.get(`jvm:${spec}`);
    if (sameNamespace) return {dir: dirName(closest(sameNamespace, from))};
    if (JVM_BUILTIN.test(`${spec}.`)) return 'builtin';
    const parts = spec.split('.');
    return {ext: parts.slice(0, JVM_TLD.has(parts[0]!) ? 3 : 2).join('.')};
  };
  const resolveCs = (from: string, spec: string): Target => {
    for (let name = spec; ; name = name.slice(0, name.lastIndexOf('.'))) {
      const candidates = namespaceFiles.get(`cs:${name}`);
      if (candidates) return {dir: dirName(closest(candidates, from))};
      if (!name.includes('.')) break;
    }
    if (spec === 'System' || spec.startsWith('System.')) return 'builtin';
    return {ext: spec.split('.').slice(0, 2).join('.')};
  };
  const resolvePhp = (from: string, imp: ScannedImport): Target => {
    if (imp.kind === 'relative') {
      const hit = joinPath(dirName(from), imp.spec.replace(/^\//, ''));
      return hit !== undefined && fileSet.has(hit) ? {file: hit} : 'unresolved';
    }
    let name = imp.spec;
    for (let strip = 0; strip < 2; strip++) {
      const candidates = classIndex.get(`php:${name}`);
      if (candidates) return {file: closest(candidates, from)};
      const slash = name.lastIndexOf('\\');
      if (slash === -1) break;
      name = name.slice(0, slash);
    }
    return imp.spec.includes('\\') ? {ext: imp.spec.split('\\').slice(0, 2).join('\\')} : 'builtin';
  };
  const resolveRuby = (from: string, imp: ScannedImport): Target => {
    const spec = imp.spec.replace(/\.rb$/, '');
    const sibling = joinPath(dirName(from), `${spec}.rb`);
    if (imp.kind === 'relative') return sibling !== undefined && fileSet.has(sibling) ? {file: sibling} : 'unresolved';
    const candidates = rubyLib.get(spec);
    if (candidates) return {file: closest(candidates, from)};
    if (sibling !== undefined && fileSet.has(sibling)) return {file: sibling};
    const top = spec.split('/')[0]!;
    return RUBY_STDLIB.has(top) ? 'builtin' : {ext: top};
  };
  const resolveSwift = (spec: string): Target => {
    const name = spec.split('.')[0]!;
    const dir = swiftModules.get(name);
    if (dir !== undefined) return {dir, recursive: true};
    return SWIFT_SYSTEM.has(name) ? 'builtin' : {ext: name};
  };
  const resolveDart = (from: string, spec: string): Target => {
    if (spec.startsWith('dart:')) return 'builtin';
    if (spec.startsWith('package:')) {
      const rest = spec.slice(8);
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const dir = dartByName.get(name);
      if (dir === undefined) return {ext: name};
      const hit = joinPath(dir, `lib/${rest.slice(slash + 1)}`);
      return hit !== undefined && fileSet.has(hit) ? {file: hit} : 'unresolved';
    }
    const hit = joinPath(dirName(from), spec);
    return hit !== undefined && fileSet.has(hit) ? {file: hit} : 'unresolved';
  };
  const resolveC = (from: string, imp: ScannedImport): Target => {
    if (imp.kind === 'relative') {
      const hit = joinPath(dirName(from), imp.spec);
      if (hit !== undefined && fileSet.has(hit)) return {file: hit};
    }
    const candidates = headerIndex.get(imp.spec.replace(/^(\.\.?\/)+/, ''));
    if (candidates) return {file: closest(candidates, from)};
    return imp.kind === 'system' ? 'builtin' : 'unresolved';
  };

  const resolve = (from: string, fact: ScannedFacts, imp: ScannedImport): Target => {
    switch (fact.scan) {
      case 'ts': return resolveTs(from, imp.spec);
      case 'py': return resolvePy(from, imp);
      case 'go': return resolveGo(imp.spec);
      case 'rs': return resolveRust(from, imp, fact);
      case 'java': case 'kt': return resolveJvm(from, imp);
      case 'cs': return resolveCs(from, imp.spec);
      case 'php': return resolvePhp(from, imp);
      case 'rb': return resolveRuby(from, imp);
      case 'swift': return resolveSwift(imp.spec);
      case 'dart': return resolveDart(from, imp.spec);
      case 'c': return resolveC(from, imp);
      default: return 'skip';
    }
  };

  // ---- edges
  const edges: ImportEdge[] = [];
  let imports = 0;
  let unresolved = 0;
  for (const [from, fact] of facts) {
    if (fact.imports.length === 0) continue;
    const mine = new Map<string, ImportEdge>();
    for (const imp of fact.imports) {
      const target = resolve(from, fact, imp);
      if (target === 'skip') continue;
      imports++;
      if (target === 'builtin') continue;
      if (target === 'unresolved') {
        unresolved++;
        continue;
      }
      const to = 'file' in target ? target.file : 'dir' in target ? target.dir : `ext:${target.ext}`;
      if (to === from) continue;
      const kind = 'dir' in target ? (target.recursive ? 'module' : 'package') : imp.kind;
      const existing = mine.get(to);
      // An edge stays type-only only while every import behind it is, and lazy only while none of them loads eagerly.
      if (!existing) mine.set(to, {from, to, kind});
      else if (strength(kind) > strength(existing.kind)) existing.kind = kind;
    }
    for (const edge of mine.values()) edges.push(edge);
  }
  return {edges, imports, unresolved};
}

const ECOSYSTEM_BY_LANGUAGE: Readonly<Record<string, string>> = {
  TypeScript: 'npm', JavaScript: 'npm', Vue: 'npm', Svelte: 'npm', Astro: 'npm',
  Python: 'pypi', Go: 'go', Rust: 'cargo', Java: 'maven', Kotlin: 'maven', Ruby: 'gem', 'C#': 'nuget', PHP: 'composer',
  Swift: 'swiftpm', Dart: 'pub', C: 'system', 'C++': 'system', 'Objective-C': 'system',
};

/** Package ecosystem an external import belongs to, from the language of the importing file. */
export function ecosystemOf(language: string | undefined): string {
  return (language && Object.hasOwn(ECOSYSTEM_BY_LANGUAGE, language) && ECOSYSTEM_BY_LANGUAGE[language]) || 'other';
}

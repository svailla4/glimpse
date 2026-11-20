// Language, test and generated-file classification by path. Pure: nothing here touches the disk.

/** Languages the facts scanner has import and symbol patterns for. */
export type ScanLang = 'ts' | 'py' | 'go' | 'rs' | 'java' | 'kt' | 'rb' | 'cs' | 'php' | 'swift' | 'dart' | 'c';
/** How comments start, which decides where a TODO tag counts and which lines are comment-only. */
export type CommentStyle = 'c' | 'hash' | 'dash' | 'semi' | 'html' | 'pct';

export interface Language {
  name: string;
  /** `code` counts toward complexity and the stack; the others are counted as lines only. */
  kind: 'code' | 'markup' | 'data' | 'prose' | 'config';
  comments?: CommentStyle;
  scan?: ScanLang;
}

const lang = (name: string, kind: Language['kind'], comments?: CommentStyle, scan?: ScanLang): Language =>
  ({name, kind, ...(comments ? {comments} : {}), ...(scan ? {scan} : {})});

const TS = lang('TypeScript', 'code', 'c', 'ts');
const JS = lang('JavaScript', 'code', 'c', 'ts');
const PY = lang('Python', 'code', 'hash', 'py');
const RB = lang('Ruby', 'code', 'hash', 'rb');
const C = lang('C', 'code', 'c', 'c');
const CPP = lang('C++', 'code', 'c', 'c');
const KT = lang('Kotlin', 'code', 'c', 'kt');
const GROOVY = lang('Groovy', 'code', 'c');
const SHELL = lang('Shell', 'code', 'hash');
const YAML = lang('YAML', 'config', 'hash');
const JSON_ = lang('JSON', 'data');
const MD = lang('Markdown', 'prose');
const INI = lang('INI', 'config', 'semi');
const MAKE = lang('Makefile', 'config', 'hash');
const DOCKER = lang('Dockerfile', 'config', 'hash');
const STARLARK = lang('Starlark', 'config', 'hash');
const IGNORE = lang('Ignore List', 'config', 'hash');
const HTML = lang('HTML', 'markup', 'html');
const XML = lang('XML', 'data', 'html');

const BY_EXT: Readonly<Record<string, Language>> = {
  ts: TS, tsx: TS, mts: TS, cts: TS,
  js: JS, jsx: JS, mjs: JS, cjs: JS,
  vue: lang('Vue', 'code', 'c', 'ts'), svelte: lang('Svelte', 'code', 'c', 'ts'), astro: lang('Astro', 'code', 'c', 'ts'),
  py: PY, pyi: PY, pyw: PY,
  go: lang('Go', 'code', 'c', 'go'),
  rs: lang('Rust', 'code', 'c', 'rs'),
  java: lang('Java', 'code', 'c', 'java'),
  kt: KT, kts: KT,
  scala: lang('Scala', 'code', 'c'), sc: lang('Scala', 'code', 'c'),
  groovy: GROOVY, gradle: GROOVY,
  rb: RB, rake: RB, gemspec: RB,
  cs: lang('C#', 'code', 'c', 'cs'),
  fs: lang('F#', 'code', 'c'), fsx: lang('F#', 'code', 'c'),
  php: lang('PHP', 'code', 'c', 'php'),
  swift: lang('Swift', 'code', 'c', 'swift'),
  dart: lang('Dart', 'code', 'c', 'dart'),
  c: C, h: C,
  cc: CPP, cpp: CPP, cxx: CPP, hpp: CPP, hh: CPP, hxx: CPP,
  m: lang('Objective-C', 'code', 'c', 'c'), mm: lang('Objective-C', 'code', 'c', 'c'),
  zig: lang('Zig', 'code', 'c'),
  sol: lang('Solidity', 'code', 'c'),
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL,
  ps1: lang('PowerShell', 'code', 'hash'), psm1: lang('PowerShell', 'code', 'hash'),
  bat: lang('Batch', 'code'), cmd: lang('Batch', 'code'),
  lua: lang('Lua', 'code', 'dash'),
  pl: lang('Perl', 'code', 'hash'), pm: lang('Perl', 'code', 'hash'),
  r: lang('R', 'code', 'hash'),
  jl: lang('Julia', 'code', 'hash'),
  ex: lang('Elixir', 'code', 'hash'), exs: lang('Elixir', 'code', 'hash'),
  erl: lang('Erlang', 'code', 'pct'), hrl: lang('Erlang', 'code', 'pct'),
  hs: lang('Haskell', 'code', 'dash'),
  ml: lang('OCaml', 'code'), mli: lang('OCaml', 'code'),
  clj: lang('Clojure', 'code', 'semi'), cljs: lang('Clojure', 'code', 'semi'), cljc: lang('Clojure', 'code', 'semi'),
  el: lang('Emacs Lisp', 'code', 'semi'), lisp: lang('Common Lisp', 'code', 'semi'), scm: lang('Scheme', 'code', 'semi'),
  nim: lang('Nim', 'code', 'hash'),
  cr: lang('Crystal', 'code', 'hash'),
  sql: lang('SQL', 'code', 'dash'),
  graphql: lang('GraphQL', 'code', 'hash'), gql: lang('GraphQL', 'code', 'hash'),
  proto: lang('Protocol Buffers', 'code', 'c'),
  prisma: lang('Prisma', 'code', 'c'),
  html: HTML, htm: HTML, xhtml: HTML,
  hbs: lang('Handlebars', 'markup', 'html'), ejs: lang('EJS', 'markup', 'html'), erb: lang('ERB', 'markup', 'html'),
  j2: lang('Jinja', 'markup'), jinja: lang('Jinja', 'markup'), liquid: lang('Liquid', 'markup'), twig: lang('Twig', 'markup'),
  css: lang('CSS', 'markup', 'c'), scss: lang('SCSS', 'markup', 'c'), sass: lang('Sass', 'markup', 'c'), less: lang('Less', 'markup', 'c'),
  md: MD, mdx: MD, markdown: MD,
  rst: lang('reStructuredText', 'prose'), adoc: lang('AsciiDoc', 'prose'), txt: lang('Text', 'prose'),
  tex: lang('TeX', 'prose', 'pct'),
  json: JSON_, jsonc: JSON_, json5: JSON_, webmanifest: JSON_,
  ipynb: lang('Jupyter Notebook', 'data'),
  yaml: YAML, yml: YAML,
  toml: lang('TOML', 'config', 'hash'),
  ini: INI, cfg: INI, conf: INI, properties: INI, env: INI,
  xml: XML, xsd: XML, xsl: XML, plist: XML, csproj: XML, svg: lang('SVG', 'data', 'html'),
  csv: lang('CSV', 'data'), tsv: lang('CSV', 'data'),
  mk: MAKE,
  cmake: lang('CMake', 'config', 'hash'),
  dockerfile: DOCKER,
  tf: lang('HCL', 'config', 'hash'), tfvars: lang('HCL', 'config', 'hash'), hcl: lang('HCL', 'config', 'hash'),
  nix: lang('Nix', 'config', 'hash'),
  bzl: STARLARK, bazel: STARLARK,
};

const BY_NAME: Readonly<Record<string, Language>> = {
  Dockerfile: DOCKER, Containerfile: DOCKER,
  Makefile: MAKE, makefile: MAKE, GNUmakefile: MAKE,
  'CMakeLists.txt': lang('CMake', 'config', 'hash'),
  Gemfile: RB, Rakefile: RB, Vagrantfile: RB, Podfile: RB,
  Jenkinsfile: GROOVY,
  BUILD: STARLARK, WORKSPACE: STARLARK,
  'go.mod': lang('Go Module', 'config', 'c'), 'go.sum': lang('Go Module', 'config'),
  '.gitignore': IGNORE, '.dockerignore': IGNORE, '.npmignore': IGNORE, '.gitattributes': IGNORE,
  '.editorconfig': INI, '.npmrc': INI, '.env': INI,
};

const BINARY_EXT = new Set(
  ('png jpg jpeg gif webp ico bmp tif tiff avif heic mp4 mov webm mkv avi mp3 wav ogg flac pdf zip gz tgz bz2 xz 7z rar zst jar war ear ' +
    'class so dylib dll exe o a lib obj wasm woff woff2 ttf otf eot bin dat db sqlite sqlite3 pyc pyo node icns psd ai sketch fig ' +
    'keystore jks p12 pfx der doc docx xls xlsx ppt pptx parquet npy npz pkl onnx pt safetensors').split(' '),
);

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
export function dirName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
/** Lower-case extension without the dot; '' for dotfiles and names without one. */
export function extName(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Language of a path from its file name, then its extension. Undefined when the table has no entry. */
export function languageOf(path: string): Language | undefined {
  const base = baseName(path);
  const named = BY_NAME[base];
  if (named) return named;
  if (base.startsWith('Dockerfile.') || base.startsWith('.env.')) return base.startsWith('.env.') ? INI : DOCKER;
  const ext = extName(path);
  return ext ? BY_EXT[ext] : undefined;
}

/** True for extensions that are never worth reading (images, archives, fonts, object code). */
export function isBinaryExt(path: string): boolean {
  return BINARY_EXT.has(extName(path));
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[^/]+$|_test\.(go|py|dart|rb)$|(^|\/)test_[^/]+\.py$|[a-z0-9]Tests?\.(java|kt|cs|swift)$/;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock', 'Gemfile.lock', 'composer.lock',
  'pubspec.lock', 'Podfile.lock', 'Package.resolved', 'packages.lock.json', 'gradle.lockfile', 'mix.lock', 'flake.lock',
]);
const GENERATED_PATH = /(^|\/)(dist|build|vendor|node_modules|__snapshots__)\/|\.min\.[^/]+$|\.pb\.go$|\.generated\.[^/]+$|\.snap$|\.g\.dart$|\.freezed\.dart$|_pb2(_grpc)?\.pyi?$|\.designer\.cs$/i;

/** Generated by path alone: lockfiles, minified bundles, build output, vendored code, protobuf output, snapshots. */
export function isGeneratedPath(path: string): boolean {
  return LOCKFILES.has(baseName(path)) || GENERATED_PATH.test(path);
}

const GENERATED_MARK = /@generated|Code generated .{0,80}DO NOT EDIT|GENERATED CODE - DO NOT MODIFY|<auto-generated/i;

/** Generated by content: the conventional header marker within the first few hundred characters. */
export function hasGeneratedHeader(head: string): boolean {
  return GENERATED_MARK.test(head);
}

// packages/server/src/code/langs.ts
// The languages the code service can highlight: which grammar a path or a language name maps to, and how each
// grammar is loaded. Grammars are imported one by one, on first use, through static specifiers the bundler can see.
import type {LanguageRegistration} from 'shiki/core';

export interface LangInfo {
  /** Grammar id, the `lang` of FileSlice, HighlightResult and DiffFile ('typescript'). */
  id: string;
  /** Display name, the `lang` of dataset rows ('TypeScript'). */
  name: string;
}

/** `lang` of anything without a grammar. */
export const PLAIN_LANG = 'text';

type GrammarModule = {default: LanguageRegistration[]};

export const GRAMMARS: Readonly<Record<string, () => Promise<GrammarModule>>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
};

const lang = (id: string, name: string): LangInfo => ({id, name});
const TYPESCRIPT = lang('typescript', 'TypeScript');
const JAVASCRIPT = lang('javascript', 'JavaScript');
const JSON_LANG = lang('json', 'JSON');
const CPP = lang('cpp', 'C++');
const RUBY = lang('ruby', 'Ruby');
const SHELL = lang('shellscript', 'Shell');
const YAML = lang('yaml', 'YAML');
const TOML = lang('toml', 'TOML');
const DOCKERFILE = lang('dockerfile', 'Dockerfile');

const BY_EXTENSION = new Map<string, LangInfo>(Object.entries({
  ts: TYPESCRIPT, mts: TYPESCRIPT, cts: TYPESCRIPT, tsx: lang('tsx', 'TypeScript'),
  js: JAVASCRIPT, mjs: JAVASCRIPT, cjs: JAVASCRIPT, jsx: lang('jsx', 'JavaScript'),
  json: JSON_LANG, jsonc: JSON_LANG, json5: JSON_LANG, webmanifest: JSON_LANG,
  py: lang('python', 'Python'), pyi: lang('python', 'Python'),
  go: lang('go', 'Go'),
  rs: lang('rust', 'Rust'),
  java: lang('java', 'Java'),
  kt: lang('kotlin', 'Kotlin'), kts: lang('kotlin', 'Kotlin'),
  rb: RUBY, rake: RUBY, gemspec: RUBY,
  cs: lang('csharp', 'C#'),
  php: lang('php', 'PHP'),
  swift: lang('swift', 'Swift'),
  dart: lang('dart', 'Dart'),
  c: lang('c', 'C'), h: lang('c', 'C'),
  cc: CPP, cpp: CPP, cxx: CPP, hh: CPP, hpp: CPP, hxx: CPP,
  css: lang('css', 'CSS'),
  html: lang('html', 'HTML'), htm: lang('html', 'HTML'),
  md: lang('markdown', 'Markdown'), markdown: lang('markdown', 'Markdown'),
  yml: YAML, yaml: YAML,
  toml: TOML,
  sql: lang('sql', 'SQL'),
  sh: SHELL, bash: SHELL, zsh: SHELL,
  dockerfile: DOCKERFILE,
  diff: lang('diff', 'Diff'), patch: lang('diff', 'Diff'),
}));

const BY_FILENAME = new Map<string, LangInfo>(Object.entries({
  dockerfile: DOCKERFILE, containerfile: DOCKERFILE,
  gemfile: RUBY, rakefile: RUBY,
  '.bashrc': SHELL, '.zshrc': SHELL, '.profile': SHELL, '.bash_profile': SHELL,
  'cargo.lock': TOML, 'poetry.lock': TOML, 'uv.lock': TOML,
  '.clang-format': YAML,
}));

/** Names a model or a Markdown fence may use for a grammar, beyond grammar ids and file extensions. */
const ALIASES = new Map<string, string>(Object.entries({
  golang: 'go', python3: 'python', 'c++': 'cpp', 'c#': 'csharp', shell: 'shellscript', console: 'shellscript',
  docker: 'dockerfile', node: 'javascript',
}));

/** Language of a repo path, from its file name or extension; undefined when there is no grammar for it. */
export function langOfPath(path: string): LangInfo | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = BY_FILENAME.get(name);
  if (byName) return byName;
  if (name.startsWith('dockerfile.')) return DOCKERFILE;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? BY_EXTENSION.get(name.slice(dot + 1)) : undefined;
}

/** Grammar id for a language name ('ts', 'TypeScript', 'c++'); undefined when it is unknown or empty. */
export function grammarOfName(name: string | undefined): string | undefined {
  const key = name?.trim().toLowerCase();
  if (!key) return undefined;
  if (Object.hasOwn(GRAMMARS, key)) return key;
  return ALIASES.get(key) ?? BY_EXTENSION.get(key)?.id;
}

// scripts/notices.ts - the third-party notices of everything the build ships, generated from what the bundlers
// actually put in the output (never from package.json alone).
//
// Inputs:
//   - the esbuild metafile of the server bundle (scripts/server-bundle.ts);
//   - the module record of the viewer build, main and worker (MODULE_RECORD, written by the glimpse:module-record
//     plugin in packages/viewer/vite.config.ts): which modules went into each script, which source file each asset
//     (the fonts) was copied from;
//   - scripts/notices/vendored.json and texts/: what node_modules cannot tell (code a package bundled from another
//     project, packages that ship without a licence file, the Shiki grammars' upstream licences).
// Outputs (render()): THIRD_PARTY_NOTICES.md, and next to the fonts and the ELK worker the licence files their
// licences ask for (viewer/assets/OFL-<family>.txt, viewer/assets/elkjs-LICENSE.txt).
//
// collect() reports a problem, and the build fails, when a shipped package has a licence outside ALLOWED, has no
// licence text, bundles code from another package that vendored.json does not list (found through the package's
// source maps), or when a vendored.json entry no longer matches the shipped version.
//
// scripts/build.mjs writes the outputs into the build directory and keeps THIRD_PARTY_NOTICES.md at the repository
// root up to date; packages/viewer/test/build.test.ts regenerates it in memory and fails when the committed copy is
// stale.
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Where the viewer build writes its module record, relative to its output directory. Never copied into plugin/. */
export const MODULE_RECORD = '.vite/glimpse-modules.json';
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';
export const ELK_LICENSE_FILE = 'elkjs-LICENSE.txt';

/** One emitted file of the viewer build: the modules of a script, the source files of an asset (repository-relative). */
export interface OutputRecord {
  file: string;
  modules?: string[];
  originalFileNames?: string[];
}
export interface ViewerRecord {
  main: OutputRecord[];
  worker: OutputRecord[];
}
/** The part of an esbuild metafile this module reads. */
export interface Metafile {
  outputs: Record<string, {entryPoint?: string; inputs: Record<string, {bytesInOutput: number}>}>;
}

type Artefact = 'server' | 'viewer' | 'worker' | 'fonts';
const ARTEFACTS: Record<Artefact, string> = {
  server: '`dist/server.mjs` (the MCP server)',
  viewer: '`dist/viewer/assets/*.js` and `*.css` (the viewer, except the ELK worker)',
  worker: '`dist/viewer/assets/elk.worker-*.js` (the ELK layout worker)',
  fonts: '`dist/viewer/assets/*.woff`, `*.woff2` (the fonts)',
};

/**
 * Licences a shipped package may carry. Anything else (a copyleft licence, UNLICENSED, no licence field) fails the
 * build until someone has read it. elkjs alone may be dual-licensed with the GPL: Glimpse takes it under the EPL-2.0
 * (see the notices), because the GPL would not allow Glimpse's own licence on the rest of the viewer.
 */
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'OFL-1.1']);
const ALLOWED_FOR: Record<string, string> = {elkjs: 'EPL-2.0 OR GPL-3.0-or-later'};
const ELECTED: Record<string, string> = {elkjs: 'EPL-2.0'};

const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[-._].*)?$/i;
const NOTICE_FILE = /^notice(?:[-._].*)?$/i;

interface Vendored {
  in: string;
  name: string;
  version: string;
  license: string;
  source: string;
  text?: string;
  how?: string;
  note?: string;
}
interface VendoredFile {
  missingText: Array<{name: string; version: string; text: string; why: string}>;
  vendored: Vendored[];
  grammars: {
    in: string;
    from: string;
    license: string;
    notice: string;
    noticeAbout: string;
    grant: {text: string; grammars: Record<string, string>; about: string};
    omitted: Record<string, string>;
  };
  runtimes: Array<{match: string; package: string; cutBefore?: string; about: string}>;
}

interface Text {
  file: string;
  content: string;
}
interface Component {
  name: string;
  version: string;
  license: string;
  dir: string;
  homepage?: string;
  artefacts: Set<Artefact>;
  texts: Text[];
  notices: Text[];
  textNote?: string;
  about?: string;
  vendored: Vendored[];
  grammars?: string[];
}

export interface Collection {
  components: Component[];
  problems: string[];
  /** False when the viewer was not part of the build: the notices then cover the server only. */
  complete: boolean;
  root: string;
  vendored: VendoredFile;
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const posix = (path: string) => path.split(sep).join('/');
const readText = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function loadVendored(): VendoredFile {
  return JSON.parse(readFileSync(join(scriptsDir, 'notices', 'vendored.json'), 'utf8')) as VendoredFile;
}
const vendoredText = (name: string) => readText(join(scriptsDir, 'notices', 'texts', name));

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  dir: string;
  homepage?: string;
}

/** The package a file belongs to: the nearest package.json with a name and a version, walking up from the file. */
function packageOf(file: string, root: string, cache: Map<string, PackageInfo | null>): PackageInfo | null {
  let dir = dirname(file);
  const seen: string[] = [];
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const each of seen) cache.set(each, cached);
      return cached;
    }
    seen.push(dir);
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, any>;
      if (typeof json.name === 'string' && typeof json.version === 'string') {
        const license = typeof json.license === 'string' ? json.license : typeof json.license?.type === 'string' ? json.license.type : '';
        const repository = typeof json.repository === 'string' ? json.repository : json.repository?.url;
        const homepage = typeof json.homepage === 'string' ? json.homepage : typeof repository === 'string' ? repository.replace(/^git\+/, '').replace(/\.git$/, '') : undefined;
        const info: PackageInfo = {name: json.name, version: json.version, license, dir, homepage};
        for (const each of seen) cache.set(each, info);
        return info;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || !(dir + sep).startsWith(root + sep)) {
      for (const each of seen) cache.set(each, null);
      return null;
    }
    dir = parent;
  }
}

/** Glimpse's own workspaces (and the repository root) are not third-party. */
const isOwn = (info: PackageInfo, root: string) => !posix(relative(root, info.dir)).split('/').includes('node_modules');

/** Package names in the `sources` of a file's source map that are not the file's own package. */
function vendoredIn(file: string, host: string): string[] {
  let mapFile = `${file}.map`;
  if (!existsSync(mapFile)) {
    const tail = readFileSync(file, 'utf8').slice(-400);
    const url = /\/\/# sourceMappingURL=([^\s]+)\s*$/.exec(tail)?.[1];
    if (!url || url.startsWith('data:')) return [];
    mapFile = resolve(dirname(file), url);
    if (!existsSync(mapFile)) return [];
  }
  let sources: unknown;
  try {
    sources = (JSON.parse(readFileSync(mapFile, 'utf8')) as {sources?: unknown}).sources;
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source !== 'string') continue;
    const at = source.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const name = /^((?:@[^/]+\/)?[^/]+)/.exec(source.slice(at + 'node_modules/'.length))?.[1];
    if (name && name !== host && !name.startsWith('.')) names.add(name);
  }
  return [...names];
}

function licenceFiles(dir: string): {texts: Text[]; notices: Text[]} {
  const entries = readdirSync(dir).filter(name => statSync(join(dir, name)).isFile()).sort();
  const read = (name: string) => ({file: name, content: readText(join(dir, name))});
  return {texts: entries.filter(name => LICENSE_FILE.test(name)).map(read), notices: entries.filter(name => NOTICE_FILE.test(name)).map(read)};
}

/**
 * Works out every third-party component of the build and its licence texts. `serverMetafile` is esbuild's metafile
 * of dist/server.mjs; `viewer` the module record of the viewer build, or undefined when the build has no viewer.
 */
export function collect(root: string, serverMetafile: Metafile, viewer: ViewerRecord | undefined): Collection {
  const vendored = loadVendored();
  const problems: string[] = [];
  const components = new Map<string, Component>();
  const packages = new Map<string, PackageInfo | null>();
  const mapsChecked = new Set<string>();

  const add = (info: PackageInfo, artefact: Artefact, file?: string) => {
    // Two copies of one version (zod 4 is nested twice) are one component: the same code under the same licence.
    const key = `${info.name}@${info.version}`;
    let component = components.get(key);
    if (!component) {
      component = {name: info.name, version: info.version, license: info.license, dir: posix(relative(root, info.dir)), homepage: info.homepage, artefacts: new Set(), texts: [], notices: [], vendored: []};
      components.set(key, component);
    }
    component.artefacts.add(artefact);
    if (file && !mapsChecked.has(file)) {
      mapsChecked.add(file);
      for (const name of vendoredIn(file, info.name)) {
        const listed = vendored.vendored.some(entry => entry.in === `${info.name}@${info.version}` && entry.name === name);
        if (!listed) problems.push(`${name} is bundled inside ${info.name}@${info.version} (${posix(relative(root, file))}); add its licence to scripts/notices/vendored.json`);
      }
    }
    return component;
  };
  const addFile = (file: string, artefact: Artefact) => {
    const info = packageOf(file, root, packages);
    if (!info) {
      problems.push(`${posix(relative(root, file))} belongs to no package`);
      return;
    }
    if (!isOwn(info, root)) add(info, artefact, file);
  };
  const addPackage = (name: string, artefact: Artefact) => {
    const file = join(root, 'node_modules', name, 'package.json');
    const info = existsSync(file) ? packageOf(file, root, packages) : null;
    if (!info) problems.push(`${name} is not installed in node_modules`);
    return info ? add(info, artefact) : undefined;
  };

  // ---- the server bundle: every input esbuild kept something of, and esbuild's own runtime helpers
  const output = Object.values(serverMetafile.outputs).find(entry => entry.entryPoint);
  if (!output) problems.push('the server metafile has no entry output');
  for (const [input, {bytesInOutput}] of Object.entries(output?.inputs ?? {})) {
    if (bytesInOutput === 0) continue;
    if (input.includes(':')) {
      if (!input.startsWith('glimpse-omitted:')) problems.push(`server bundle input ${input} is not a file`);
      continue;
    }
    addFile(resolve(root, input), 'server');
  }
  const esbuild = addPackage('esbuild', 'server');
  if (esbuild) esbuild.about = 'the runtime helpers esbuild writes into the bundle';

  // ---- the viewer: scripts and stylesheets, the ELK worker, the fonts
  for (const [outputs, artefact] of viewer ? ([[viewer.main, 'viewer'], [viewer.worker, 'worker']] as const) : []) {
    for (const record of outputs) {
      if (record.file === MODULE_RECORD) continue;
      for (const id of record.modules ?? []) {
        const runtime = vendored.runtimes.find(entry => new RegExp(entry.match).test(id));
        if (runtime) {
          const component = addPackage(runtime.package, artefact);
          if (component) component.about = runtime.about;
          continue;
        }
        if (id.startsWith('\0') || !/\.[cm]?[jt]sx?$|\.css$|\.json$|\.html$/.test(id)) {
          problems.push(`viewer module ${JSON.stringify(id)} is neither a file nor a known bundler runtime`);
          continue;
        }
        addFile(resolve(root, id), artefact);
      }
      for (const source of record.originalFileNames ?? []) {
        const isFont = /\.(?:woff2?|ttf|otf)$/i.test(record.file);
        addFile(resolve(root, source), isFont ? 'fonts' : artefact);
      }
    }
  }

  // ---- licences, texts, vendored code
  const list = [...components.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en') || a.dir.localeCompare(b.dir, 'en'));
  for (const component of list) {
    const id = `${component.name}@${component.version}`;
    const allowed = ALLOWED_FOR[component.name] ?? '';
    if (!ALLOWED.has(component.license) && component.license !== allowed) {
      problems.push(`${id} is licensed ${component.license ? JSON.stringify(component.license) : '(no licence field)'}, which scripts/notices.ts does not allow; read the licence before adding it to ALLOWED`);
    }
    const files = licenceFiles(join(root, component.dir));
    component.texts = files.texts;
    component.notices = files.notices;
    const runtime = vendored.runtimes.find(entry => entry.package === component.name && entry.cutBefore);
    if (runtime?.cutBefore) {
      component.texts = component.texts.map(text => ({file: text.file, content: text.content.split(runtime.cutBefore!)[0]!.trimEnd() + '\n'}));
      component.textNote = `The first part of Vite's ${component.texts.map(text => text.file).join(', ')}: Vite's own licence.`;
    }
    if (component.texts.length === 0) {
      const override = vendored.missingText.find(entry => entry.name === component.name);
      if (override && override.version === component.version) {
        component.texts = [{file: override.text, content: vendoredText(override.text)}];
        component.textNote = override.why;
      } else if (override) {
        problems.push(`${id} has no licence file, and scripts/notices/vendored.json has a text for version ${override.version}: check the new version and update the entry`);
      } else {
        problems.push(`${id} ships without a licence file; add the text to scripts/notices/vendored.json (missingText)`);
      }
    }
    component.vendored = vendored.vendored.filter(entry => entry.in === id);
    for (const entry of vendored.vendored.filter(entry => entry.in.startsWith(`${component.name}@`) && entry.in !== id)) {
      if (!list.some(other => `${other.name}@${other.version}` === entry.in)) problems.push(`scripts/notices/vendored.json lists ${entry.name} inside ${entry.in}, but ${id} ships: check what the new version bundles and update the entry`);
    }
  }

  // ---- the Shiki grammars: each one's upstream licence, from tm-grammars' NOTICE
  const langs = list.find(component => component.name === '@shikijs/langs');
  if (langs) {
    if (`${langs.name}@${langs.version}` !== vendored.grammars.in) problems.push(`scripts/notices/vendored.json describes the grammars of ${vendored.grammars.in}, but ${langs.name}@${langs.version} ships: check tm-grammars' NOTICE for the new version`);
    const notice = vendoredText(vendored.grammars.notice);
    const covered = new Set([...notice.matchAll(/^Files:\s+(.*)$/gm)].flatMap(match => match[1]!.split(',').map(name => name.trim().replace(/\.json$/, ''))));
    const grammars: string[] = [];
    for (const input of Object.keys(output?.inputs ?? {})) {
      const name = /node_modules\/@shikijs\/langs\/dist\/([\w-]+)\.mjs$/.exec(input)?.[1];
      if (!name || name === 'index') continue;
      // `export { default } from './docker.mjs'`: an alias, the grammar is the other file
      if (/^\s*(?:\/\*[^*]*\*\/\s*)?export \{ default \} from '\.\/[\w-]+\.mjs'\s*$/.test(readFileSync(resolve(root, input), 'utf8'))) continue;
      grammars.push(name);
      if (vendored.grammars.omitted[name]) problems.push(`the ${name} grammar is in the server bundle, but it has no licence: ${vendored.grammars.omitted[name]}`);
      else if (!covered.has(name) && !vendored.grammars.grant.grammars[name]) problems.push(`the ${name} grammar ships, and neither tm-grammars' NOTICE excerpt nor the TextMate grant in scripts/notices/vendored.json covers it; add its section from tm-grammars' NOTICE`);
    }
    langs.grammars = grammars.sort();
  }

  return {components: list, problems, complete: viewer !== undefined, root, vendored};
}

/** A fenced block that no backtick run inside the text can close. */
function fence(text: string, info = 'text'): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${info}\n${text.trimEnd()}\n${marks}`;
}

const REQUIRED_NOTICE = 'Required Notice: Copyright 2026 svailla4 (https://github.com/svailla4)';

/** The notices file and the licence files that go next to the fonts and the ELK worker (paths relative to dist). */
export function render(collection: Collection): {notices: string; files: Record<string, string>} {
  const {components, root, vendored} = collection;
  const files: Record<string, string> = {};
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push(
    '# Third-party notices',
    '',
    'Generated by `scripts/notices.ts` from what the build actually bundles. Do not edit by hand: `npm run build` rewrites it.',
    '',
    '## Glimpse',
    '',
    "Glimpse's own code is licensed under the PolyForm Noncommercial License 1.0.0",
    '(https://polyformproject.org/licenses/noncommercial/1.0.0); see `LICENSE.md` and `NOTICE.md`.',
    '',
    REQUIRED_NOTICE,
    '',
    'Those terms cover only the code whose copyright the licensor holds. Every component listed below is a',
    'separate work by other authors, distributed with Glimpse under its own licence, reproduced here. Nothing in',
    "Glimpse's licence limits the rights that a component's licence gives you in that component.",
    '',
    'Paths are relative to the plugin directory (`plugin/` in the repository).',
    collection.complete ? '' : '\n**This build has no viewer: only the server bundle is covered.**\n',
    '## Choices Glimpse made',
    '',
    '- **elkjs** is offered by its authors under the Eclipse Public License 2.0 or, as a Secondary License, the GNU',
    '  General Public License 3.0 or later. Glimpse distributes elkjs under the **Eclipse Public License 2.0** only.',
    `  The licence, the notices and where to get the Source Code are in \`dist/viewer/assets/${ELK_LICENSE_FILE}\`; the`,
    "  worker file starts with elkjs's original copyright notices.",
    '- **Fonts** are shipped unmodified (byte for byte as published by Fontsource) under the SIL Open Font License 1.1.',
    '  Each family\'s licence is next to the font files as `dist/viewer/assets/OFL-<family>.txt`.',
    '- In the viewer, two modules of `@a2ui/web_core` are not bundled: `@a2ui/web_core/v0_9/basic_catalog` and the',
    '  `zod-to-json-schema` package it would pull in are replaced by small Glimpse files',
    '  (`packages/viewer/src/kit/shims/`). The A2UI files themselves are not modified.',
    `- Shiki's GLSL grammar is left out of the server bundle. ${vendored.grammars.omitted.glsl ?? ''}`,
    '- `dist/server.mjs.LEGAL.txt` is what esbuild extracts from the comments of the server bundle. It is kept as a',
    '  supplement; this file is the complete list.',
    '',
    '## Where each component ships',
    '',
  );
  for (const artefact of Object.keys(ARTEFACTS) as Artefact[]) {
    const names = components.filter(component => component.artefacts.has(artefact)).map(component => `${component.name} ${component.version}`);
    if (names.length === 0) continue;
    push(`- ${ARTEFACTS[artefact]}: ${[...new Set(names)].join(', ')}.`);
  }
  push('', '## Components', '');

  const printed = new Map<string, string>();
  const textBlock = (owner: string, text: Text) => {
    const hash = createHash('sha256').update(text.content.trim()).digest('hex');
    const first = printed.get(hash);
    if (first) return [`\`${text.file}\`: the same text as for ${first} above.`, ''];
    printed.set(hash, owner);
    return [`\`${text.file}\`:`, '', fence(text.content), ''];
  };

  for (const component of components) {
    const title = `${component.name} ${component.version}`;
    const elected = ELECTED[component.name];
    push(`### ${title}`, '');
    push(`- Licence: ${component.license}${elected ? `; **distributed by Glimpse under ${elected}**` : ''}`);
    push(`- Ships in: ${[...component.artefacts].map(artefact => ARTEFACTS[artefact]).join('; ')}`);
    if (component.homepage) push(`- Project: ${component.homepage}`);
    if (component.about) push(`- What of it ships: ${component.about}`);
    push('');
    if (component.textNote) push(component.textNote, '');
    for (const text of component.texts) push(...textBlock(title, text));
    for (const text of component.notices) push(...textBlock(title, text));
    for (const entry of component.vendored) {
      push(`#### Inside ${component.name}: ${entry.name}`, '');
      if (entry.version) push(`- Version: ${entry.version}`);
      push(`- Licence: ${entry.license}`, `- Project: ${entry.source}`);
      if (entry.how) push(`- ${entry.how}`);
      push('');
      if (entry.note) push(entry.note, '');
      if (entry.text) push(...textBlock(`${entry.name} (inside ${component.name})`, {file: entry.text, content: vendoredText(entry.text)}));
    }
    if (component.grammars) {
      const {grammars: info} = vendored;
      const granted = component.grammars.filter(name => info.grant.grammars[name]);
      push(`#### Inside ${component.name}: TextMate grammars`, '');
      push(`The bundled grammars (${component.grammars.join(', ')}) come from ${info.from}.`, '');
      push(...textBlock(`tm-grammars`, {file: `tm-grammars LICENSE`, content: vendoredText(info.license)}));
      push(`${info.noticeAbout}`, '', fence(vendoredText(info.notice)), '');
      if (granted.length > 0) {
        push(`${granted.map(name => `${name} (${info.grant.grammars[name]})`).join(', ')}: ${info.grant.about}`, '', fence(vendoredText(info.grant.text)), '');
      }
    }
    if (component.name === 'elkjs') files[`viewer/assets/${ELK_LICENSE_FILE}`] = elkLicense(component);
    if (component.artefacts.has('fonts')) {
      const family = component.name.replace(/^@fontsource(?:-variable)?\//, '');
      const text = component.texts[0];
      if (text) files[`viewer/assets/OFL-${family}.txt`] = text.content;
    }
  }

  push(
    '## In the source repository only',
    '',
    'These files are part of the Git repository, not of the plugin.',
    '',
    '### A2UI JSON Schemas (`packages/catalog/spec/v1_0/*.json`)',
    '',
    '- Licence: Apache-2.0 (`packages/catalog/spec/APACHE-2.0.txt`, the same text as for @a2ui/web_core above)',
    '- Project: https://github.com/a2ui-project/a2ui',
    '',
    '`packages/catalog/spec/NOTICE`:',
    '',
    fence(readText(join(root, 'packages', 'catalog', 'spec', 'NOTICE'))),
    '',
  );
  return {notices: `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, files};
}

function elkLicense(component: Component): string {
  const epl = component.texts.map(text => text.content).join('\n');
  const inside = component.vendored.map(entry => `- ${entry.name} (${entry.version}), ${entry.license}: ${entry.note ?? ''} ${entry.source}`.trimEnd()).join('\n');
  const apache = component.vendored.find(entry => entry.text)?.text;
  return [
    `elkjs ${component.version}, in elk.worker-<hash>.js in this directory`,
    '',
    'Copyright (c) 2017 Kiel University and others.',
    'Copyright (c) 2021 Kiel University and others.',
    '(The original notices, unchanged, are at the top of the worker file.)',
    '',
    `Glimpse distributes elkjs ${component.version} under the Eclipse Public License 2.0 (below). It does not use the`,
    'Secondary License (GNU GPL 3.0 or later) named in Exhibit A for this distribution.',
    '',
    'Source Code. The Source Code of the Program is available under the Eclipse Public License 2.0:',
    `- elkjs ${component.version}: https://github.com/kieler/elkjs/tree/${component.version}`,
    '- the Eclipse Layout Kernel (ELK) it is compiled from: https://github.com/eclipse-elk/elk',
    `- the distributed form: https://registry.npmjs.org/elkjs/-/elkjs-${component.version}.tgz`,
    '',
    "How it is built into Glimpse. The worker file is elkjs's lib/elk.bundled.js minified together with a few",
    "lines of Glimpse code that call elkjs's public API (packages/viewer/src/components/diagrams/flowkit/elk.worker.ts",
    'and elk.protocol.ts); elkjs is not otherwise modified.',
    '',
    'elkjs also contains code compiled from:',
    inside,
    '',
    '================================================================================',
    'Eclipse Public License 2.0 (elkjs LICENSE.md, verbatim)',
    '================================================================================',
    '',
    epl.trimEnd(),
    '',
    ...(apache
      ? ['================================================================================', 'Apache License 2.0 (Guava, GWT)', '================================================================================', '', vendoredText(apache).trimEnd(), '']
      : []),
  ].join('\n');
}

// @vitest-environment node
// packages/viewer/test/build.test.ts  (first version by WP0; owned by the viewer kit)
// Shared gate: builds the viewer in memory (nothing is written to dist) and checks what the host's
// Content-Security-Policy and the cascade-layer contract need from the output. It fails when any part of the viewer
// fails to build, so it can go red because of any component package.
// It also bundles the server in memory and regenerates the third-party notices from both (scripts/notices.ts): the
// committed THIRD_PARTY_NOTICES.md must be what the build would write.
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {build as esbuild} from 'esbuild';
import {build, type Rollup} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {collect, ELK_LICENSE_FILE, type Metafile, MODULE_RECORD, NOTICES_FILE, render, type ViewerRecord} from '../../../scripts/notices.ts';
import {serverBuildOptions} from '../../../scripts/server-bundle.ts';
import {LAYER_ORDER, SHIMS, XYFLOW_CHUNK} from '../vite.config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
let serverMetafile: Metafile;
let files: Array<Rollup.OutputAsset | Rollup.OutputChunk> = [];
const text = (file: Rollup.OutputAsset | Rollup.OutputChunk) => (file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source));

beforeAll(async () => {
  // The test runner sets NODE_ENV to 'test', which would bundle the development build of React: build what ships.
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await build({root, configFile: join(root, 'vite.config.ts'), mode: 'production', logLevel: 'silent', build: {write: false}});
    files = (Array.isArray(result) ? result : [result as Rollup.RollupOutput]).flatMap(output => output.output);
  } finally {
    process.env.NODE_ENV = before;
  }
  serverMetafile = (await esbuild({...serverBuildOptions(repo, join(repo, 'plugin', 'dist', 'server.mjs')), write: false, logLevel: 'silent'})).metafile;
}, 120_000);

describe('viewer build', () => {
  it('the shell has no inline script or style, declares an icon, and loads only its own assets', () => {
    const html = text(files.find(file => file.fileName === 'index.html')!);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle=/i);
    for (const script of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
      expect(script).toMatch(/^<script\b[^>]*\ssrc="\/assets\/[^"]+"[^>]*><\/script>$/i);
    }
    // an empty data: icon, so no browser asks the host for /favicon.ico (it would answer 404 and log an error)
    expect(html).toContain('<link rel="icon" href="data:,"');
    for (const [, url] of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) expect(url).toMatch(/^(\/assets\/|data:,$)/);
  });

  it('every file is the shell or lives under assets/ (the module record for the notices aside, which does not ship)', () => {
    expect(files.map(file => file.fileName).filter(name => name !== 'index.html' && name !== MODULE_RECORD && !name.startsWith('assets/'))).toEqual([]);
  });

  // ---- the eager script (design rule budgets-keep-headroom) ------------------------------------------------------------------
  /** The entry chunk and every chunk it imports statically: what a tab downloads before it can draw anything. */
  function eagerChunks(): Rollup.OutputChunk[] {
    const chunks = new Map(files.flatMap(file => (file.type === 'chunk' ? [[file.fileName, file] as const] : [])));
    const seen = new Set<string>();
    const visit = (name: string) => {
      const chunk = chunks.get(name);
      if (!chunk || seen.has(name)) return;
      seen.add(name);
      for (const next of chunk.imports) visit(next);
    };
    for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk.fileName);
    return [...seen].map(name => chunks.get(name)!);
  }

  it('the eager script keeps headroom under its 215 kB gzip budget', () => {
    const eager = eagerChunks();
    expect(eager.length).toBeGreaterThan(0);
    const gzip = eager.reduce((sum, chunk) => sum + gzipSync(chunk.code).length, 0);
    // The hard figure is 215,000 (decision compiled-viewer). This fails 5 kB earlier, at the limit scripts/budgets.mjs
    // holds, so the budget is never met by surprise: move code to a lazy chunk (or out of the bundle) before raising
    // either number.
    expect(gzip, `eager viewer JS is ${(gzip / 1000).toFixed(1)} kB gzip`).toBeLessThanOrEqual(210_000);
    // the four component families that load on demand stay out of it
    const eagerModules = eager.flatMap(chunk => Object.keys(chunk.modules));
    for (const family of ['table', 'charts', 'diagrams', 'code']) {
      expect(eagerModules.filter(id => id.includes(`/src/components/${family}/`)), family).toEqual([]);
    }
  });

  it('modules the viewer has no use for are replaced by their shims, and lit stays out of every chunk', async () => {
    const modules = files.flatMap(file => (file.type === 'chunk' ? Object.keys(file.modules) : []));
    // the real packages are not bundled
    expect(modules.filter(id => /node_modules\/zod-to-json-schema\//.test(id))).toEqual([]);
    expect(modules.filter(id => /node_modules\/(?:lit|lit-html|lit-element|@lit\/[^/]+)\//.test(id))).toEqual([]);
    // their stand-ins are
    for (const {replacement} of SHIMS) expect(modules.some(id => id === replacement || id.endsWith(replacement)), replacement).toBe(true);
    // The basic-catalog shim only works while @a2ui/react asks that module for the markdown registry and nothing
    // else. A release that imports more must fail here, not in the browser.
    const react = await readFile(join(root, '../../node_modules/@a2ui/react/index.js'), 'utf8');
    const chunk = /from '(\.\/chunk-[^']+\.js)'/.exec(react)?.[1];
    expect(chunk).toBeDefined();
    const source = await readFile(join(root, '../../node_modules/@a2ui/react', chunk!), 'utf8');
    const wanted = [...source.matchAll(/import \{([^}]*)\} from '@a2ui\/web_core\/v0_9\/basic_catalog'/g)].flatMap(match => match[1]!.split(',').map(name => name.trim()).filter(Boolean));
    expect(wanted.sort()).toEqual(['getMarkdownRenderer', 'setMarkdownRenderer']);
    const shim = await import('../src/kit/shims/a2ui-basic-catalog.ts');
    expect(Object.keys(shim).sort()).toEqual(['getMarkdownRenderer', 'setMarkdownRenderer']);
    const renderer = async (markdown: string) => `<p>${markdown}</p>`;
    shim.setMarkdownRenderer(renderer);
    expect(shim.getMarkdownRenderer()).toBe(renderer);
    shim.setMarkdownRenderer(undefined);
    expect(shim.getMarkdownRenderer()).toBeUndefined();
  });

  it('the JSON Schema shim answers with an open schema and one warning instead of throwing', async () => {
    const shim = await import('../src/kit/shims/zod-to-json-schema.ts');
    const warned: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      expect(shim.zodToJsonSchema()).toEqual({});
      expect(shim.parseDef()).toEqual({});
      expect(typeof shim.ignoreOverride).toBe('symbol');
    } finally {
      console.warn = original;
    }
    expect(warned).toHaveLength(1);
  });

  it('every stylesheet starts with the layer order, so xyflow < gl.tokens < gl.base < gl.kit < gl.components always holds', () => {
    expect(LAYER_ORDER).toBe('@layer xyflow,gl.tokens,gl.base,gl.kit,gl.components;');
    const sheets = files.filter(file => file.fileName.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(text(sheet).replace(/^@charset\s+"[^"]*";/, '').startsWith(LAYER_ORDER), sheet.fileName).toBe(true);
    }
  });

  // ---- the diagram engine (decision diagram-engine-in-worker) ---------------------------------------------------------------------
  // The figures are scripts/budgets.mjs's own lines (OWN_LINES); change both together.
  const ELK_WORKER_GZIP = 515_000;
  const XYFLOW_CSS_GZIP = 2_500;
  const named = (pattern: RegExp) => files.filter(file => pattern.test(file.fileName));

  it('ELK runs only in its own same-origin worker file, which needs no eval', () => {
    const [worker, ...more] = named(/^assets\/elk\.worker-[\w-]{8}\.js$/);
    expect(worker, 'assets/elk.worker-<hash>.js').toBeDefined();
    expect(more).toEqual([]);
    const code = text(worker!);
    expect(code).toContain('org.eclipse.elk');
    // The worker runs under the page's CSP (script-src 'self', no 'unsafe-eval'): nothing in it may evaluate strings.
    expect(code).not.toMatch(/\beval\s*\(|\bFunction\s*\(|setTimeout\s*\(\s*["'`]|importScripts/);
    expect(gzipSync(code).length, `ELK worker is ${(gzipSync(code).length / 1000).toFixed(1)} kB gzip`).toBeLessThanOrEqual(ELK_WORKER_GZIP);
    // The page side holds no ELK (there is no main-thread fallback) and starts the worker by its hashed URL.
    const chunks = files.filter((file): file is Rollup.OutputChunk => file.type === 'chunk');
    expect(chunks.filter(chunk => chunk.code.includes('org.eclipse.elk') || Object.keys(chunk.modules).some(id => id.includes('/node_modules/elkjs/'))).map(chunk => chunk.fileName)).toEqual([]);
    expect(chunks.filter(chunk => chunk.code.includes(`/${worker!.fileName}`)).map(chunk => chunk.fileName.replace(/-[\w-]{8}\.js$/, ''))).toEqual(['assets/diagrams']);
  });

  it('React Flow and its stylesheet load with the diagrams only, below every Linework layer', () => {
    const eagerModules = eagerChunks().flatMap(chunk => Object.keys(chunk.modules));
    expect(eagerModules.filter(id => XYFLOW_CHUNK.test(id) || /\/node_modules\/elkjs\//.test(id))).toEqual([]);
    const html = text(files.find(file => file.fileName === 'index.html')!);
    expect(html).not.toMatch(/xyflow|elk/);
    const [sheet, ...more] = named(/^assets\/xyflow-[\w-]{8}\.css$/);
    expect(sheet, 'assets/xyflow-<hash>.css').toBeDefined();
    expect(more).toEqual([]);
    const css = text(sheet!);
    expect(gzipSync(css).length).toBeLessThanOrEqual(XYFLOW_CSS_GZIP);
    // Every rule of React Flow's sheet is inside @layer xyflow (an unlayered rule would beat every gl.* layer), and
    // it sets no Linework token.
    expect(topLevelBlocks(css.slice(LAYER_ORDER.length))).toEqual(['@layer xyflow']);
    expect(css).not.toContain('--gl-');
    // Once a view imports React Flow, its script is a lazy chunk of its own that charts never load.
    const flow = named(/^assets\/xyflow-[\w-]{8}\.js$/) as Rollup.OutputChunk[];
    for (const chunk of flow) expect(Object.keys(chunk.modules).filter(id => /\/node_modules\/(?:react|react-dom|d3-(?:scale|array|shape|hierarchy))\//.test(id))).toEqual([]);
    const charts = files.find((file): file is Rollup.OutputChunk => file.type === 'chunk' && /^assets\/charts-/.test(file.fileName));
    expect(charts?.imports.filter(name => /xyflow-/.test(name))).toEqual([]);
  });
});

/** The distinct preludes of the top-level blocks of a stylesheet (`@layer xyflow`, `.a`, ...), in order of first appearance. */
function topLevelBlocks(css: string): string[] {
  const preludes = new Set<string>();
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) preludes.add(css.slice(start, i).trim());
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) start = i + 1;
    } else if (c === ';' && depth === 0) {
      preludes.add(css.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...preludes];
}

describe('third-party notices', () => {
  const record = (): ViewerRecord => JSON.parse(text(files.find(file => file.fileName === MODULE_RECORD)!));
  const generated = () => render(collect(repo, serverMetafile, record()));

  it('the module record covers the main build and the ELK worker, and traces every font to its package', () => {
    const {main, worker} = record();
    // everything but the shell, which Vite writes after the record and which holds no third-party code
    expect(main.map(output => output.file).sort()).toEqual(files.map(file => file.fileName).filter(name => name !== MODULE_RECORD && name !== 'index.html').sort());
    expect(worker.flatMap(output => output.modules ?? [])).toContain('node_modules/elkjs/lib/elk.bundled.js');
    const fonts = main.filter(output => /\.woff2?$/.test(output.file));
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) expect(font.originalFileNames?.[0], font.file).toMatch(/^node_modules\/@fontsource(?:-variable)?\/[\w-]+\/files\//);
  });

  it('every shipped component has an allowed licence and a licence text', () => {
    expect(collect(repo, serverMetafile, record()).problems).toEqual([]);
  });

  it('the committed THIRD_PARTY_NOTICES.md is current (after a dependency change: npm run build, then commit it)', async () => {
    const committed = await readFile(join(repo, NOTICES_FILE), 'utf8');
    expect(committed === generated().notices, `${NOTICES_FILE} is stale: run npm run build and commit it`).toBe(true);
  });

  it('every third-party package in a script, the worker or the server bundle is in the notices', () => {
    const {notices} = generated();
    const {main, worker} = record();
    const ids = [...main, ...worker].flatMap(output => [...(output.modules ?? []), ...(output.originalFileNames ?? [])]);
    ids.push(...Object.keys(Object.values(serverMetafile.outputs).find(output => output.entryPoint)!.inputs));
    const names = new Set(ids.flatMap(id => {
      const at = id.lastIndexOf('node_modules/');
      return at < 0 ? [] : [/^((?:@[^/]+\/)?[^/]+)/.exec(id.slice(at + 'node_modules/'.length))![1]!];
    }));
    expect(names.size).toBeGreaterThan(60);
    for (const name of names) expect(notices, name).toMatch(new RegExp(`^### ${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\d`, 'm'));
  });

  it('every font file has its family\'s SIL Open Font License next to it', () => {
    const {files: extra} = generated();
    const fonts = record().main.filter(output => /\.woff2?$/.test(output.file));
    for (const font of fonts) {
      const family = /@fontsource(?:-variable)?\/([\w-]+)\//.exec(font.originalFileNames![0]!)![1]!;
      const ofl = extra[`viewer/assets/OFL-${family}.txt`];
      expect(ofl, `OFL-${family}.txt for ${font.file}`).toBeDefined();
      expect(ofl).toMatch(/^Copyright /);
      expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    }
  });

  it('the ELK worker starts with elkjs\'s copyright notices, and the EPL-2.0 and where to get the source are next to it', () => {
    const worker = text(files.find(file => /^assets\/elk\.worker-[\w-]{8}\.js$/.test(file.fileName))!);
    expect(worker.startsWith(`/*! elkjs `)).toBe(true);
    const head = worker.slice(0, 2000);
    expect(head).toContain(ELK_LICENSE_FILE);
    expect(head).toContain(' * Copyright (c) 2017 Kiel University and others.');
    expect(head).toContain(' * Copyright (c) 2021 Kiel University and others.');
    expect(head).toContain('SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later');
    const license = generated().files[`viewer/assets/${ELK_LICENSE_FILE}`]!;
    expect(license).toContain('under the Eclipse Public License 2.0');
    expect(license).toMatch(/https:\/\/github\.com\/kieler\/elkjs\/tree\/\d+\.\d+\.\d+/);
    expect(license).toContain('# Eclipse Public License - v 2.0');
    expect(license).toContain('Apache License');
  });
});

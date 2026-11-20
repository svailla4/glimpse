// @vitest-environment node
// packages/viewer/test/build.test.ts  (first version by WP0; owned by the viewer kit)
// Shared gate: builds the viewer in memory (nothing is written to dist) and checks what the host's
// Content-Security-Policy and the cascade-layer contract need from the output. It fails when any part of the viewer
// fails to build, so it can go red because of any component package.
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {build, type Rollup} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';
import {SHIMS} from '../vite.config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

  it('every file is the shell or lives under assets/', () => {
    expect(files.map(file => file.fileName).filter(name => name !== 'index.html' && !name.startsWith('assets/'))).toEqual([]);
  });

  // ---- the eager script (design rule D13) ------------------------------------------------------------------
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

  it('the eager script keeps headroom under its 200 kB gzip budget', () => {
    const eager = eagerChunks();
    expect(eager.length).toBeGreaterThan(0);
    const gzip = eager.reduce((sum, chunk) => sum + gzipSync(chunk.code).length, 0);
    // scripts/budgets.mjs fails the build at 200,000. This fails 5 kB earlier, so the budget is never met by
    // surprise: move code to a lazy chunk (or out of the bundle) before raising either number.
    expect(gzip, `eager viewer JS is ${(gzip / 1000).toFixed(1)} kB gzip`).toBeLessThanOrEqual(195_000);
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

  it('every stylesheet starts with the layer order, so gl.tokens < gl.base < gl.kit < gl.components always holds', () => {
    const sheets = files.filter(file => file.fileName.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(text(sheet).replace(/^@charset\s+"[^"]*";/, ''), sheet.fileName).toMatch(/^@layer gl\.tokens,gl\.base,gl\.kit,gl\.components;/);
    }
  });
});

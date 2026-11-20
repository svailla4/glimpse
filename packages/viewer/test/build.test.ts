// @vitest-environment node
// packages/viewer/test/build.test.ts  (WP0, frozen)
// Shared gate: builds the viewer in memory (nothing is written to dist) and checks what the host's
// Content-Security-Policy and the cascade-layer contract need from the output. It fails when any part of the viewer
// fails to build, so it can go red because of any component package.
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build, type Rollup} from 'vite';
import {beforeAll, describe, expect, it} from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let files: Array<Rollup.OutputAsset | Rollup.OutputChunk> = [];
const text = (file: Rollup.OutputAsset | Rollup.OutputChunk) => (file.type === 'chunk' ? file.code : typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source));

beforeAll(async () => {
  const result = await build({root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent', build: {write: false}});
  files = (Array.isArray(result) ? result : [result as Rollup.RollupOutput]).flatMap(output => output.output);
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

  it('every stylesheet starts with the layer order, so gl.tokens < gl.base < gl.kit < gl.components always holds', () => {
    const sheets = files.filter(file => file.fileName.endsWith('.css'));
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(text(sheet).replace(/^@charset\s+"[^"]*";/, ''), sheet.fileName).toMatch(/^@layer gl\.tokens,gl\.base,gl\.kit,gl\.components;/);
    }
  });
});

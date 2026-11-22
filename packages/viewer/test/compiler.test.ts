// @vitest-environment node
// packages/viewer/test/compiler.test.ts
// The React Compiler leaves a function it cannot compile as written, and says so nowhere (decision compiled-viewer).
// This runs it over every file under src/ and holds the functions it leaves to the list below, both ways: a function
// that stops compiling fails here, and so does one on the list that compiles now, so the list only ever shrinks.
// Functions are named by file and name (`file:name`), not by line, so the list survives edits around them.
import {readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {transformSync} from '@babel/core';
import {describe, expect, it} from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * What the compiler leaves uncompiled today, with the reason it gives. Remove an entry once its function compiles;
 * add one only with the reason it cannot, and say why in the code it names.
 */
const UNCOMPILED: Record<string, string> = {
  // Read or write a ref during render, to remember something across renders (step 2 of the compiler refactor).
  'components/code/codekit/useFileLines.ts:useFileLines': 'refs during render',
  'components/diagrams/flowkit/Diagram.tsx:Diagram': 'refs during render',
  'components/diagrams/flowkit/Diagram.tsx:Canvas': 'refs during render',
  'components/table/remote.ts:useRemoteRows': 'refs during render',
  'kit/hooks.ts:useCatSlots': 'refs during render',
  'kit/report.ts:useCellReporter': 'refs during render',
  // They call @tanstack/react-virtual, which the compiler marks incompatible.
  'components/code/codekit/VirtualRows.tsx:VirtualRows': '@tanstack/react-virtual',
  'components/table/nav.ts:useListNav': '@tanstack/react-virtual',
};

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, {withFileTypes: true, recursive: true});
  return entries.filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name));
}

/** The name a function is declared under on its first line: `function Name`, `const Name =` or `const Name: T =`. */
function nameAt(line: string | undefined): string {
  const match = /\bfunction\s+(\w+)|\bconst\s+(\w+)\s*[:=]/.exec(line ?? '');
  return match?.[1] ?? match?.[2] ?? `<anonymous>`;
}

/** `file:name` of every function the compiler refuses, with its reason. */
async function uncompiled(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const path of await sourceFiles(src)) {
    const code = readFileSync(path, 'utf8');
    const lines = code.split('\n');
    const file = relative(src, path).split('\\').join('/');
    const logger = {
      logEvent(_filename: string | null, event: {kind: string; fnLoc?: {start: {line: number}} | null; detail?: {reason?: string; options?: {reason?: string}}}) {
        if (event.kind !== 'CompileError') return;
        const line = event.fnLoc?.start.line;
        const key = `${file}:${nameAt(line === undefined ? undefined : lines[line - 1])}`;
        if (!found.has(key)) found.set(key, event.detail?.options?.reason ?? event.detail?.reason ?? 'unknown');
      },
    };
    // The same compiler, with its defaults, as the build's reactCompiler() (vite.config.ts); the logger only listens.
    transformSync(code, {
      filename: path,
      babelrc: false,
      configFile: false,
      parserOpts: {plugins: ['typescript', 'jsx']},
      plugins: [['babel-plugin-react-compiler', {logger}]],
    });
  }
  return found;
}

describe('React Compiler', () => {
  it('compiles every function under src/ but the ones listed, and every listed one is still refused', async () => {
    const found = await uncompiled();
    const added = [...found].filter(([key]) => !(key in UNCOMPILED)).map(([key, reason]) => `${key} (${reason})`);
    const fixed = Object.keys(UNCOMPILED).filter(key => !found.has(key));
    expect(added, 'no longer compiled: make it compile (see decision compiled-viewer), or list it with the reason').toEqual([]);
    expect(fixed, 'compiled now: remove it from UNCOMPILED').toEqual([]);
  });
});

// packages/viewer/test/shell/preload.test.ts - lazy chunks start loading when a message names their components.
import {describe, expect, it, vi} from 'vitest';

const loaded = vi.hoisted(() => [] as string[]);
vi.mock('../../src/components/table/index.ts', () => { loaded.push('table'); return {views: {}}; });
vi.mock('../../src/components/charts/index.ts', () => { loaded.push('charts'); return {views: {}}; });
vi.mock('../../src/components/diagrams/index.ts', () => { loaded.push('diagrams'); return {views: {}}; });
vi.mock('../../src/components/code/index.ts', () => { loaded.push('code'); return {views: {}}; });

const {preloadChunks} = await import('../../src/catalog.ts');
const {createViewerSession} = await import('../../src/shell/session.ts');
const {info, scriptedTransport, snapshot} = await import('./scripted.ts');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('chunk preloading', () => {
  it('loads nothing for eager chunks and unknown names, and each lazy chunk once', async () => {
    preloadChunks(['Page', 'Text', 'Nope', '']);
    await settle();
    expect(loaded).toEqual([]);
    preloadChunks(['DataTable', 'FileTree', 'DataTable']);
    preloadChunks(new Set(['CommitList']));
    await settle();
    expect(loaded).toEqual(['table']);
  });

  it('a frame preloads the chunks of the component types it names, before anything renders', async () => {
    const transport = scriptedTransport();
    const session = createViewerSession(transport);
    const stop = session.start();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', `root=Page('A',[Graph(),Text('x')])`), [a]);
    await settle();
    expect(loaded).toEqual(['table', 'diagrams']);
    transport.frame('a', [{version: '1.0', updateComponents: {surfaceId: 'a', components: [{id: 'c', component: 'CodeBlock', code: 'x'}]}}], [a]);
    await settle();
    expect(loaded).toEqual(['table', 'diagrams', 'code']);
    expect(loaded).not.toContain('charts');
    stop();
  });
});

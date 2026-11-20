// Where a large layout runs (V065, design rule D18): above the sync limits in the worker, never on the main thread;
// after paint when there is no worker or it fails.
import {waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {configureLayoutWorker, type LayoutWorker} from '../../src/components/diagrams/edgekit/index.ts';
import {answer, type LayoutRequest} from '../../src/components/diagrams/edgekit/layout.worker.ts';
import {renderExpress} from '../harness.tsx';
import {bigGraph, nodeIds} from './util.tsx';

const INLINE = `root=Page('T',[g])\ng=Graph($/g,title='Deps',size='l')`;

afterEach(() => configureLayoutWorker(undefined));

describe('useLayout', () => {
  it('lays a graph above the sync limits out in the worker', async () => {
    const asked: LayoutRequest[] = [];
    configureLayoutWorker(() => {
      const worker: LayoutWorker = {
        onmessage: null,
        onerror: null,
        postMessage(request) {
          asked.push(request);
          setTimeout(() => worker.onmessage?.({data: answer(request)}), 0);
        },
      };
      return worker;
    });
    const view = renderExpress(INLINE, {data: {'/g': bigGraph(121, 301)}});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(121), {timeout: 20_000});
    expect(asked).toHaveLength(1);
    expect(asked[0]!.spec.nodes).toHaveLength(121);
    expect(view.cell('g').querySelectorAll('[data-edge]')).toHaveLength(301);
    expect(view.errors).toEqual([]);
  }, 30_000);

  it('lays it out after paint when the worker fails', async () => {
    let made = 0;
    configureLayoutWorker(() => {
      made++;
      const worker: LayoutWorker = {
        onmessage: null,
        onerror: null,
        postMessage() {
          setTimeout(() => worker.onerror?.(new Event('error')), 0);
        },
      };
      return worker;
    });
    const view = renderExpress(INLINE, {data: {'/g': bigGraph(122, 302)}});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(122), {timeout: 20_000});
    expect(made).toBe(1);
    expect(view.cell('g').querySelector('[data-gl-state]')).toBeNull();
  }, 30_000);

  it('keeps small diagrams on the render path, without a worker', async () => {
    let made = 0;
    configureLayoutWorker(() => {
      made++;
      throw new Error('not expected');
    });
    const view = renderExpress(INLINE, {data: {'/g': bigGraph(12, 20)}});
    await waitFor(() => expect(nodeIds(view, 'g')).toHaveLength(12));
    expect(made).toBe(0);
  });
});

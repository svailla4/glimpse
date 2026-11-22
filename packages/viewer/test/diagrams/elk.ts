// An in-process stand-in for the ELK layout worker (jsdom has no Worker). It runs the worker's own answer() with ELK
// in this thread, replying asynchronously as a worker would:
//   beforeEach(() => configureElkWorker(inProcessElk()));
//   afterEach(() => configureElkWorker(undefined));
// Test-only: the page bundle never imports ELK (decision diagram-engine-in-worker), only the worker file does.
import ELK from 'elkjs/lib/elk.bundled.js';
import {answer, type ElkRequest} from '../../src/components/diagrams/flowkit/elk.protocol.ts';
import type {ElkWorker} from '../../src/components/diagrams/flowkit/elk.ts';

export interface InProcessElk extends ElkWorker {
  /** Every request received, in order. */
  readonly requests: ElkRequest[];
  /** Whether terminate() was called. */
  terminated: boolean;
}

export function inProcessElk(): InProcessElk {
  const elk = new ELK();
  const worker: InProcessElk = {
    requests: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(request) {
      // A worker gets a structured clone: the caller's object is never laid out in place.
      const copy = structuredClone(request);
      worker.requests.push(copy);
      void answer(elk, copy).then(reply => {
        if (!worker.terminated) worker.onmessage?.({data: reply});
      });
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

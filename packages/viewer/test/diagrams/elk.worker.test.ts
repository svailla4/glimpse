// @vitest-environment node
// flowkit/elk.worker.ts the way a worker runs it: a global `self` and no `document`. There ELK's engine, when it is
// first evaluated (inside `new ELK()`), points self.onmessage at its own dispatcher, which speaks another protocol;
// the worker module must assign its handler after that, or the page would never get an answer it understands.
import {afterAll, expect, it} from 'vitest';
import type {ElkReply} from '../../src/components/diagrams/flowkit/elk.protocol.ts';

type Handler = (event: {data: unknown}) => unknown;
const replies: unknown[] = [];
/** Every value assigned to self.onmessage, in order. */
const assigned: unknown[] = [];
let handler: Handler | null = null;
const scope = {
  postMessage: (reply: unknown) => void replies.push(reply),
  get onmessage(): Handler | null { return handler; },
  set onmessage(next: Handler | null) {
    assigned.push(next);
    handler = next;
  },
};
const global = globalThis as {self?: unknown};
const before = global.self;
global.self = scope;
afterAll(() => {
  global.self = before;
});

const next = async (count: number): Promise<ElkReply> => {
  for (let i = 0; i < 200 && replies.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return replies[count - 1] as ElkReply;
};

it('replaces the message handler ELK installs, and answers the page protocol', async () => {
  await import('../../src/components/diagrams/flowkit/elk.worker.ts');
  // ELK's dispatcher first (the condition this module guards against really occurs here), then ours, which stays
  expect(assigned).toHaveLength(2);
  expect(typeof assigned[0]).toBe('function');
  expect(scope.onmessage).toBe(assigned[1]);

  scope.onmessage!({data: {id: 7, graph: {id: 'root', children: [{id: 'a', width: 40, height: 20}, {id: 'b', width: 40, height: 20}], edges: [{id: 'e', sources: ['a'], targets: ['b']}]}}});
  const ok = await next(1);
  expect(ok).toMatchObject({id: 7, ok: true});
  if (!ok.ok) throw new Error(ok.error);
  expect(ok.laid.children?.map(child => [child.id, Number.isFinite(child.x), Number.isFinite(child.y)])).toEqual([['a', true, true], ['b', true, true]]);

  scope.onmessage!({data: {id: 8, graph: {id: 'root', edges: [{id: 'e', sources: ['nowhere'], targets: ['b']}]}}});
  const failed = await next(2);
  expect(failed).toMatchObject({id: 8, ok: false});
  expect(failed.ok ? '' : failed.error).toMatch(/nowhere/);
  // one reply per request, nothing from ELK's own dispatcher
  expect(replies).toHaveLength(2);
});

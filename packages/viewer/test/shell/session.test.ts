// packages/viewer/test/shell/session.test.ts - the processor lifecycle of design 2.6 against a scripted transport.
import type {A2uiMessage, EntityRef} from '@glimpse/catalog';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createViewerSession} from '../../src/shell/session.ts';
import {actionsOf, errorsOf, info, scriptedTransport, snapshot} from './scripted.ts';

const V = '1.0' as const;
const PAGE_A = `root=Page('Alpha',[t])\nt=Text('alpha text')`;
const PAGE_B = `root=Page('Beta',[t])\nt=Text('beta text')`;
const file: EntityRef = {type: 'file', id: 'src/a.ts', path: 'src/a.ts'};

function connect(options?: Parameters<typeof createViewerSession>[1]) {
  const transport = scriptedTransport();
  const session = createViewerSession(transport, options);
  const stop = session.start();
  const notified = vi.fn();
  session.subscribe(notified);
  return {transport, session, stop, notified};
}

afterEach(() => vi.useRealTimers());

describe('viewer session', () => {
  it('starts connecting, then follows hello and the replay', () => {
    const {transport, session, notified} = connect();
    expect(session.getSnapshot()).toMatchObject({status: 'connecting', surfaces: [], focus: undefined});
    const a = info('a', 'Alpha');
    const b = info('b', 'Beta');
    transport.status('live');
    transport.hello('e1', [a, b], 'b');
    expect(session.getSnapshot()).toMatchObject({status: 'live', focus: 'b', session: {repo: {name: 'demo'}}});
    expect(session.getSnapshot().surfaces.map(s => s.id)).toEqual(['a', 'b']);
    // listed, but its snapshot has not arrived yet
    expect(session.surface('b')).toBeUndefined();
    transport.frame('a', snapshot('a', PAGE_A), [a, b]);
    transport.frame('b', snapshot('b', PAGE_B), [a, b]);
    expect(session.surface('a')?.id).toBe('a');
    expect(session.surface('b')?.componentsModel.get('root')?.type).toBe('Page');
    expect(session.instance('a')).not.toBe(session.instance('b'));
    expect(notified).toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it('keeps the same snapshot object while nothing changes', () => {
    const {transport, session, notified} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    const before = session.getSnapshot();
    notified.mockClear();
    transport.frame('a', [{version: V, updateDataModel: {surfaceId: 'a', path: '/note', value: 'x'}}], [a]);
    expect(session.getSnapshot()).toBe(before);
    expect(notified).not.toHaveBeenCalled();
    expect(session.surface('a')?.dataModel.get('/note')).toBe('x');
  });

  it('shows the surface the address bar names on the first hello, and the host focus afterwards', () => {
    const {transport, session} = connect({route: 'a'});
    const a = info('a');
    const b = info('b');
    transport.hello('e1', [a, b], 'b');
    expect(session.getSnapshot().focus).toBe('a');
    transport.frame('b', snapshot('b', PAGE_B), [a, b], 'b');
    expect(session.getSnapshot().focus).toBe('b');
  });

  it('ignores a route the host does not know and falls back to the most recently updated surface', () => {
    const {transport, session} = connect({route: 'gone'});
    const a = info('a');
    const b = info('b');
    transport.hello('e1', [a, b]);
    expect(session.getSnapshot().focus).toBe('b');
    session.focus('a');
    expect(session.getSnapshot().focus).toBe('a');
    // the focused surface is deleted: the other one takes over
    transport.frame('a', [{version: V, deleteSurface: {surfaceId: 'a'}}], [b]);
    expect(session.getSnapshot().focus).toBe('b');
  });

  it('a hello with a new epoch disposes the processor and applies the replay', () => {
    const {transport, session} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    const first = session.surface('a');
    const instance = session.instance('a');
    const generation = session.getSnapshot().generation;
    first?.dataModel.set('/ui/sel', file);

    const b = info('b');
    transport.hello('e2', [b], 'b');
    expect(session.surface('a')).toBeUndefined();
    expect(session.getSnapshot().surfaces.map(s => s.id)).toEqual(['b']);
    expect(session.getSnapshot().generation).not.toBe(generation);
    transport.frame('b', snapshot('b', PAGE_B), [b]);
    expect(session.surface('b')).toBeDefined();
    // the same id on a new host is a new surface with nothing carried over
    transport.frame('a', snapshot('a', PAGE_A), [a, b]);
    expect(session.surface('a')).not.toBe(first);
    expect(session.instance('a')).not.toBe(instance);
    expect(session.surface('a')?.dataModel.get('/ui/sel')).toBeNull();
    expect(errorsOf(transport.sent)).toEqual([]);
  });

  it('a reconnect to the same host replaces what it replays, drops what it no longer lists and keeps the tab', () => {
    const {transport, session} = connect();
    const a = info('a');
    const b = info('b');
    transport.hello('e1', [a, b], 'b');
    transport.frame('a', snapshot('a', PAGE_A), [a, b]);
    transport.frame('b', snapshot('b', PAGE_B), [a, b]);
    session.focus('a');
    session.surface('a')?.dataModel.set('/ui/file', 'src/a.ts');
    const before = session.surface('a');

    transport.status('connecting');
    transport.status('live');
    transport.hello('e1', [a], 'b');
    expect(session.surface('b')).toBeUndefined();
    expect(session.getSnapshot().focus).toBe('a');
    transport.frame('a', snapshot('a', `root=Page('Alpha 2',[])`), [a]);
    const after = session.surface('a');
    expect(after).not.toBe(before);
    expect(after?.componentsModel.get('root')?.properties.title).toBe('Alpha 2');
    expect(after?.dataModel.get('/ui/file')).toBe('src/a.ts');
    expect(errorsOf(transport.sent)).toEqual([]);
  });

  it('carries /ui over a delete + create in one frame, unless the new snapshot sets it', () => {
    const {transport, session} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    session.surface('a')?.dataModel.set('/ui', {sel: file, file: 'src/a.ts'});
    const instance = session.instance('a');

    const replace = (messages: A2uiMessage[]): A2uiMessage[] => [{version: V, deleteSurface: {surfaceId: 'a'}}, ...messages];
    transport.frame('a', replace(snapshot('a', PAGE_B)), [a]);
    expect(session.instance('a')).not.toBe(instance);
    expect(session.surface('a')?.componentsModel.get('root')?.properties.title).toBe('Beta');
    expect(session.surface('a')?.dataModel.get('/ui')).toEqual({sel: file, file: 'src/a.ts'});

    // the agent assigned /ui/file in the new snapshot: that wins, nothing is restored
    const assigned = snapshot('a', PAGE_A);
    const create = assigned[0]!;
    if (!('createSurface' in create)) throw new Error('expected a createSurface snapshot');
    create.createSurface.dataModel = {...create.createSurface.dataModel, ui: {sel: null, file: 'src/b.ts'}};
    transport.frame('a', replace(assigned), [a]);
    expect(session.surface('a')?.dataModel.get('/ui')).toEqual({sel: null, file: 'src/b.ts'});

    // a delete in one frame and a create in a later one is a new surface, not a replacement
    transport.frame('a', [{version: V, deleteSurface: {surfaceId: 'a'}}], []);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    expect(session.surface('a')?.dataModel.get('/ui')).toEqual({sel: null, file: null});
  });

  it('forwards rejected messages and render-time errors to the host, each once', async () => {
    const {transport, session} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    const bad: A2uiMessage[] = [
      {version: V, updateComponents: {surfaceId: 'a', components: [{id: 't', component: 'Text', text: 'ok', tone: 'shouting'}]}},
      {version: V, updateDataModel: {surfaceId: 'a', path: '/fine', value: 1}},
    ];
    transport.frame('a', bad, [a]);
    // the valid message of the same frame was still applied
    expect(session.surface('a')?.dataModel.get('/fine')).toBe(1);
    const [error, ...rest] = errorsOf(transport.sent);
    expect(rest).toEqual([]);
    expect(error).toMatchObject({code: 'VALIDATION_FAILED', surfaceId: 'a'});
    expect(error?.message).toContain('Text');
    expect(error?.path).toMatch(/^\/components\/0/);

    // the same mistake again is not posted again
    transport.frame('a', bad, [a]);
    await Promise.resolve();
    expect(errorsOf(transport.sent)).toHaveLength(1);

    // a message for a surface that does not exist is an error of its own
    transport.frame('nope', [{version: V, updateDataModel: {surfaceId: 'nope', path: '/x', value: 1}}], [a]);
    expect(errorsOf(transport.sent)).toHaveLength(2);

    // an error caught by a React boundary goes the same way
    session.report({code: 'E_RENDER', message: 'boom', surfaceId: 'a'});
    session.report({code: 'E_RENDER', message: 'boom', surfaceId: 'a'});
    expect(errorsOf(transport.sent).at(-1)).toEqual({code: 'E_RENDER', message: 'boom', surfaceId: 'a'});
    expect(errorsOf(transport.sent)).toHaveLength(3);
    expect(transport.sent.every(message => message.version === '1.0')).toBe(true);
  });

  it('posts actions as v1.0 action messages and debounces gl_select', async () => {
    vi.useFakeTimers();
    const {transport, session} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    const surface = session.surface('a')!;
    const select = (id: string) => surface.dispatchAction({event: {name: 'gl_select', context: {ref: {type: 'file', id}}}} as never, 't');

    await select('one');
    await select('two');
    vi.advanceTimersByTime(149);
    expect(transport.sent).toEqual([]);
    await select('three');
    vi.advanceTimersByTime(149);
    expect(transport.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(actionsOf(transport.sent)).toHaveLength(1);
    expect(actionsOf(transport.sent)[0]).toMatchObject({name: 'gl_select', surfaceId: 'a', sourceComponentId: 't', context: {ref: {type: 'file', id: 'three'}}});
    expect(typeof actionsOf(transport.sent)[0]?.timestamp).toBe('string');

    // any other action is immediate, and a pending selection is delivered before it
    await select('four');
    await surface.dispatchAction({event: {name: 'gl_open', context: {file: 'src/a.ts#L3'}}} as never, 't');
    expect(actionsOf(transport.sent).map(action => [action.name, action.context])).toEqual([
      ['gl_select', {ref: {type: 'file', id: 'three'}}],
      ['gl_select', {ref: {type: 'file', id: 'four'}}],
      ['gl_open', {file: 'src/a.ts#L3'}],
    ]);
    vi.advanceTimersByTime(500);
    expect(actionsOf(transport.sent)).toHaveLength(3);
  });

  it('close and refresh are host actions from the root component', async () => {
    const {transport, session} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    session.close('a');
    session.refresh('a');
    session.close('missing');
    await Promise.resolve();
    expect(actionsOf(transport.sent).map(action => [action.name, action.surfaceId, action.sourceComponentId, action.context])).toEqual([
      ['gl_close', 'a', 'root', {}],
      ['gl_refresh', 'a', 'root', {}],
    ]);
  });

  it('bye ends the session for good: the last pixels stay, nothing more is posted', async () => {
    vi.useFakeTimers();
    const {transport, session} = connect();
    const a = info('a');
    transport.status('live');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    const surface = session.surface('a')!;
    await surface.dispatchAction({event: {name: 'gl_select', context: {ref: null}}} as never, 't');
    transport.emit({type: 'bye', reason: 'shutdown'});
    expect(session.getSnapshot().status).toBe('ended');
    // the pending selection was delivered on the way out
    expect(actionsOf(transport.sent).map(action => action.name)).toEqual(['gl_select']);
    transport.status('connecting');
    transport.status('live');
    expect(session.getSnapshot().status).toBe('ended');
    expect(session.surface('a')).toBe(surface);
    await surface.dispatchAction({event: {name: 'gl_open', context: {file: 'a.ts'}}} as never, 't');
    vi.advanceTimersByTime(500);
    expect(transport.sent).toHaveLength(1);
  });

  it('survives events that are not what the contract says', () => {
    const {transport, session} = connect();
    expect(() => {
      transport.emit(null as never);
      transport.emit({type: 'surprise'} as never);
      transport.emit({type: 'a2ui', seq: 1, surfaceId: 'a'} as never);
      transport.emit({type: 'hello', v: 1, epoch: 'e1', session: undefined} as never);
    }).not.toThrow();
    expect(session.getSnapshot().surfaces).toEqual([]);
  });

  it('stopping disconnects and disposes; starting again builds a new processor', () => {
    const {transport, session, stop} = connect();
    const a = info('a');
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    stop();
    expect(transport.disconnections).toBe(1);
    expect(session.surface('a')).toBeUndefined();
    const again = session.start();
    transport.hello('e1', [a]);
    transport.frame('a', snapshot('a', PAGE_A), [a]);
    expect(session.surface('a')).toBeDefined();
    expect(errorsOf(transport.sent)).toEqual([]);
    again();
  });
});

// packages/viewer/test/shell/fixture.test.ts - the dev transport replays the gallery like a host would.
import type {LinkStatus, ServerEvent} from '@glimpse/catalog';
import {describe, expect, it} from 'vitest';
import {createViewerSession} from '../../src/shell/session.ts';
import {createFixtureTransport, isFixtureName} from '../../src/transport/fixture.ts';
import {errorsOf} from './scripted.ts';

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
};

describe('FixtureTransport', () => {
  it('knows its fixture names', () => {
    expect(isFixtureName('gallery')).toBe(true);
    expect(isFixtureName('nope')).toBe(false);
    expect(isFixtureName(null)).toBe(false);
  });

  it('sends hello, then one snapshot frame per surface', async () => {
    const transport = createFixtureTransport('gallery');
    const events: ServerEvent[] = [];
    const statuses: LinkStatus[] = [];
    const disconnect = transport.connect(event => void events.push(event), status => void statuses.push(status));
    await until(() => events.length >= 3);
    expect(statuses).toEqual(['connecting', 'live']);
    const [hello, ...frames] = events;
    expect(hello).toMatchObject({type: 'hello', v: 1, focus: 'gallery'});
    expect(hello?.type === 'hello' ? hello.surfaces.map(s => s.id) : []).toEqual(['gallery', 'states']);
    expect(frames.map(frame => (frame.type === 'a2ui' ? [frame.surfaceId, frame.seq] : []))).toEqual([['gallery', 1], ['states', 2]]);
    disconnect();
  });

  it('feeds a session without a single rejected message, answers data requests, and closes surfaces', async () => {
    const transport = createFixtureTransport();
    const session = createViewerSession(transport);
    const stop = session.start();
    await until(() => session.surface('states') !== undefined);
    expect(session.getSnapshot()).toMatchObject({status: 'live', focus: 'gallery'});
    expect(session.surface('gallery')?.componentsModel.get('root')?.type).toBe('Page');
    expect(session.surface('states')?.dataModel.get('/ds/pending')).toMatchObject({status: 'pending'});
    expect(errorsOf(transport.sent)).toEqual([]);

    expect((await transport.file({path: 'README.md'})).path).toBe('README.md');
    expect((await transport.outline('src/a.ts')).path).toBe('src/a.ts');

    session.close('states');
    await until(() => session.surface('states') === undefined);
    expect(session.surface('states')).toBeUndefined();
    expect(session.getSnapshot().surfaces.map(s => s.id)).toEqual(['gallery']);
    stop();
  });

  it('a link closed before the data arrived stays silent', async () => {
    const transport = createFixtureTransport();
    const events: ServerEvent[] = [];
    transport.connect(event => void events.push(event), () => {})();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(events).toEqual([]);
  });
});

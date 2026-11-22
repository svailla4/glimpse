// packages/viewer/test/shell/scripted.ts - a Transport a test drives by hand: it plays the host.
import type {A2uiMessage, ComponentState, LinkStatus, RendererMessage, ServerEvent, SessionInfo, SurfaceInfo, Transport} from '@glimpse/catalog';
import {createFixtureHost} from '@glimpse/catalog/fixtures';
import {buildSurface} from '@glimpse/catalog/testing';

export const SESSION: SessionInfo = {id: 'test', project: 'demo', repo: {name: 'demo', branch: 'main', head: '4f2a91c'}, version: '0.1.0'};

export interface ScriptedTransport extends Transport {
  /** Every A2UI message the viewer posted, in order. */
  sent: RendererMessage[];
  /** Every component state the viewer posted beside them (I_*, OK: decision only-problems-are-errors), in order. */
  states: ComponentState[];
  /** Every component report in the order it was posted: a problem (an A2UI error) or a state, as `Name#id`. */
  reports: Array<{label: string; code: string}>;
  /** How many times connect() was called and how many of those links were closed again. */
  connections: number;
  disconnections: number;
  emit(event: ServerEvent): void;
  status(status: LinkStatus): void;
  /** `hello` for the given surface ids. */
  hello(epoch: string, surfaces: SurfaceInfo[], focus?: string): void;
  /** One `a2ui` frame. */
  frame(surfaceId: string, messages: A2uiMessage[], surfaces: SurfaceInfo[], focus?: string): void;
}

export function scriptedTransport(): ScriptedTransport {
  let onEvent: ((event: ServerEvent) => void) | undefined;
  let onStatus: ((status: LinkStatus) => void) | undefined;
  let seq = 0;
  const transport: ScriptedTransport = {
    ...createFixtureHost(),
    sent: [],
    states: [],
    reports: [],
    connections: 0,
    disconnections: 0,
    connect(event, status) {
      transport.connections++;
      onEvent = event;
      onStatus = status;
      status('connecting');
      return () => {
        transport.disconnections++;
        onEvent = undefined;
        onStatus = undefined;
      };
    },
    send(messages, states = []) {
      transport.sent.push(...messages);
      transport.states.push(...states);
      for (const message of messages) {
        if ('error' in message) transport.reports.push({label: message.error.message.split(':')[0] ?? '', code: message.error.code});
      }
      for (const state of states) transport.reports.push({label: `${state.component}#${state.id}`, code: state.code});
    },
    emit: event => onEvent?.(event),
    status: status => onStatus?.(status),
    hello: (epoch, surfaces, focus) => transport.emit({type: 'hello', v: 1, epoch, session: SESSION, surfaces, focus}),
    frame: (surfaceId, messages, surfaces, focus) => transport.emit({type: 'a2ui', seq: ++seq, surfaceId, messages: structuredClone(messages), surfaces, focus}),
  };
  return transport;
}

let clock = 1000;
export const info = (id: string, title = id): SurfaceInfo => ({id, title, createdAt: ++clock, updatedAt: clock});

/** The snapshot the host sends for a surface: one createSurface built from Express. */
export const snapshot = (id: string, spec: string): A2uiMessage[] => buildSurface(id, spec);

export const actionsOf = (sent: RendererMessage[]) => sent.flatMap(message => ('action' in message ? [message.action] : []));
export const errorsOf = (sent: RendererMessage[]) => sent.flatMap(message => ('error' in message ? [message.error] : []));

/** An in-memory Storage that records writes; `broken` makes every access throw, like a browser that refuses storage. */
export function fakeStorage(initial: Record<string, string> = {}, broken = false) {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  return {
    values,
    writes,
    getItem(key: string) {
      if (broken) throw new Error('storage is disabled');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (broken) throw new Error('storage is disabled');
      values.set(key, value);
      writes.push([key, value]);
    },
  };
}

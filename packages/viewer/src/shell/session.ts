// packages/viewer/src/shell/session.ts
// The viewer's side of a session (design 2.6, 2.7), with no React and no DOM in it: one MessageProcessor per host
// epoch, fed by a Transport. It owns the rules the wire protocol leaves to the viewer:
//   - a `hello` with a new epoch disposes the processor; the replay that follows rebuilds every surface;
//   - a snapshot for a surface that already exists replaces it, and `/ui` (selection, followed file) is carried over
//     a delete + create unless the new snapshot sets it;
//   - messages the processor rejects, and errors raised while rendering, go back to the host as v1.0 `error` messages;
//   - so does every state a component shows instead of its content (a redline, an empty plate), once per surface
//     instance, so the host can tell the agent what its view really looks like (design rule D3);
//   - actions go back as v1.0 `action` messages, `gl_select` debounced so that dragging a selection does not flood;
//   - the lazy chunks of the component types a message names start loading before React asks for them.
import type {ReactCatalogComponent} from '@a2ui/react';
import {MessageProcessor, type SurfaceModel} from '@a2ui/web_core/v1_0';
import {
  PATHS, type A2uiMessage, type ActionPayload, type DataClient, type LinkStatus, type RendererMessage, type ServerEvent, type SessionInfo,
  type SurfaceInfo, type Transport,
} from '@glimpse/catalog';
import {createGlimpseCatalog, preloadChunks} from '../catalog.ts';
import {kitSlots, type RenderReport} from '../kit/index.ts';
import type {LinkEnd} from '../transport/hub.ts';

export type Surface = SurfaceModel<ReactCatalogComponent>;

export interface SessionSnapshot {
  status: LinkStatus;
  session: SessionInfo | undefined;
  /** Surfaces of the session in the order they were created: the tabs. */
  surfaces: readonly SurfaceInfo[];
  /** Id of the surface to show; undefined while there is none. */
  focus: string | undefined;
  /** Changes whenever a surface object is created or deleted, so a renderer reads surface() again. */
  generation: number;
  /** Why the link ended, when the transport knows (status 'ended' only). */
  end?: LinkEnd;
}

export interface ViewerSession {
  /** Everything a view fetches outside the data model. */
  readonly host: DataClient;
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Connects the transport; the result disconnects and disposes the processor. */
  start(): () => void;
  /** The live model of a surface, once its snapshot has arrived. */
  surface(id: string): Surface | undefined;
  /** A number that changes each time the surface is created again: a React key for its tree. */
  instance(id: string): number;
  /** Shows a surface (a tab click, `[` and `]`, the address bar). */
  focus(id: string): void;
  /** Asks the host to delete a surface. */
  close(id: string): void;
  /** Asks the host to run every dataset of a surface again. */
  refresh(id: string): void;
  /** Reports an error the renderer caught (an error boundary) to the host. */
  report(error: {code: string; message: string; surfaceId?: string}): void;
  /**
   * Reports a state a component shows instead of its content (KitProvider `report`). Each distinct report is sent
   * once for as long as the surface object lives; a surface that is created again starts over, because the host
   * drops what it knew about a surface it replaces.
   */
  reportState(report: RenderReport): void;
  /** Clears the selection of a surface (Escape with the focus on the page). Does nothing when nothing is selected. */
  clearSelection(id: string): void;
}

export interface SessionOptions {
  /** Surface to show first when the host knows it: the `#/<surfaceId>` the tab was opened or reloaded on. */
  route?: string;
  /** Trailing debounce of gl_select, in ms. */
  selectDelay?: number;
}

/** The viewer is lenient: messages may arrive in any order. Strictness lives in the server (design 2.6). */
const VIEWER_VALIDATION = {allowUnknownElements: false, allowDanglingReferences: true, allowOrphanComponents: true, allowMissingRoot: true};
const V = '1.0' as const;
const SELECT_DELAY = 150;
/** Distinct errors forwarded per epoch; a broken view must not turn into a stream of posts. */
const MAX_REPORTED = 100;
/** Distinct component states forwarded per surface instance. */
const MAX_STATES = 200;
const UI_PATH = '/ui';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasValue = (ui: unknown) => isRecord(ui) && Object.values(ui).some(value => value !== null && value !== undefined);

function componentTypes(messages: readonly A2uiMessage[]): Set<string> {
  const types = new Set<string>();
  for (const message of messages) {
    const components = 'createSurface' in message ? message.createSurface.components : 'updateComponents' in message ? message.updateComponents.components : undefined;
    if (!Array.isArray(components)) continue;
    for (const component of components) if (typeof component?.component === 'string') types.add(component.component);
  }
  return types;
}

export function createViewerSession(transport: Transport, options: SessionOptions = {}): ViewerSession {
  const listeners = new Set<() => void>();
  const instances = new Map<string, number>();
  const pendingSelect = new Map<string, ActionPayload>();
  const reported = new Set<string>();
  /** Component states already sent, per surface id; forgotten when the surface object is created again. */
  const states = new Map<string, Set<string>>();
  const selectDelay = options.selectDelay ?? SELECT_DELAY;
  let snapshot: SessionSnapshot = {status: 'connecting', session: undefined, surfaces: [], focus: undefined, generation: 0};
  let processor: MessageProcessor<ReactCatalogComponent> | undefined;
  let subscriptions: Array<{unsubscribe(): void}> = [];
  let epoch: string | undefined;
  /** What the person or the host last asked to see; `snapshot.focus` is the surface that can actually be shown. */
  let wanted: string | undefined = options.route;
  let created = 0;
  /** Counts surface objects coming and going; published as `generation`. */
  let shape = 0;
  let applying = false;
  let greeted = false;
  let selectTimer: ReturnType<typeof setTimeout> | undefined;

  const update = (patch: Partial<SessionSnapshot>) => {
    const next = {...snapshot, ...patch, generation: shape};
    next.surfaces = [...next.surfaces].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const known = next.surfaces.some(info => info.id === wanted);
    // Fall back to the most recently updated surface when the wanted one does not (or no longer) exist.
    next.focus = known ? wanted : [...next.surfaces].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
    const same =
      next.status === snapshot.status && next.end === snapshot.end && next.session === snapshot.session && next.focus === snapshot.focus && next.generation === snapshot.generation &&
      next.surfaces.length === snapshot.surfaces.length &&
      next.surfaces.every((info, i) => {
        const before = snapshot.surfaces[i];
        return before !== undefined && before.id === info.id && before.title === info.title && before.view === info.view && before.updatedAt === info.updatedAt;
      });
    if (same) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const post = (messages: RendererMessage[]) => {
    if (messages.length > 0 && snapshot.status !== 'ended') transport.send(messages);
  };

  const flushSelect = () => {
    if (selectTimer !== undefined) clearTimeout(selectTimer);
    selectTimer = undefined;
    const actions = [...pendingSelect.values()];
    pendingSelect.clear();
    post(actions.map(action => ({version: V, action})));
  };

  const onAction = (raw: ActionPayload) => {
    // Only the fields of the v1.0 action message leave the tab.
    const action: ActionPayload = {
      name: raw.name, surfaceId: raw.surfaceId, sourceComponentId: raw.sourceComponentId, timestamp: raw.timestamp,
      context: isRecord(raw.context) ? raw.context : {},
      ...(typeof raw.userMessage === 'string' ? {userMessage: raw.userMessage} : {}),
    };
    if (action.name === 'gl_select') {
      pendingSelect.set(action.surfaceId, action);
      if (selectTimer !== undefined) clearTimeout(selectTimer);
      selectTimer = setTimeout(flushSelect, selectDelay);
      return;
    }
    // Whatever was selected is part of what the next action means: deliver it first.
    flushSelect();
    post([{version: V, action}]);
  };

  /** Each distinct error is sent once per epoch: the processor announces a rejected message on two channels. */
  const report = (error: {code: string; message: string; surfaceId?: string; path?: string}) => {
    const key = `${error.code}\n${error.surfaceId ?? ''}\n${error.message}`;
    if (reported.has(key) || reported.size >= MAX_REPORTED) return;
    reported.add(key);
    post([{
      version: V,
      error: {code: error.code, message: error.message, ...(error.surfaceId ? {surfaceId: error.surfaceId} : {}), ...(error.path ? {path: error.path} : {})},
    }]);
  };

  const reportState = (state: RenderReport) => {
    if (!processor?.getSurface(state.surfaceId)) return;
    const sent = states.get(state.surfaceId) ?? new Set<string>();
    states.set(state.surfaceId, sent);
    const key = `${state.code}\n${state.message}`;
    if (sent.has(key) || sent.size >= MAX_STATES) return;
    sent.add(key);
    post([{version: V, error: {code: state.code, message: state.message, surfaceId: state.surfaceId}}]);
  };

  const dispose = () => {
    for (const subscription of subscriptions) subscription.unsubscribe();
    subscriptions = [];
    if (selectTimer !== undefined) clearTimeout(selectTimer);
    selectTimer = undefined;
    pendingSelect.clear();
    reported.clear();
    states.clear();
    instances.clear();
    processor?.model.dispose();
    processor?.dispose();
    processor = undefined;
    shape++;
  };

  const ensure = (): MessageProcessor<ReactCatalogComponent> => {
    if (processor) return processor;
    // A fresh catalog per processor: A2uiSurface mutates the catalog it renders.
    const next = new MessageProcessor<ReactCatalogComponent>([createGlimpseCatalog(kitSlots)], action => onAction(action as ActionPayload), {
      validationConfig: VIEWER_VALIDATION,
    });
    subscriptions = [
      next.onSurfaceCreated(surface => {
        instances.set(surface.id, ++created);
        states.delete(surface.id);
        shape++;
      }),
      next.onSurfaceDeleted(id => {
        instances.delete(id);
        states.delete(id);
        shape++;
      }),
      // Processing errors come back from processMessagesWithErrors (with their path); this catches the rest:
      // unknown component types, unresolved children and expression errors found while rendering.
      next.model.onError.subscribe(error => { if (!applying) report({code: String(error.code), message: String(error.message), surfaceId: error.surfaceId}); }),
    ];
    processor = next;
    return next;
  };

  /** Applies the messages of one frame, in order. */
  const apply = (messages: readonly A2uiMessage[]) => {
    if (messages.length === 0) return;
    const target = ensure();
    const alive = new Set(target.model.surfacesMap.keys());
    const carried = new Map<string, unknown>();
    const batch: A2uiMessage[] = [];
    const keepUi = (id: string) => {
      if (carried.has(id)) return;
      const ui: unknown = target.getSurface(id)?.dataModel.get(UI_PATH);
      if (hasValue(ui)) carried.set(id, structuredClone(ui));
    };
    for (const message of messages) {
      if ('deleteSurface' in message) {
        const id = message.deleteSurface.surfaceId;
        if (alive.delete(id)) keepUi(id);
      } else if ('createSurface' in message) {
        const id = message.createSurface.surfaceId;
        // A snapshot of a surface this tab already shows (a reconnect to the same host): replace it.
        if (alive.has(id)) {
          keepUi(id);
          batch.push({version: V, deleteSurface: {surfaceId: id}});
        }
        alive.add(id);
      }
      batch.push(message);
    }
    preloadChunks(componentTypes(batch));

    applying = true;
    let rejected: ReturnType<MessageProcessor['processMessagesWithErrors']>;
    try {
      rejected = target.processMessagesWithErrors(batch);
    } finally {
      applying = false;
    }
    for (const [id, ui] of carried) {
      const model = target.getSurface(id)?.dataModel;
      if (model && !hasValue(model.get(UI_PATH))) model.set(UI_PATH, ui);
    }
    for (const {error} of rejected) {
      report({
        code: String(error.code), message: String(error.message),
        ...(typeof error.surfaceId === 'string' ? {surfaceId: error.surfaceId} : {}),
        ...(typeof error.path === 'string' ? {path: error.path} : {}),
      });
    }
  };

  const onEvent = (event: ServerEvent) => {
    if (!isRecord(event)) return;
    switch (event.type) {
      case 'hello': {
        const surfaces = Array.isArray(event.surfaces) ? event.surfaces : [];
        const restarted = event.epoch !== epoch;
        if (restarted) {
          dispose();
          epoch = event.epoch;
        } else if (processor) {
          // The same host on a new connection replays every live surface; what it no longer lists is gone.
          const listed = new Set(surfaces.map(info => info.id));
          apply([...processor.model.surfacesMap.keys()].filter(id => !listed.has(id)).map(surfaceId => ({version: V, deleteSurface: {surfaceId}})));
        }
        // A new host says what to show, except on the first hello when the address bar names a surface it has (a
        // reload stays where it was). A reconnect to the same host leaves the person on the tab they chose.
        const routed = !greeted && wanted !== undefined && surfaces.some(info => info.id === wanted);
        if (restarted && !routed && event.focus) wanted = event.focus;
        greeted = true;
        update({session: event.session, surfaces});
        break;
      }
      case 'a2ui': {
        apply(Array.isArray(event.messages) ? event.messages : []);
        if (event.focus) wanted = event.focus;
        update({surfaces: Array.isArray(event.surfaces) ? event.surfaces : snapshot.surfaces});
        break;
      }
      case 'bye':
        flushSelect();
        update({status: 'ended'});
        break;
      default:
        break;
    }
  };

  const onStatus = (status: LinkStatus) => {
    // Ended is final: a host that said goodbye does not come back under the same token.
    if (snapshot.status === 'ended' || snapshot.status === status) return;
    if (status === 'ended') {
      flushSelect();
      const end = (transport as Partial<{linkEnd(): LinkEnd | undefined}>).linkEnd?.();
      update(end ? {status, end} : {status});
      return;
    }
    update({status});
  };

  const act = (name: string, id: string) => {
    const surface = processor?.getSurface(id);
    // The shell is the source: the root component stands in for it (transport.ts, gl_close).
    if (surface) void surface.dispatchAction({event: {name, context: {}}} as never, 'root');
  };

  return {
    host: transport,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      const disconnect = transport.connect(onEvent, onStatus);
      return () => {
        disconnect();
        flushSelect();
        dispose();
        epoch = undefined;
      };
    },
    surface: id => processor?.getSurface(id),
    instance: id => instances.get(id) ?? 0,
    focus(id) {
      if (wanted === id && snapshot.focus === id) return;
      wanted = id;
      update({});
    },
    close: id => act('gl_close', id),
    refresh: id => act('gl_refresh', id),
    report,
    reportState,
    clearSelection(id) {
      const surface = processor?.getSurface(id);
      if (!surface || surface.dataModel.get(PATHS.uiSel) == null) return;
      surface.dataModel.set(PATHS.uiSel, null);
      void surface.dispatchAction({event: {name: 'gl_select', context: {ref: null}}} as never, 'root');
    },
  };
}

/** The repository a surface describes (`/meta/repo/name`), part of the key its arrangement is stored under. */
export function surfaceRepoName(surface: Surface | undefined): string | undefined {
  const meta: unknown = surface?.dataModel.get(PATHS.meta);
  const repo = isRecord(meta) ? meta.repo : undefined;
  return isRecord(repo) && typeof repo.name === 'string' ? repo.name : undefined;
}

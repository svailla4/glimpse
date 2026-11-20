// packages/viewer/src/transport/fixture.ts
// A Transport with no server behind it, for the dev harness (`?fixture=gallery`) and for looking at components
// while they are built: it replays canned surfaces and answers data requests from the FixtureHost. The fixture data
// is loaded with dynamic imports, so none of it is in the eager bundle.
import type {A2uiMessage, LinkStatus, RendererMessage, ServerEvent, SurfaceInfo, Transport} from '@glimpse/catalog';
import {CATALOG_ID} from '@glimpse/catalog';
import type {FixtureHost} from '@glimpse/catalog/fixtures';

export const FIXTURE_NAMES = ['gallery'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export const isFixtureName = (name: string | null | undefined): name is FixtureName => FIXTURE_NAMES.includes(name as FixtureName);

interface FixtureData {
  host: FixtureHost;
  /** The snapshot of each surface: one createSurface message, as the host would replay it. */
  surfaces: Array<{id: string; title: string; view?: string; messages: A2uiMessage[]}>;
}

const V = '1.0' as const;

/**
 * The three states every component shares, on a second surface: datasets that are pending, failed and empty, and a
 * binding that points at nothing. It also gives the shell a second tab to switch to.
 */
function statesSurface(meta: unknown, datasets: {pending: unknown; error: unknown; empty: unknown}): A2uiMessage {
  return {
    version: V,
    createSurface: {
      surfaceId: 'states',
      catalogId: CATALOG_ID,
      components: [
        {id: 'root', component: 'Page', title: 'States', subtitle: 'drafting, empty, redline', children: ['pending', 'failed', 'empty', 'unbound', 'notes']},
        {id: 'pending', component: 'DataTable', data: {'@path': '/ds/pending'}, title: 'Pending dataset', size: 's', span: 6},
        {id: 'failed', component: 'DataTable', data: {'@path': '/ds/failed'}, title: 'Failed dataset', size: 's', span: 6},
        {id: 'empty', component: 'BarChart', data: {'@path': '/ds/empty'}, title: 'Empty dataset', size: 's', span: 6},
        {id: 'unbound', component: 'Steps', data: {'@path': '/nothing/here'}, title: 'Nothing bound', span: 6},
        {id: 'notes', component: 'Plate', title: 'A plate that starts collapsed', collapsed: true, children: ['note']},
        {id: 'note', component: 'Text', text: 'Double-click a plate header, or use its chevron, to collapse and expand it.'},
      ],
      dataModel: {ds: {pending: datasets.pending, failed: datasets.error, empty: datasets.empty}, ui: {sel: null, file: null}, meta},
    },
  };
}

async function load(name: FixtureName): Promise<FixtureData> {
  const [{createFixtureHost, pendingDataset, errorDataset, datasetFixture}, wire] = await Promise.all([
    import('@glimpse/catalog/fixtures'),
    import('@glimpse/catalog/fixtures/gallery.wire.json'),
  ]);
  const gallery = structuredClone(wire.default) as A2uiMessage[];
  const first = gallery.find(message => 'createSurface' in message);
  const meta = first && 'createSurface' in first ? first.createSurface.dataModel?.meta : undefined;
  const empty = {...datasetFixture('deps.cycles'), data: [], total: 0};
  const states = statesSurface(structuredClone(meta), {
    pending: {...pendingDataset('git.hotspots top=15', 'reading git log · 3,412 commits'), $ds: 'pending'},
    error: {...errorDataset('git.churn', 'E_NO_GIT', 'not a git repository'), $ds: 'failed'},
    empty: {...empty, $ds: 'empty'},
  });
  return {
    host: createFixtureHost(),
    surfaces: [
      {id: name, title: 'Gallery', view: 'gallery', messages: gallery},
      {id: 'states', title: 'States', messages: [states]},
    ],
  };
}

/**
 * Replays the fixture as a host would: `hello`, then one snapshot frame per surface. `gl_close` deletes the surface,
 * like the server does; every other action is kept in `sent` for inspection from the console.
 */
export function createFixtureTransport(name: FixtureName = 'gallery'): Transport & {sent: RendererMessage[]} {
  const data = load(name);
  const sent: RendererMessage[] = [];
  let emit: ((event: ServerEvent) => void) | undefined;
  let infos: SurfaceInfo[] = [];
  let seq = 0;
  const host = <K extends keyof FixtureHost>(method: K) =>
    (async (...args: unknown[]) => ((await data).host[method] as (...a: unknown[]) => unknown)(...args)) as unknown as FixtureHost[K];

  return {
    sent,
    rows: host('rows'),
    file: host('file'),
    diff: host('diff'),
    highlight: host('highlight'),
    outline: host('outline'),
    connect(onEvent: (event: ServerEvent) => void, onStatus: (status: LinkStatus) => void): () => void {
      let open = true;
      onStatus('connecting');
      void data.then(
        ({surfaces}) => {
          if (!open) return;
          emit = onEvent;
          const now = Date.now();
          infos = surfaces.map((surface, index) => ({id: surface.id, title: surface.title, view: surface.view, createdAt: now + index, updatedAt: now + index}));
          onStatus('live');
          onEvent({
            type: 'hello', v: 1, epoch: `fixture-${name}`,
            session: {id: 'fixture', project: 'demo', repo: {name: 'demo', branch: 'main', head: '4f2a91c'}, version: '0.0.0'},
            surfaces: infos, focus: name,
          });
          for (const surface of surfaces) {
            onEvent({type: 'a2ui', seq: ++seq, surfaceId: surface.id, messages: structuredClone(surface.messages), surfaces: infos});
          }
        },
        () => { if (open) onStatus('ended'); },
      );
      return () => {
        open = false;
        emit = undefined;
      };
    },
    send(messages: RendererMessage[]): void {
      sent.push(...messages);
      for (const message of messages) {
        if (!('action' in message) || message.action.name !== 'gl_close') continue;
        const {surfaceId} = message.action;
        infos = infos.filter(info => info.id !== surfaceId);
        emit?.({type: 'a2ui', seq: ++seq, surfaceId, messages: [{version: V, deleteSurface: {surfaceId}}], surfaces: infos});
      }
    },
  };
}

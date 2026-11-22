// packages/viewer/src/transport/hub.ts
// The live link to the Glimpse host over loopback HTTP (design 2.5): server events arrive on one EventSource
// (`GET /api/events?t=<token>`, frames named `glimpse`), everything else is fetch with the bearer token.
import type {
  ComponentState, DataClient, DiffPayload, DiffQuery, FileQuery, FileSlice, Health, HighlightResult, LinkStatus, OutlineResult, RendererMessage,
  RowsPage, RowsQuery, ServerEvent, Transport,
} from '@glimpse/catalog';

/**
 * Why the link ended, for the message the shell shows:
 *   closed        the host said goodbye, or the stream was lost for good after it had been live
 *   refused       the host is running and the token is right, but it would not open a stream: it already serves as
 *                 many viewer tabs as it allows (`tabs` of them)
 *   unauthorized  the host is running a session this tab's token does not belong to
 *   unreachable   no host answered at all
 */
export type LinkEnd = {reason: 'closed' | 'unauthorized' | 'unreachable'} | {reason: 'refused'; tabs?: number};

/** A Transport that can say why it ended. The viewer session asks through `linkEnd` when the status turns 'ended'. */
export interface HubTransport extends Transport {
  /** undefined while the link has not ended. */
  linkEnd(): LinkEnd | undefined;
}

export interface HubOptions {
  token: string;
  /** Origin of the host; '' (the default) is the origin the viewer was served from. */
  base?: string;
  /** Injected in tests. */
  EventSource?: typeof EventSource;
  fetch?: typeof fetch;
}

/** After this many failed reconnects in a row the session is taken to be over (the host dies with the session). */
const MAX_RETRIES = 5;

type Params = Record<string, string | number | undefined>;

function query(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** The host's error text when it sent one ({error: {message}} or {message}), else the status line. */
async function failure(response: Response): Promise<Error> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    const error = (body as {error?: unknown}).error;
    const message = typeof error === 'string' ? error : ((error as {message?: unknown} | undefined)?.message ?? (body as {message?: unknown}).message);
    if (typeof message === 'string') detail = message;
  } catch {
    // not JSON: the status is all there is
  }
  return new Error(detail || `host answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
}

export function createHubTransport(options: HubOptions): HubTransport {
  const {token} = options;
  const base = options.base ?? '';
  const Source = options.EventSource ?? globalThis.EventSource;
  const request: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const authorization = `Bearer ${token}`;
  let ended = false;
  let linkEnd: LinkEnd | undefined;

  /**
   * A stream the host refused before it ever opened says nothing about why (EventSource hides the status). The
   * health endpoint does: it answers this token when the host is up and the session is ours.
   */
  async function whyRefused(): Promise<LinkEnd> {
    try {
      const response = await request(`${base}/api/health`, {headers: {authorization, accept: 'application/json'}, cache: 'no-store'});
      if (response.status === 401 || response.status === 403) return {reason: 'unauthorized'};
      if (!response.ok) return {reason: 'unreachable'};
      const health = (await response.json().catch(() => undefined)) as Partial<Health> | undefined;
      return typeof health?.tabs === 'number' ? {reason: 'refused', tabs: health.tabs} : {reason: 'refused'};
    } catch {
      return {reason: 'unreachable'};
    }
  }

  async function get<T>(path: string, params: Params, signal?: AbortSignal): Promise<T> {
    const response = await request(`${base}${path}${query(params)}`, {headers: {authorization, accept: 'application/json'}, signal, cache: 'no-store'});
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }
  async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await request(`${base}${path}`, {
      method: 'POST',
      headers: {authorization, accept: 'application/json', 'content-type': 'application/json'},
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  const client: DataClient = {
    rows: (q: RowsQuery, signal) =>
      get<RowsPage>(`/api/ds/${encodeURIComponent(q.surfaceId)}/${encodeURIComponent(q.key)}/rows`, {offset: q.offset, limit: q.limit, sort: q.sort, q: q.q}, signal),
    file: (q: FileQuery, signal) => get<FileSlice>('/api/file', {path: q.path, start: q.start, end: q.end}, signal),
    diff: (q: DiffQuery, signal) => get<DiffPayload>('/api/diff', {range: q.range, path: q.path}, signal),
    highlight: (code, lang, signal) => post<HighlightResult>('/api/highlight', lang === undefined ? {code} : {code, lang}, signal),
    outline: (path, signal) => get<OutlineResult>('/api/outline', {path}, signal),
  };

  return {
    ...client,
    connect(onEvent: (event: ServerEvent) => void, onStatus: (status: LinkStatus) => void): () => void {
      if (typeof Source !== 'function') {
        onStatus('ended');
        return () => {};
      }
      let failures = 0;
      let closed = false;
      let opened = false;
      onStatus('connecting');
      const source = new Source(`${base}/api/events?t=${encodeURIComponent(token)}`);
      const end = (why: LinkEnd) => {
        if (ended) return;
        ended = true;
        linkEnd = why;
        source.close();
        if (!closed) onStatus('ended');
      };
      source.onopen = () => {
        failures = 0;
        opened = true;
        if (!closed) onStatus('live');
      };
      source.onerror = () => {
        if (closed || ended) return;
        failures++;
        // CLOSED: the host refused the stream (wrong token, too many tabs, gone for good). Otherwise the browser is retrying.
        if (source.readyState === 2 && !opened) {
          source.close();
          void whyRefused().then(why => { if (!closed) end(why); });
        } else if (source.readyState === 2 || failures >= MAX_RETRIES) end({reason: opened ? 'closed' : 'unreachable'});
        else onStatus('connecting');
      };
      source.addEventListener('glimpse', (message: MessageEvent<string>) => {
        if (closed) return;
        let event: ServerEvent;
        try {
          event = JSON.parse(message.data) as ServerEvent;
        } catch {
          return;
        }
        if (event === null || typeof event !== 'object') return;
        onEvent(event);
        if (event.type === 'bye') end({reason: 'closed'});
      });
      return () => {
        closed = true;
        source.close();
      };
    },
    linkEnd: () => linkEnd,
    send(messages: RendererMessage[], states?: ComponentState[]): void {
      if (ended || (messages.length === 0 && !states?.length)) return;
      // Fire and forget: an action that cannot be delivered has nobody to report to. keepalive lets a post that
      // was made while the tab is closing still reach the host.
      void request(`${base}/api/renderer`, {
        method: 'POST',
        headers: {authorization, 'content-type': 'application/json'},
        body: JSON.stringify(states?.length ? {messages, states} : {messages}),
        keepalive: true,
      }).catch(() => {});
    },
  };
}

// The SSE side of the host (design 2.5): every frame is `event: glimpse` + `data: <ServerEvent JSON>`. A tab that
// connects gets `hello`, then one snapshot frame per surface, then live frames, all in one synchronous write so no
// live frame can slip in between.
import type {ServerResponse} from 'node:http';
import type {A2uiMessage, ServerEvent, SessionInfo, SurfaceInfo} from '@glimpse/catalog';

export const MAX_CLIENTS = 8;
const KEEPALIVE_MS = 15_000;
const RETRY_MS = 1000;
const MAX_BACKLOG = 32 * 1024 * 1024;

export interface SseSource {
  epoch: string;
  session(): SessionInfo;
  surfaces(): SurfaceInfo[];
  replay(): Array<{surfaceId: string; messages: A2uiMessage[]}>;
  /** Called with the number of connected tabs whenever it changes. */
  tabsChanged(count: number): void;
}

export class SseHub {
  private clients = new Set<ServerResponse>();
  private seq = 0;
  private focus: string | undefined;
  private source: SseSource;
  private keepalive: NodeJS.Timeout;

  constructor(source: SseSource) {
    this.source = source;
    this.keepalive = setInterval(() => {
      for (const client of this.clients) client.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    this.keepalive.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  private send(client: ServerResponse, event: ServerEvent): void {
    client.write(`event: glimpse\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** Takes over a response as an event stream. Returns false (and answers 503) when eight tabs are connected. */
  connect(res: ServerResponse): boolean {
    if (this.clients.size >= MAX_CLIENTS) {
      res.writeHead(503, {'content-type': 'text/plain; charset=utf-8', 'retry-after': '5'});
      res.end('too many viewer tabs');
      return false;
    }
    res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no'});
    res.write(`retry: ${RETRY_MS}\n\n`);
    const surfaces = this.source.surfaces();
    const focus = this.focus !== undefined && surfaces.some(s => s.id === this.focus) ? this.focus : undefined;
    this.send(res, {type: 'hello', v: 1, epoch: this.source.epoch, session: this.source.session(), surfaces, ...(focus ? {focus} : {})});
    for (const frame of this.source.replay()) {
      this.send(res, {type: 'a2ui', seq: ++this.seq, surfaceId: frame.surfaceId, messages: frame.messages, surfaces});
    }
    this.clients.add(res);
    res.on('close', () => {
      if (this.clients.delete(res)) this.source.tabsChanged(this.clients.size);
    });
    this.source.tabsChanged(this.clients.size);
    return true;
  }

  /** One live frame to every tab. `focus` is remembered, so a tab that connects later opens on that surface. */
  publish(surfaceId: string, messages: A2uiMessage[], focus?: string): void {
    if (focus !== undefined) this.focus = focus;
    if (messages.length === 0 || this.clients.size === 0) return;
    const event: ServerEvent = {type: 'a2ui', seq: ++this.seq, surfaceId, messages, surfaces: this.source.surfaces(), ...(focus !== undefined ? {focus} : {})};
    const frame = `event: glimpse\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      // A tab that stopped reading is cut loose; EventSource reconnects and gets a fresh replay.
      if (client.writableLength > MAX_BACKLOG) client.destroy();
      else client.write(frame);
    }
  }

  /** Says goodbye and ends every stream. */
  close(): void {
    clearInterval(this.keepalive);
    for (const client of this.clients) {
      this.send(client, {type: 'bye', reason: 'shutdown'});
      client.end();
    }
    this.clients.clear();
  }
}

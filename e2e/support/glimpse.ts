// The harness of the end-to-end suite: the real bundled server (server.mjs next to its viewer) spawned over stdio and
// driven through the MCP SDK client, a watched Playwright page on its loopback viewer, raw HTTP for the guard matrix,
// and a recorder for the timings the design asks for.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {request, type IncomingHttpHeaders} from 'node:http';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {expect, type Page, type Worker} from '@playwright/test';
import {BUNDLE, TIMINGS_FILE} from './paths.ts';

export const TOKEN = 'e2e-token';

export interface Called {
  text: string;
  lines: string[];
  isError: boolean;
  /** Wall-clock time of the tool call, as the client saw it. */
  ms: number;
}

export interface Glimpse {
  client: Client;
  pid: number | null;
  /** Calls a tool and returns its single text block. */
  call(name: string, args?: Record<string, unknown>): Promise<Called>;
  /** Port of the viewer host, known after the first `show`. */
  port(): number;
  url(path?: string): string;
  stderr(): string;
  /** Closes the MCP client (stdin of the server). Safe to call twice. */
  close(): Promise<void>;
  /** True once the server process is gone; waits up to `timeoutMs`. */
  exited(timeoutMs?: number): Promise<boolean>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts `node <dist>/server.mjs` for `projectDir` exactly as the design's step 2 says: no browser, an ephemeral
 * port and a fixed token. The environment is not inherited; only PATH and HOME (for git) pass through.
 */
export async function startGlimpse(projectDir: string, env: Record<string, string> = {}): Promise<Glimpse> {
  if (!existsSync(BUNDLE)) throw new Error(`no bundle at ${BUNDLE}; run node scripts/build.mjs (or set GLIMPSE_DIST)`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE],
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.HOME ? {HOME: process.env.HOME} : {}),
      CLAUDE_PROJECT_DIR: projectDir,
      GLIMPSE_NO_OPEN: '1',
      GLIMPSE_PORT: '0',
      GLIMPSE_TOKEN: TOKEN,
      ...env,
    },
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({name: 'glimpse-e2e', version: '0.0.0'}, {versionNegotiation: {mode: 'auto'}});
  await client.connect(transport);
  const pid = transport.pid;
  let port = 0;
  let closed = false;
  const currentPort = () => {
    if (!port) throw new Error('the viewer host has not started yet: call show first');
    return port;
  };

  return {
    client,
    pid,
    async call(name, args = {}) {
      const started = performance.now();
      const result = await client.callTool({name, arguments: args}) as {content: Array<{type: string; text?: string}>; isError?: boolean};
      const ms = Math.round(performance.now() - started);
      const text = result.content.map(block => block.text ?? '').join('\n');
      const found = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(text);
      if (found) port = Number(found[1]);
      return {text, lines: text.split('\n'), isError: result.isError === true, ms};
    },
    port: currentPort,
    url: (path = `/#t=${TOKEN}`) => `http://127.0.0.1:${currentPort()}${path}`,
    stderr: () => stderr,
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
    },
    async exited(timeoutMs = 3000) {
      if (pid === null) return true;
      const deadline = Date.now() + timeoutMs;
      while (alive(pid)) {
        if (Date.now() > deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return true;
    },
  };
}

export interface Watch {
  /** Console errors (of the page and of its workers), uncaught page errors and failed or off-host requests, in order. */
  problems: string[];
  /**
   * `securitypolicyviolation` events seen so far by the page and by its dedicated workers (the ELK layout worker runs
   * under a CSP of its own, its script's response header, and reports there, not to the page).
   */
  csp(): Promise<string[]>;
  /** Every request URL the page made. */
  requests: string[];
}

/** Call before the first navigation: records everything that would mean the viewer misbehaved. */
export async function watch(page: Page): Promise<Watch> {
  const problems: string[] = [];
  const requests: string[] = [];
  const workers: Worker[] = [];
  page.on('console', message => {
    if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`);
  });
  page.on('worker', worker => {
    workers.push(worker);
    worker.on('console', message => {
      if (message.type() === 'error') problems.push(`worker console (${worker.url().replace(/^.*\//, '')}): ${message.text().slice(0, 300)}`);
    });
    // Armed as soon as the worker exists: its layouts start with the first diagram, after its script has loaded.
    worker.evaluate(() => {
      const seen: string[] = [];
      (globalThis as unknown as {__glCsp: string[]}).__glCsp = seen;
      globalThis.addEventListener('securitypolicyviolation', event => {
        const violation = event as SecurityPolicyViolationEvent;
        seen.push(`worker ${violation.violatedDirective} ${violation.blockedURI}`);
      });
    }).catch(() => {});
  });
  page.on('pageerror', error => problems.push(`pageerror: ${String(error.message).slice(0, 300)}`));
  page.on('request', req => {
    const url = req.url();
    requests.push(url);
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url) && !url.startsWith('data:')) problems.push(`off-host request: ${url.slice(0, 200)}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url().slice(0, 200)}`);
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as unknown as {__glCsp: string[]}).__glCsp = seen;
    document.addEventListener('securitypolicyviolation', event => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const read = () => (globalThis as unknown as {__glCsp?: string[]}).__glCsp ?? [];
  return {
    problems,
    requests,
    csp: async () => [
      ...(await page.evaluate(read)),
      // a worker that has ended has nothing more to say
      ...(await Promise.all(workers.map(worker => worker.evaluate(read).catch(() => [] as string[])))).flat(),
    ],
  };
}

/** Opens the viewer with the token link and returns the time from navigation to the first `[data-gl="Page"]`. */
export async function openViewer(page: Page, glimpse: Glimpse): Promise<number> {
  const started = performance.now();
  await page.goto(glimpse.url());
  await page.locator('[data-gl="Page"]').first().waitFor({state: 'attached', timeout: 10_000});
  return Math.round(performance.now() - started);
}

export interface Settled {
  cells: number;
  drafting: number;
  redlines: string[];
  empty: string[];
}

export function pageState(page: Page): Promise<Settled> {
  return page.evaluate(() => {
    const describe = (element: Element) => {
      const cell = element.closest('.gl-cell');
      return `${cell?.getAttribute('data-gl') ?? '?'}#${cell?.getAttribute('data-id') ?? '?'} ${element.getAttribute('data-code') ?? ''} ${(element.textContent ?? '').trim().slice(0, 160)}`.replace(/\s+/g, ' ');
    };
    return {
      cells: document.querySelectorAll('.gl-cell').length,
      drafting: document.querySelectorAll('[data-gl-state="drafting"]').length,
      redlines: [...document.querySelectorAll('[data-gl-state="redline"]')].map(describe),
      empty: [...document.querySelectorAll('[data-gl-state="empty"]')].map(describe),
    };
  });
}

/** Waits until no drafting frame is left (design 10, step 4: within 10 s), then asserts there is no redline. */
export async function expectSettled(page: Page, timeoutMs = 10_000): Promise<Settled> {
  await expect.poll(async () => (await pageState(page)).drafting, {timeout: timeoutMs, message: 'drafting frames left on the page'}).toBe(0);
  const state = await pageState(page);
  expect(state.redlines, 'redlines on the page').toEqual([]);
  return state;
}

/** Waits for the tab of surface `id` to be the selected one. */
export async function expectSurface(page: Page, id: string): Promise<void> {
  await expect(page.locator(`[role="tab"][data-surface="${id}"]`)).toHaveAttribute('aria-selected', 'true');
}

// ---------------------------------------------------------------- raw HTTP (the Host header can be forged)
export interface RawResponse { status: number; headers: IncomingHttpHeaders; body: string }

export interface RawOptions {
  method?: string;
  /** Replaces the default headers entry by entry; undefined removes one. */
  headers?: Record<string, string | undefined>;
  body?: string;
  /** false: send no Authorization header. */
  auth?: boolean;
  /** Stop reading after this many bytes (for the endless event stream). */
  firstBytes?: number;
}

/** One request to 127.0.0.1:<port>, with a correct Host header and the bearer token unless overridden. */
export function raw(port: number, path: string, options: RawOptions = {}): Promise<RawResponse> {
  const headers: Record<string, string> = {host: `127.0.0.1:${port}`};
  if (options.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    // agent: false = one connection per request, so a refusal that leaves a body unread cannot poison the next request.
    const req = request({host: '127.0.0.1', port, path, method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'), headers, setHost: false, agent: false}, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')});
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (options.firstBytes !== undefined && size >= options.firstBytes) {
          done();
          req.destroy();
        }
      });
      res.on('end', done);
      res.on('error', () => done());
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

// ---------------------------------------------------------------- timings
export interface Timing { test: string; repo: string; metric: string; ms: number }

/** Appends one measurement to <artifacts>/timings.json (the suite runs in one worker, so there is no race). */
export function recordTiming(timing: Timing): void {
  const all: Timing[] = existsSync(TIMINGS_FILE) ? JSON.parse(readFileSync(TIMINGS_FILE, 'utf8')) : [];
  all.push(timing);
  writeFileSync(TIMINGS_FILE, `${JSON.stringify(all, null, 1)}\n`);
  console.log(`timing: ${timing.metric} = ${timing.ms} ms (${timing.repo}; ${timing.test})`);
}

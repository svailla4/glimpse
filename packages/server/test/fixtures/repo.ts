// packages/server/test/fixtures/repo.ts  (WP0, frozen)
// Builds a small, deterministic git repository in a temp directory: the corpus for the analyzer, git, diff and
// end-to-end tests. Every build has the same files, the same history and therefore the same commit ids.
//
//   const repo = await makeFixtureRepo();          // about half a second
//   const out = await git(repo.root, ['log', '--oneline']);
//   const runGit = createRunGit(repo.root);        // a RunGit for RepoContext in tests
//   await repo.cleanup();
//
// What is in it (FIXTURE below states the same facts as data, and repo.test.ts checks them against git):
//   - "shop": TypeScript under src/ and test/, Python under tools/, Go under services/gateway/, with a package.json,
//     a pyproject.toml and a go.mod. 35 tracked files.
//   - imports between the files, with exactly one cycle: src/auth/service.ts <-> src/orders/service.ts
//   - 12 commits on `main` by three authors, dated 2026-08-03 to 2026-11-04 (UTC); commit 9 renames a file
//   - branch `feature`, three commits ahead of `main` (2026-11-09 to 2026-11-11)
//   - `main` is checked out with two unstaged edits and one untracked file
// Dates are fixed, so sources with a default time window (git.activity: 365 days) must be tested with an explicit
// `since=` or an injected clock, or the tests will start failing a year after these dates.
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {devNull, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {RunGit} from '../../src/contracts.ts';

export interface FixtureRepo {
  /** Absolute realpath of the repository root (a fresh directory under os.tmpdir()). */
  root: string;
  /** Deletes the directory. Safe to call twice. */
  cleanup(): Promise<void>;
}

export interface FixtureOptions {
  /** false: leave the working tree clean (no unstaged edits, no untracked file). Default true. */
  dirty?: boolean;
}

type AuthorKey = 'mira' | 'jon' | 'ade';
const AUTHORS: Record<AuthorKey, string> = {mira: 'Mira Okafor', jon: 'Jon Castell', ade: 'Ade Lindqvist'};
/** Reserved test domain, assembled at run time so no address is written down anywhere. */
const emailOf = (name: string) => [name.toLowerCase().replace(/\s+/g, '.'), ['example', 'test'].join('.')].join('@');

const PREFIX = 'glimpse-fixture-';
const MAX_BUFFER = 64 * 1024 * 1024;

/** Environment that makes git ignore the machine: no user or system config, no prompts, UTC, stable messages. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    TZ: 'UTC',
    ...extra,
  };
}

function run(root: string, args: string[], env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd: root, env, encoding: 'buffer', maxBuffer: MAX_BUFFER}, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString().trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

/** Runs git in `root` with the fixture environment and returns stdout as text (trailing newline removed). */
export async function git(root: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return (await run(root, args, gitEnv(env))).toString('utf8').replace(/\n$/, '');
}

/** A RunGit as contracts.ts describes it (cwd = root, core.quotepath=off, 64 MB cap), for RepoContext in tests. */
export function createRunGit(root: string): RunGit {
  return (args, opts) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=off', ...args],
        {cwd: root, env: gitEnv(), encoding: 'buffer', maxBuffer: opts?.maxBuffer ?? MAX_BUFFER, signal: opts?.signal},
        (error, stdout, stderr) => {
          if (error) reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString().trim() || error.message}`));
          else resolve(stdout);
        },
      );
    });
}

// ---------------------------------------------------------------- file contents
const PACKAGE_JSON = (withUi: boolean) => `{
  "name": "shop",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "pg": "^8.13.0",${withUi ? '\n    "react": "^19.0.0",' : ''}
    "redis": "^5.0.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "react-jsx",
    "noEmit": true
  },
  "include": ["src", "test"]
}
`;

const README = `# shop

A small storefront used as a fixture: an HTTP API in TypeScript, reporting tools in Python and a gateway in Go.

## Layout

- \`src/api\` routes and middleware
- \`src/auth\` sessions and tokens
- \`src/orders\` order model, pricing and service
- \`tools\` reporting scripts
- \`services/gateway\` rate-limiting reverse proxy
`;

const GITIGNORE = `node_modules/
dist/
__pycache__/
*.log
`;

const CONFIG_TS = `export interface Config {
  port: number;
  databaseUrl: string;
  cacheUrl: string;
  tokenSecret: string;
  logLevel: 'debug' | 'info' | 'warn';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost/shop',
    cacheUrl: env.CACHE_URL ?? 'redis://localhost:6379',
    tokenSecret: env.TOKEN_SECRET ?? 'dev-only',
    logLevel: env.LOG_LEVEL === 'debug' ? 'debug' : 'info',
  };
}

export const config = loadConfig();
`;

const LOG_TS = `import {config} from './config';

export function log(message: string, fields: Record<string, unknown> = {}): void {
  const line = {time: new Date().toISOString(), message, ...fields};
  if (config.logLevel === 'debug') {
    console.error(JSON.stringify(line, null, 2));
  } else {
    console.error(JSON.stringify(line));
  }
}
`;

const LOGGER_TS = `import {config} from './config';

export function log(message: string, fields: Record<string, unknown> = {}): void {
  const line = {time: new Date().toISOString(), message, ...fields};
  if (config.logLevel === 'debug') {
    console.error(JSON.stringify(line, null, 2));
  } else {
    console.error(JSON.stringify(line));
  }
}

export function warn(message: string, fields: Record<string, unknown> = {}): void {
  log(message, {...fields, level: 'warn'});
}
`;

const INDEX_TS_V1 = `import {config} from './lib/config';
import {log} from './lib/log';

log('starting', {port: config.port});
`;

const INDEX_TS_V2 = `import {createServer} from './api/server';
import {config} from './lib/config';
import {log} from './lib/log';

const server = createServer();
server.listen(config.port, () => {
  log('listening', {port: config.port});
});
`;

const DB_TS = `import {Pool} from 'pg';
import {config} from './config';

const pool = new Pool({connectionString: config.databaseUrl});

export interface Row {
  [column: string]: unknown;
}

export async function query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

export async function one<T extends Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}
`;

const CACHE_TS = `import {createClient} from 'redis';
import {config} from './config';

const client = createClient({url: config.cacheUrl});

export async function get(key: string): Promise<string | null> {
  if (!client.isOpen) await client.connect();
  return client.get(key);
}

export async function set(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!client.isOpen) await client.connect();
  await client.set(key, value, {EX: ttlSeconds});
}

export async function drop(key: string): Promise<void> {
  if (!client.isOpen) await client.connect();
  await client.del(key);
}
`;

const TOKENS_TS_V1 = `import {createHmac, randomBytes} from 'node:crypto';
import {config} from '../lib/config';

// TODO: rotate the signing key
export function sign(payload: string): string {
  return createHmac('sha256', config.tokenSecret).update(payload).digest('hex');
}

export function newToken(userId: string): string {
  const nonce = randomBytes(12).toString('hex');
  return \`\${userId}.\${nonce}.\${sign(userId + nonce)}\`;
}
`;

const TOKENS_ROTATE = `
export function verifyToken(token: string): string | undefined {
  const [userId, nonce, signature] = token.split('.');
  if (!userId || !nonce || !signature) return undefined;
  return sign(userId + nonce) === signature ? userId : undefined;
}
`;

const SESSION_TS_V1 = `import * as cache from '../lib/cache';
import {newToken} from './tokens';

export interface Session {
  token: string;
  userId: string;
}

const TTL_SECONDS = 3600;

export async function openSession(userId: string): Promise<Session> {
  const token = newToken(userId);
  await cache.set(\`session:\${token}\`, userId, TTL_SECONDS);
  return {token, userId};
}

export async function readSession(token: string): Promise<Session | undefined> {
  const userId = await cache.get(\`session:\${token}\`);
  return userId ? {token, userId} : undefined;
}
`;

const SESSION_EXPIRE = `
export async function closeSession(token: string): Promise<void> {
  await cache.drop(\`session:\${token}\`);
}
`;

const SESSION_OWNER = `
export async function requireSession(token: string | undefined): Promise<Session> {
  const session = token ? await readSession(token) : undefined;
  if (!session) {
    throw new Error('not signed in');
  }
  return session;
}
`;

const SESSION_TOUCH = `
export async function touchSession(session: Session): Promise<void> {
  await cache.set(\`session:\${session.token}\`, session.userId, TTL_SECONDS);
}
`;

const AUTH_SERVICE_V1 = `import {one} from '../lib/db';
import {openSession, type Session} from './session';
import {sign} from './tokens';

interface UserRow {
  [column: string]: unknown;
  id: string;
  email: string;
  password_hash: string;
}

const MAX_ATTEMPTS = 5;
const attempts = new Map<string, number>();

export class AuthError extends Error {
  readonly status = 401;
}

export async function login(email: string, password: string): Promise<Session> {
  const tries = attempts.get(email) ?? 0;
  if (tries >= MAX_ATTEMPTS) {
    throw new AuthError('too many attempts');
  }
  const user = await one<UserRow>('select * from users where email = $1', [email]);
  if (!user || user.password_hash !== sign(password)) {
    attempts.set(email, tries + 1);
    throw new AuthError('invalid credentials');
  }
  attempts.delete(email);
  return openSession(user.id);
}
`;

const AUTH_SERVICE_LOGOUT = `
export async function logout(token: string): Promise<void> {
  await closeSession(token);
}
`;

const AUTH_SERVICE_OWNER = `
export async function canSeeOrder(session: Session, orderId: string): Promise<boolean> {
  const order = await findOrder(orderId);
  if (!order) {
    return false;
  }
  return order.userId === session.userId;
}
`;

const AUTH_SERVICE_RESET = `
/** Test hook: forget failed attempts. */
export function resetAttempts(): void {
  attempts.clear();
}
`;

const AUTH_SERVICE_DIRTY = `
export function isLockedOut(email: string): boolean {
  return (attempts.get(email) ?? 0) >= MAX_ATTEMPTS;
}
`;

const MODEL_TS = `import {z} from 'zod';

export const OrderLine = z.object({
  sku: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
});
export type OrderLine = z.infer<typeof OrderLine>;

export const Order = z.object({
  id: z.string(),
  userId: z.string(),
  lines: z.array(OrderLine),
  coupon: z.string().optional(),
});
export type Order = z.infer<typeof Order>;
`;

const PRICING_TS = `import type {Order, OrderLine} from './model';

const COUPONS: Record<string, number> = {WELCOME10: 0.1, SPRING25: 0.25};

export function lineTotal(line: OrderLine): number {
  return line.quantity * line.unitPrice;
}

export function orderTotal(order: Order): number {
  let total = 0;
  for (const line of order.lines) {
    if (line.quantity > 0) {
      total += lineTotal(line);
    }
  }
  const discount = order.coupon ? (COUPONS[order.coupon] ?? 0) : 0;
  return Math.round(total * (1 - discount) * 100) / 100;
}
`;

const ORDERS_SERVICE_V1 = `import {one, query} from '../lib/db';
import {Order} from './model';
import {orderTotal} from './pricing';

export async function findOrder(id: string): Promise<Order | undefined> {
  const row = await one('select doc from orders where id = $1', [id]);
  return row ? Order.parse(row.doc) : undefined;
}

export async function listOrders(userId: string): Promise<Array<Order & {total: number}>> {
  const rows = await query('select doc from orders where user_id = $1', [userId]);
  return rows.map(row => {
    const order = Order.parse(row.doc);
    return {...order, total: orderTotal(order)};
  });
}
`;

const ORDERS_SERVICE_OWNED = `
export async function findOwnOrder(session: Session, id: string): Promise<Order> {
  if (!(await canSeeOrder(session, id))) {
    throw new AuthError('not your order');
  }
  const order = await findOrder(id);
  if (!order) {
    throw new Error('order vanished');
  }
  return order;
}
`;

const SERVER_TS = (logModule: string) => `import {createServer as createHttpServer, type Server} from 'node:http';
import {config} from '../lib/config';
import {log} from '../lib/${logModule}';
import {authenticate} from './middleware';
import {route} from './routes';

export function createServer(): Server {
  return createHttpServer(async (request, response) => {
    try {
      const session = await authenticate(request);
      const result = await route(request.method ?? 'GET', request.url ?? '/', session);
      response.writeHead(result.status, {'content-type': 'application/json'});
      response.end(JSON.stringify(result.body));
    } catch (error) {
      log('request failed', {url: request.url, error: String(error), port: config.port});
      response.writeHead(500);
      response.end();
    }
  });
}
`;

const MIDDLEWARE_TS = (logModule: string) => `import type {IncomingMessage} from 'node:http';
import {readSession, type Session} from '../auth/session';
import {log} from '../lib/${logModule}';

export async function authenticate(request: IncomingMessage): Promise<Session | undefined> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  const session = await readSession(header.slice(7));
  if (!session) {
    log('unknown token', {url: request.url});
  }
  return session;
}
`;

const MIDDLEWARE_LIMIT = `
export async function limited(request: IncomingMessage): Promise<boolean> {
  const address = request.socket.remoteAddress ?? 'unknown';
  return !(await take(address));
}
`;

const ROUTES_TS_V1 = `import {login} from '../auth/service';
import type {Session} from '../auth/session';

export interface Result {
  status: number;
  body: unknown;
}

export async function route(method: string, url: string, session: Session | undefined): Promise<Result> {
  if (method === 'POST' && url === '/login') {
    return {status: 200, body: await login('demo', 'demo')};
  }
  if (!session) {
    return {status: 401, body: {error: 'sign in first'}};
  }
  return {status: 404, body: {error: 'not found'}};
}
`;

const ROUTES_TS_V2 = `import {login} from '../auth/service';
import type {Session} from '../auth/session';
import {listOrders} from '../orders/service';

export interface Result {
  status: number;
  body: unknown;
}

export async function route(method: string, url: string, session: Session | undefined): Promise<Result> {
  if (method === 'POST' && url === '/login') {
    return {status: 200, body: await login('demo', 'demo')};
  }
  if (!session) {
    return {status: 401, body: {error: 'sign in first'}};
  }
  if (method === 'GET' && url === '/orders') {
    return {status: 200, body: await listOrders(session.userId)};
  }
  return {status: 404, body: {error: 'not found'}};
}
`;

const LIMITER_TS = `import * as cache from '../lib/cache';

const WINDOW_SECONDS = 60;
const LIMIT = 120;

/** Sliding-window limiter keyed by client address. Resolves false when the caller is over the limit. */
export async function take(address: string): Promise<boolean> {
  const key = \`rate:\${address}\`;
  const hits = Number((await cache.get(key)) ?? 0) + 1;
  await cache.set(key, String(hits), WINDOW_SECONDS);
  return hits <= LIMIT;
}
`;

const APP_TSX = `import {useState} from 'react';
import {Cart} from './components/Cart';
import './app.css';

export function App() {
  const [open, setOpen] = useState(false);
  return (
    <main className="app">
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide cart' : 'Show cart'}
      </button>
      {open ? <Cart lines={[]} /> : null}
    </main>
  );
}
`;

const CART_TSX = `import type {OrderLine} from '../../orders/model';
import {lineTotal} from '../../orders/pricing';

export function Cart({lines}: {lines: OrderLine[]}) {
  if (lines.length === 0) {
    return <p className="cart-empty">Your cart is empty.</p>;
  }
  return (
    <ul className="cart">
      {lines.map(line => (
        <li key={line.sku}>
          {line.sku} x {line.quantity} = {lineTotal(line)}
        </li>
      ))}
    </ul>
  );
}
`;

const APP_CSS = `.app {
  font-family: system-ui, sans-serif;
  margin: 2rem auto;
  max-width: 40rem;
}

.cart {
  list-style: none;
  padding: 0;
}

.cart-empty {
  color: #666;
}
`;

const AUTH_TEST_TS = `import {beforeEach, describe, expect, it} from 'vitest';
import {AuthError, login, resetAttempts} from '../src/auth/service';

describe('login', () => {
  beforeEach(() => resetAttempts());

  it('rejects an unknown user', async () => {
    await expect(login('nobody', 'x')).rejects.toBeInstanceOf(AuthError);
  });
});
`;

const ORDERS_TEST_TS = `import {describe, expect, it} from 'vitest';
import type {Order} from '../src/orders/model';
import {orderTotal} from '../src/orders/pricing';

const order: Order = {id: 'o1', userId: 'u1', lines: [{sku: 'tea', quantity: 2, unitPrice: 4.5}], coupon: 'WELCOME10'};

describe('orderTotal', () => {
  it('applies the coupon', () => {
    expect(orderTotal(order)).toBe(8.1);
  });
});
`;

const LIMITER_TEST_TS = `import {describe, expect, it} from 'vitest';
import {take} from '../src/api/limiter';

describe('take', () => {
  it('allows the first request of a window', async () => {
    expect(await take('203.0.113.7')).toBe(true);
  });
});
`;

const PYPROJECT = `[project]
name = "shop-tools"
version = "0.3.0"
description = "Reporting scripts for the shop fixture"
requires-python = ">=3.11"
dependencies = ["click>=8.1", "rich>=13"]

[project.scripts]
shop-report = "tools.cli:main"

[tool.pytest.ini_options]
testpaths = ["tools/tests"]
`;

const TOOLS_INIT = `"""Reporting tools for the shop fixture."""
`;

const TOOLS_UTIL = `import csv
from pathlib import Path


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def chunks(values: list[float], size: int) -> list[list[float]]:
    return [values[index:index + size] for index in range(0, len(values), size)]
`;

const TOOLS_STATS = `import statistics

from .util import chunks


def summarize(values: list[float]) -> dict[str, float]:
    # FIXME: median of an empty list
    if not values:
        return {"count": 0, "mean": 0.0, "median": 0.0}
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
    }


def weekly(values: list[float]) -> list[dict[str, float]]:
    return [summarize(week) for week in chunks(values, 7)]
`;

const TOOLS_STATS_DIRTY = `

def spread(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return max(values) - min(values)
`;

const TOOLS_REPORT = `import json
from pathlib import Path

from .stats import summarize, weekly
from .util import read_rows


class Report:
    def __init__(self, source: Path) -> None:
        self.source = source
        self.rows = read_rows(source)

    def totals(self) -> list[float]:
        return [float(row["total"]) for row in self.rows if row.get("total")]

    def build(self) -> dict[str, object]:
        totals = self.totals()
        return {"source": str(self.source), "summary": summarize(totals), "weekly": weekly(totals)}


def build_report(source: Path) -> str:
    return json.dumps(Report(source).build(), indent=2)
`;

const TOOLS_CLI = `import argparse
from pathlib import Path

from tools import util
from tools.report import build_report


def main() -> None:
    parser = argparse.ArgumentParser(prog="shop-report")
    parser.add_argument("source", type=Path)
    parser.add_argument("--count", action="store_true")
    args = parser.parse_args()
    if args.count:
        print(len(util.read_rows(args.source)))
    else:
        print(build_report(args.source))


if __name__ == "__main__":
    main()
`;

const TOOLS_TEST = `from tools.stats import summarize


def test_summarize_empty() -> None:
    assert summarize([])["count"] == 0


def test_summarize_mean() -> None:
    assert summarize([1.0, 3.0])["mean"] == 2.0
`;

const GO_MOD = `module example.com/shop

go 1.23

require golang.org/x/time v0.9.0
`;

const GO_MAIN = `package main

import (
	"log"
	"net/http"
	"time"

	"example.com/shop/services/gateway/limiter"
	"example.com/shop/services/gateway/proxy"
)

func main() {
	limit := limiter.New(120, time.Minute)
	handler, err := proxy.New("http://127.0.0.1:8080", limit)
	if err != nil {
		log.Fatal(err)
	}
	log.Fatal(http.ListenAndServe(":9090", handler))
}
`;

const GO_LIMITER = `package limiter

import (
	"sync"
	"time"
)

// Limiter is a fixed-window counter per key.
type Limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
}

func New(limit int, window time.Duration) *Limiter {
	return &Limiter{limit: limit, window: window, hits: map[string][]time.Time{}}
}

// Allow reports whether key may make another request now.
func (l *Limiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.hits[key][:0]
	for _, at := range l.hits[key] {
		if now.Sub(at) < l.window {
			kept = append(kept, at)
		}
	}
	if len(kept) >= l.limit {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}
`;

const GO_LIMITER_TEST = `package limiter

import (
	"testing"
	"time"
)

func TestAllow(t *testing.T) {
	l := New(2, time.Minute)
	now := time.Unix(0, 0)
	if !l.Allow("a", now) || !l.Allow("a", now) {
		t.Fatal("first two requests should pass")
	}
	if l.Allow("a", now) {
		t.Fatal("third request should be limited")
	}
}
`;

const GO_PROXY = `package proxy

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"example.com/shop/services/gateway/limiter"
)

// TODO: retry idempotent requests
func New(target string, limit *limiter.Limiter) (http.Handler, error) {
	upstream, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	forward := httputil.NewSingleHostReverseProxy(upstream)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !limit.Allow(r.RemoteAddr, time.Now()) {
			http.Error(w, "slow down", http.StatusTooManyRequests)
			return
		}
		forward.ServeHTTP(w, r)
	}), nil
}
`;

const METRICS_TS = `const counters = new Map<string, number>();

export function count(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
`;

// ---------------------------------------------------------------- history
interface Step {
  author: AuthorKey;
  /** Author and committer date, ISO 8601 UTC. */
  date: string;
  subject: string;
  write?: Record<string, string>;
  append?: Record<string, string>;
  /** path -> [text to find, replacement]; the text must be present. */
  replace?: Record<string, [string, string]>;
  rename?: Record<string, string>;
}

const MAIN: Step[] = [
  {
    author: 'mira', date: '2026-08-03T09:00:00Z', subject: 'Scaffold the shop service',
    write: {
      'package.json': PACKAGE_JSON(false), 'tsconfig.json': TSCONFIG, 'README.md': README, '.gitignore': GITIGNORE,
      'src/index.ts': INDEX_TS_V1, 'src/lib/config.ts': CONFIG_TS, 'src/lib/log.ts': LOG_TS,
    },
  },
  {
    author: 'mira', date: '2026-08-05T14:30:00Z', subject: 'Add database and cache helpers',
    write: {'src/lib/db.ts': DB_TS, 'src/lib/cache.ts': CACHE_TS},
  },
  {
    author: 'jon', date: '2026-08-11T10:15:00Z', subject: 'Add auth service with sessions',
    write: {'src/auth/service.ts': AUTH_SERVICE_V1, 'src/auth/session.ts': SESSION_TS_V1, 'src/auth/tokens.ts': TOKENS_TS_V1},
  },
  {
    author: 'jon', date: '2026-08-18T16:45:00Z', subject: 'Add HTTP server and routes',
    write: {
      'src/api/server.ts': SERVER_TS('log'), 'src/api/routes.ts': ROUTES_TS_V1, 'src/api/middleware.ts': MIDDLEWARE_TS('log'),
      'src/index.ts': INDEX_TS_V2,
    },
  },
  {
    author: 'mira', date: '2026-08-25T11:20:00Z', subject: 'Add orders with pricing',
    write: {
      'src/orders/model.ts': MODEL_TS, 'src/orders/pricing.ts': PRICING_TS, 'src/orders/service.ts': ORDERS_SERVICE_V1,
      'src/api/routes.ts': ROUTES_TS_V2,
    },
  },
  {
    author: 'ade', date: '2026-09-02T09:40:00Z', subject: 'Add reporting tools',
    write: {
      'pyproject.toml': PYPROJECT, 'tools/__init__.py': TOOLS_INIT, 'tools/cli.py': TOOLS_CLI, 'tools/report.py': TOOLS_REPORT,
      'tools/stats.py': TOOLS_STATS, 'tools/util.py': TOOLS_UTIL, 'tools/tests/test_stats.py': TOOLS_TEST,
    },
  },
  {
    author: 'ade', date: '2026-09-09T13:05:00Z', subject: 'Add the gateway in Go',
    write: {
      'go.mod': GO_MOD, 'services/gateway/main.go': GO_MAIN, 'services/gateway/limiter/limiter.go': GO_LIMITER,
      'services/gateway/limiter/limiter_test.go': GO_LIMITER_TEST, 'services/gateway/proxy/proxy.go': GO_PROXY,
    },
  },
  {
    author: 'jon', date: '2026-09-16T15:50:00Z', subject: 'Expire sessions and rotate tokens',
    append: {'src/auth/service.ts': AUTH_SERVICE_LOGOUT, 'src/auth/session.ts': SESSION_EXPIRE, 'src/auth/tokens.ts': TOKENS_ROTATE},
    replace: {'src/auth/service.ts': ["import {openSession, type Session} from './session';", "import {closeSession, openSession, type Session} from './session';"]},
  },
  {
    author: 'mira', date: '2026-09-24T10:10:00Z', subject: 'Rename log to logger and add warn',
    rename: {'src/lib/log.ts': 'src/lib/logger.ts'},
    write: {'src/lib/logger.ts': LOGGER_TS, 'src/api/server.ts': SERVER_TS('logger'), 'src/api/middleware.ts': MIDDLEWARE_TS('logger')},
    replace: {'src/index.ts': ["import {log} from './lib/log';", "import {log} from './lib/logger';"]},
  },
  {
    author: 'jon', date: '2026-10-06T08:55:00Z', subject: 'Check order ownership in auth',
    append: {'src/auth/service.ts': AUTH_SERVICE_OWNER, 'src/orders/service.ts': ORDERS_SERVICE_OWNED, 'src/auth/session.ts': SESSION_OWNER},
    replace: {
      'src/auth/service.ts': ["import {one} from '../lib/db';", "import {one} from '../lib/db';\nimport {findOrder} from '../orders/service';"],
      'src/orders/service.ts': ["import {one, query} from '../lib/db';", "import {AuthError, canSeeOrder} from '../auth/service';\nimport type {Session} from '../auth/session';\nimport {one, query} from '../lib/db';"],
    },
  },
  {
    author: 'mira', date: '2026-10-20T17:25:00Z', subject: 'Add the storefront UI',
    write: {'src/ui/App.tsx': APP_TSX, 'src/ui/components/Cart.tsx': CART_TSX, 'src/ui/app.css': APP_CSS, 'package.json': PACKAGE_JSON(true)},
  },
  {
    author: 'jon', date: '2026-11-04T12:00:00Z', subject: 'Add tests for auth and orders',
    write: {'test/auth.test.ts': AUTH_TEST_TS, 'test/orders.test.ts': ORDERS_TEST_TS},
    append: {'src/auth/service.ts': AUTH_SERVICE_RESET, 'src/auth/session.ts': SESSION_TOUCH},
  },
];

const FEATURE: Step[] = [
  {author: 'ade', date: '2026-11-09T09:30:00Z', subject: 'Add a sliding-window rate limiter', write: {'src/api/limiter.ts': LIMITER_TS}},
  {
    author: 'ade', date: '2026-11-10T11:00:00Z', subject: 'Apply the limiter to all routes',
    append: {'src/api/middleware.ts': MIDDLEWARE_LIMIT},
    replace: {
      'src/api/middleware.ts': ["import {log} from '../lib/logger';", "import {log} from '../lib/logger';\nimport {take} from './limiter';"],
      'src/api/routes.ts': ["  if (!session) {", "  if (url.length > 2048) {\n    return {status: 414, body: {error: 'url too long'}};\n  }\n  if (!session) {"],
    },
  },
  {author: 'mira', date: '2026-11-11T15:15:00Z', subject: 'Test the limiter window', write: {'test/limiter.test.ts': LIMITER_TEST_TS}},
];

/** Applied to the working tree of `main` and left uncommitted (and unstaged). */
const DIRTY: Pick<Step, 'append' | 'replace' | 'write'> = {
  append: {'src/auth/service.ts': AUTH_SERVICE_DIRTY, 'tools/stats.py': TOOLS_STATS_DIRTY},
  replace: {'src/auth/service.ts': ['const MAX_ATTEMPTS = 5;', 'const MAX_ATTEMPTS = 3;']},
  write: {'src/lib/metrics.ts': METRICS_TS},
};

// ---------------------------------------------------------------- facts about the result
/** What the fixture contains, for assertions. repo.test.ts verifies every entry against the built repository. */
export const FIXTURE = {
  /** `name` of the root package.json. */
  packageName: 'shop',
  branches: {main: 'main', feature: 'feature'},
  /** Display names, as `git log --format=%aN` prints them. */
  authors: Object.values(AUTHORS),
  commits: {
    main: MAIN.length,
    /** Commits on `feature` that are not on `main` (`main..feature`). */
    featureAhead: FEATURE.length,
    byAuthorOnMain: {'Mira Okafor': 5, 'Jon Castell': 5, 'Ade Lindqvist': 2} as Record<string, number>,
    first: MAIN[0]!.date,
    last: MAIN.at(-1)!.date,
    subjects: MAIN.map(step => step.subject),
  },
  /** Tracked files at the tip of `main`, sorted. */
  tracked: [
    '.gitignore', 'README.md', 'go.mod', 'package.json', 'pyproject.toml',
    'services/gateway/limiter/limiter.go', 'services/gateway/limiter/limiter_test.go', 'services/gateway/main.go',
    'services/gateway/proxy/proxy.go',
    'src/api/middleware.ts', 'src/api/routes.ts', 'src/api/server.ts',
    'src/auth/service.ts', 'src/auth/session.ts', 'src/auth/tokens.ts',
    'src/index.ts',
    'src/lib/cache.ts', 'src/lib/config.ts', 'src/lib/db.ts', 'src/lib/logger.ts',
    'src/orders/model.ts', 'src/orders/pricing.ts', 'src/orders/service.ts',
    'src/ui/App.tsx', 'src/ui/app.css', 'src/ui/components/Cart.tsx',
    'test/auth.test.ts', 'test/orders.test.ts',
    'tools/__init__.py', 'tools/cli.py', 'tools/report.py', 'tools/stats.py', 'tools/tests/test_stats.py', 'tools/util.py',
    'tsconfig.json',
  ],
  /** Working tree of `main` after makeFixtureRepo() (with the default dirty: true). */
  workingTree: {
    modified: ['src/auth/service.ts', 'tools/stats.py'],
    untracked: ['src/lib/metrics.ts'],
  },
  /** `main..feature`. */
  feature: {
    added: ['src/api/limiter.ts', 'test/limiter.test.ts'],
    modified: ['src/api/middleware.ts', 'src/api/routes.ts'],
  },
  /** The only import cycle. */
  cycle: ['src/auth/service.ts', 'src/orders/service.ts'],
  /** Commit 9 of `main` (1-based) renames this file; `git log -M` reports it as a rename. */
  rename: {from: 'src/lib/log.ts', to: 'src/lib/logger.ts', commit: 9},
  /** Files touched by three or more commits on `main`, with the number of commits. Every other file has one or two. */
  churn: {'src/auth/service.ts': 4, 'src/auth/session.ts': 4, 'src/index.ts': 3} as Record<string, number>,
  /** The only pair of files that changes together in at least three commits. */
  coupled: {a: 'src/auth/service.ts', b: 'src/auth/session.ts', shared: 4},
  /** TODO / FIXME comments in tracked files: [tag, path]. */
  todos: [['TODO', 'services/gateway/proxy/proxy.go'], ['TODO', 'src/auth/tokens.ts'], ['FIXME', 'tools/stats.py']] as Array<[string, string]>,
  /** npm packages imported by the TypeScript files (node: built-ins, the Python and Go standard libraries aside). */
  npmImports: ['pg', 'react', 'redis', 'vitest', 'zod'],
  /** Go module path from go.mod; imports that start with it are internal. */
  goModule: 'example.com/shop',
  manifests: ['go.mod', 'package.json', 'pyproject.toml'],
} as const;

// ---------------------------------------------------------------- builder
async function apply(root: string, contents: Map<string, string>, step: Pick<Step, 'write' | 'append' | 'replace' | 'rename'>): Promise<void> {
  for (const [from, to] of Object.entries(step.rename ?? {})) {
    const text = contents.get(from);
    if (text === undefined) throw new Error(`fixture: cannot rename missing ${from}`);
    contents.delete(from);
    contents.set(to, text);
    await rm(join(root, from));
  }
  const touched = new Set<string>(Object.values(step.rename ?? {}));
  for (const [path, text] of Object.entries(step.write ?? {})) { contents.set(path, text); touched.add(path); }
  for (const [path, [find, replacement]] of Object.entries(step.replace ?? {})) {
    const text = contents.get(path);
    if (text === undefined || !text.includes(find)) throw new Error(`fixture: "${find}" not found in ${path}`);
    contents.set(path, text.replace(find, replacement));
    touched.add(path);
  }
  for (const [path, text] of Object.entries(step.append ?? {})) {
    const before = contents.get(path);
    if (before === undefined) throw new Error(`fixture: cannot append to missing ${path}`);
    contents.set(path, before + text);
    touched.add(path);
  }
  for (const path of touched) {
    const file = join(root, path);
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, contents.get(path)!);
  }
}

async function commit(root: string, contents: Map<string, string>, step: Step): Promise<void> {
  await apply(root, contents, step);
  const name = AUTHORS[step.author];
  const identity = {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: emailOf(name), GIT_AUTHOR_DATE: step.date,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: emailOf(name), GIT_COMMITTER_DATE: step.date,
  };
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '--no-gpg-sign', '-m', step.subject], identity);
}

/** Builds the fixture repository in a new temp directory. The caller owns it and must call cleanup(). */
export async function makeFixtureRepo(options: FixtureOptions = {}): Promise<FixtureRepo> {
  const root = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const cleanup = async () => {
    // Refuse to delete anything that is not one of our temp directories.
    if (!root.includes(PREFIX)) throw new Error(`fixture: refusing to remove ${root}`);
    await rm(root, {recursive: true, force: true});
  };
  try {
    await git(root, ['init', '-q', '-b', FIXTURE.branches.main]);
    // Local identity and settings so plain `git commit` works in tests and nothing depends on the machine.
    await git(root, ['config', 'user.name', 'Fixture Committer']);
    await git(root, ['config', 'user.email', emailOf('fixture committer')]);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    await git(root, ['config', 'core.autocrlf', 'false']);

    const contents = new Map<string, string>();
    for (const step of MAIN) await commit(root, contents, step);

    const atMain = new Map(contents);
    await git(root, ['checkout', '-q', '-b', FIXTURE.branches.feature]);
    for (const step of FEATURE) await commit(root, contents, step);
    await git(root, ['checkout', '-q', FIXTURE.branches.main]);

    if (options.dirty !== false) await apply(root, atMain, DIRTY);
    return {root, cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

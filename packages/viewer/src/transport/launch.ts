// packages/viewer/src/transport/launch.ts
// How a tab learns its session: the host opens `/#t=<token>`. The token moves from the URL fragment into
// sessionStorage (this tab only) and the fragment becomes `#/<surfaceId>`, the surface the tab is showing
// (design 2.5). Storage and history access are guarded: a tab that cannot store the token still works until reload.
const TOKEN_KEY = 'glimpse.token';

export interface Launch {
  /** Session token, or null when the tab was opened without one and has none stored. */
  token: string | null;
  /** Surface named by `#/<surfaceId>`, if any. */
  route: string | undefined;
}

type TokenStorage = Pick<Storage, 'getItem' | 'setItem'>;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Whether a fragment carries a session token (`#t=...`): the link a host prints for a tab to open. */
export const isTokenFragment = (hash: string): boolean => /^#t=[^&/]/.test(hash);

/** The surface id in a `#/<surfaceId>` fragment. */
export function parseRoute(hash: string): string | undefined {
  const match = /^#\/([^/?#]+)/.exec(hash);
  return match ? decode(match[1]!) : undefined;
}

export function formatRoute(surfaceId: string | undefined): string {
  return surfaceId ? `#/${encodeURIComponent(surfaceId)}` : '#/';
}

/** Reads the token and the route from a fragment. A fresh token is stored; without one the stored token is used. */
export function readLaunch(hash: string, storage: TokenStorage | null): Launch {
  const fresh = /^#t=([^&/]+)/.exec(hash)?.[1];
  if (fresh) {
    const token = decode(fresh);
    try {
      storage?.setItem(TOKEN_KEY, token);
    } catch {
      // private mode: the token lives in memory for this page load
    }
    return {token, route: undefined};
  }
  let token: string | null = null;
  try {
    token = storage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    token = null;
  }
  return {token, route: parseRoute(hash)};
}

/** The tab's launch state. Removes the token from the address bar without adding a history entry. */
export function launchFromLocation(): Launch {
  let storage: TokenStorage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  const launch = readLaunch(window.location.hash, storage);
  if (isTokenFragment(window.location.hash)) showRoute(undefined);
  return launch;
}

/** Puts `#/<surfaceId>` in the address bar (no navigation, no history entry). */
export function showRoute(surfaceId: string | undefined): void {
  try {
    const next = formatRoute(surfaceId);
    if (window.location.hash !== next) window.history.replaceState(window.history.state, '', next);
  } catch {
    // a sandboxed document may refuse history writes; the route is cosmetic
  }
}

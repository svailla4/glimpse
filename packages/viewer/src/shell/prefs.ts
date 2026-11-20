// packages/viewer/src/shell/prefs.ts
// Theme and density (design 8.4): attributes on <html> that tokens.css keys on, remembered in localStorage as
// `glimpse.theme` and `glimpse.density`. Storage access is guarded; without it the choice lasts for the page.
export type Theme = 'auto' | 'light' | 'dark';
export type Density = 'compact' | 'comfortable';
export interface Prefs { theme: Theme; density: Density }

const THEME_KEY = 'glimpse.theme';
const DENSITY_KEY = 'glimpse.density';
type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): PrefStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string, store: PrefStorage | null): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function loadPrefs(store: PrefStorage | null = storage()): Prefs {
  const theme = read(THEME_KEY, store);
  const density = read(DENSITY_KEY, store);
  return {theme: theme === 'light' || theme === 'dark' ? theme : 'auto', density: density === 'comfortable' ? 'comfortable' : 'compact'};
}

export function savePrefs(prefs: Prefs, store: PrefStorage | null = storage()): void {
  try {
    store?.setItem(THEME_KEY, prefs.theme);
    store?.setItem(DENSITY_KEY, prefs.density);
  } catch {
    // quota or privacy mode: the attributes on <html> still hold for this page
  }
}

export function applyPrefs(prefs: Prefs, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-density', prefs.density);
}

/** The scheme the operating system asks for. */
export function systemScheme(): 'light' | 'dark' {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The scheme on screen for a theme. */
export const schemeOf = (theme: Theme, system: 'light' | 'dark' = systemScheme()): 'light' | 'dark' => (theme === 'auto' ? system : theme);

/**
 * The other scheme, so the toggle always changes what is on screen. Choosing the scheme the system already asks for
 * goes back to `auto`, which keeps following the system.
 */
export function toggleTheme(theme: Theme, system: 'light' | 'dark' = systemScheme()): Theme {
  const next = schemeOf(theme, system) === 'dark' ? 'light' : 'dark';
  return next === system ? 'auto' : next;
}

export const toggleDensity = (density: Density): Density => (density === 'compact' ? 'comfortable' : 'compact');

// packages/viewer/test/shell/launch.test.ts - token and route from the URL fragment; theme and density preferences.
import {afterEach, describe, expect, it} from 'vitest';
import {applyPrefs, loadPrefs, savePrefs, schemeOf, toggleDensity, toggleTheme} from '../../src/shell/prefs.ts';
import {formatRoute, isTokenFragment, launchFromLocation, parseRoute, readLaunch, showRoute} from '../../src/transport/launch.ts';
import {fakeStorage} from './scripted.ts';

afterEach(() => {
  window.history.replaceState(null, '', '#');
  window.sessionStorage.clear();
});

describe('launch', () => {
  it('takes a fresh token from the fragment and stores it', () => {
    const storage = fakeStorage();
    expect(readLaunch('#t=abc-DEF_123', storage)).toEqual({token: 'abc-DEF_123', route: undefined});
    expect(storage.values.get('glimpse.token')).toBe('abc-DEF_123');
    expect(readLaunch('#t=a%2Fb&x=1', storage).token).toBe('a/b');
  });

  it('falls back to the stored token and reads the route', () => {
    const storage = fakeStorage({'glimpse.token': 'stored'});
    expect(readLaunch('#/overview', storage)).toEqual({token: 'stored', route: 'overview'});
    expect(readLaunch('', storage)).toEqual({token: 'stored', route: undefined});
    expect(readLaunch('#/overview', fakeStorage())).toEqual({token: null, route: 'overview'});
  });

  it('works when storage refuses access', () => {
    const broken = fakeStorage({}, true);
    expect(readLaunch('#t=abc', broken)).toEqual({token: 'abc', route: undefined});
    expect(readLaunch('#/a', broken)).toEqual({token: null, route: 'a'});
    expect(readLaunch('#/a', null)).toEqual({token: null, route: 'a'});
  });

  it('parses and formats routes', () => {
    expect(parseRoute('#/my_view')).toBe('my_view');
    expect(parseRoute('#/a%20b/extra')).toBe('a b');
    expect(parseRoute('#/%E0%A4%A')).toBe('%E0%A4%A');
    expect(parseRoute('#t=abc')).toBeUndefined();
    expect(parseRoute('#/')).toBeUndefined();
    expect([isTokenFragment('#t=abc'), isTokenFragment('#t='), isTokenFragment('#/t=abc'), isTokenFragment('')]).toEqual([true, false, false, false]);
    expect(formatRoute('a b')).toBe('#/a%20b');
    expect(formatRoute(undefined)).toBe('#/');
  });

  it('removes the token from the address bar and then shows the surface', () => {
    window.history.replaceState(null, '', '#t=secret');
    const entries = window.history.length;
    expect(launchFromLocation()).toEqual({token: 'secret', route: undefined});
    expect(window.location.hash).toBe('#/');
    expect(window.sessionStorage.getItem('glimpse.token')).toBe('secret');
    showRoute('overview');
    expect(window.location.hash).toBe('#/overview');
    expect(window.history.length).toBe(entries);
    // a reload: no token in the fragment any more
    expect(launchFromLocation()).toEqual({token: 'secret', route: 'overview'});
  });
});

describe('preferences', () => {
  it('loads defaults, and only values it knows', () => {
    expect(loadPrefs(fakeStorage())).toEqual({theme: 'auto', density: 'compact'});
    expect(loadPrefs(fakeStorage({'glimpse.theme': 'dark', 'glimpse.density': 'comfortable'}))).toEqual({theme: 'dark', density: 'comfortable'});
    expect(loadPrefs(fakeStorage({'glimpse.theme': 'neon', 'glimpse.density': '7'}))).toEqual({theme: 'auto', density: 'compact'});
    expect(loadPrefs(fakeStorage({}, true))).toEqual({theme: 'auto', density: 'compact'});
    expect(loadPrefs(null)).toEqual({theme: 'auto', density: 'compact'});
  });

  it('saves under glimpse.theme and glimpse.density, and tolerates a storage that throws', () => {
    const storage = fakeStorage();
    savePrefs({theme: 'light', density: 'comfortable'}, storage);
    expect(Object.fromEntries(storage.values)).toEqual({'glimpse.theme': 'light', 'glimpse.density': 'comfortable'});
    expect(() => savePrefs({theme: 'dark', density: 'compact'}, fakeStorage({}, true))).not.toThrow();
  });

  it('applies both as attributes of the root element', () => {
    const root = document.createElement('html');
    applyPrefs({theme: 'dark', density: 'comfortable'}, root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.getAttribute('data-density')).toBe('comfortable');
  });

  it('the theme toggle always changes the scheme on screen and returns to auto on the system scheme', () => {
    expect(schemeOf('auto', 'dark')).toBe('dark');
    expect(schemeOf('light', 'dark')).toBe('light');
    expect(toggleTheme('auto', 'light')).toBe('dark');
    expect(toggleTheme('dark', 'light')).toBe('auto');
    expect(toggleTheme('auto', 'dark')).toBe('light');
    expect(toggleTheme('light', 'dark')).toBe('auto');
    expect(toggleTheme('light', 'light')).toBe('dark');
    expect(toggleDensity('compact')).toBe('comfortable');
    expect(toggleDensity('comfortable')).toBe('compact');
  });
});

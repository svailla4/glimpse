// Desktop launching: which command is built for the tab and the editor, and when nothing is opened at all.
import {existsSync, realpathSync} from 'node:fs';
import {chmod, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {delimiter, isAbsolute, join, relative} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {portCandidates} from '../../src/host/host.ts';
import {canOpen, detachedLauncher, editorCommand, launchOptions, osOpenCommand} from '../../src/host/open.ts';
import {ownEnv} from '../../src/session/env.ts';
import {findProgram, trustedPath} from '../../src/session/paths.ts';
import {tempRoot} from '../session/fakes.ts';

describe('canOpen', () => {
  it('is false under GLIMPSE_NO_OPEN=1, in CI, over SSH and on Linux without a display', () => {
    expect(canOpen({}, 'darwin')).toBe(true);
    expect(canOpen({}, 'win32')).toBe(true);
    expect(canOpen({GLIMPSE_NO_OPEN: '1'}, 'darwin')).toBe(false);
    expect(canOpen({GLIMPSE_NO_OPEN: '0'}, 'darwin')).toBe(true);
    expect(canOpen({CI: 'true'}, 'darwin')).toBe(false);
    expect(canOpen({SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22'}, 'darwin')).toBe(false);
    expect(canOpen({}, 'linux')).toBe(false);
    expect(canOpen({DISPLAY: ':0'}, 'linux')).toBe(true);
    expect(canOpen({WAYLAND_DISPLAY: 'wayland-0'}, 'linux')).toBe(true);
  });
});

describe('osOpenCommand', () => {
  it('uses the platform opener with the target as one argument, never a shell', () => {
    const url = 'http://127.0.0.1:4517/#t=abc&x=1';
    expect(osOpenCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(osOpenCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
    expect(osOpenCommand(url, 'win32')).toEqual(['rundll32', ['url.dll,FileProtocolHandler', url]]);
  });

  it('is for the viewer URL only: a file, a file URL or another host is refused', () => {
    for (const target of ['/repo/run.command', 'file:///repo/run.command', 'http://example.invalid/', 'http://127.0.0.1.evil.invalid:80/', 'https://127.0.0.1:4517/']) {
      expect(() => osOpenCommand(target, 'darwin')).toThrow('the OS opener is only used for the viewer URL');
    }
  });
});

describe('editorCommand', () => {
  const none = {root: '/repo', which: () => undefined};
  const found = (...names: string[]) => ({root: '/repo', which: (name: string) => (names.includes(name) ? `/usr/local/bin/${name}` : undefined)});

  it('fills the GLIMPSE_EDITOR template inside single arguments, with the program by its absolute path', () => {
    const lookup = found('code', 'nvim', 'subl');
    expect(editorCommand('/repo/src/a b.ts', 12, {GLIMPSE_EDITOR: 'code -g {file}:{line}'}, lookup)).toEqual(['/usr/local/bin/code', ['-g', '/repo/src/a b.ts:12']]);
    expect(editorCommand('/repo/a.ts', undefined, {GLIMPSE_EDITOR: '  nvim   +{line}   {file} '}, lookup)).toEqual(['/usr/local/bin/nvim', ['+1', '/repo/a.ts']]);
    expect(editorCommand('/repo/a.ts', 3, {GLIMPSE_EDITOR: 'subl'}, lookup)).toEqual(['/usr/local/bin/subl', ['/repo/a.ts']]);
    // an absolute program is the user's own choice and is used as written
    expect(editorCommand('/repo/a.ts', 3, {GLIMPSE_EDITOR: '/opt/ed/bin/ed {file}'}, none)).toEqual(['/opt/ed/bin/ed', ['/repo/a.ts']]);
  });

  it('a hostile file name stays one argument and is never interpreted', () => {
    const file = '/repo/$(touch pwned); `id` && x.ts';
    expect(editorCommand(file, 1, {GLIMPSE_EDITOR: 'code -g {file}:{line}'}, found('code'))).toEqual(['/usr/local/bin/code', ['-g', `${file}:1`]]);
  });

  it('otherwise picks the first known editor on PATH', () => {
    expect(editorCommand('/repo/a.ts', 7, {}, found('cursor', 'zed'))).toEqual(['/usr/local/bin/cursor', ['-g', '/repo/a.ts:7']]);
    expect(editorCommand('/repo/a.ts', 7, {}, found('zed'))).toEqual(['/usr/local/bin/zed', ['/repo/a.ts:7']]);
    expect(editorCommand('/repo/a.ts', -4, {}, found('code'))).toEqual(['/usr/local/bin/code', ['-g', '/repo/a.ts:1']]);
    expect(editorCommand('/repo/a.ts', 7, {}, found('subl'))).toEqual(['/usr/local/bin/subl', ['/repo/a.ts:7']]);
    expect(editorCommand('/repo/a.ts', 7, {}, found('idea'))).toEqual(['/usr/local/bin/idea', ['--line', '7', '/repo/a.ts']]);
  });

  // Finding F050: `open run.command` runs the script; the same goes for .app, .jar, .html and their kin elsewhere.
  it('with no editor there is no command at all: never the OS opener', () => {
    for (const file of ['/repo/a.ts', '/repo/run.command', '/repo/Evil.app', '/repo/setup.pkg', '/repo/page.html']) {
      expect(editorCommand(file, 7, {}, none)).toBeUndefined();
    }
  });

  // Finding V019: `./code` or `node_modules/.bin/code` would be resolved against the directory the server runs in.
  it('a GLIMPSE_EDITOR program given as a relative path, or found nowhere on PATH, is not run', () => {
    expect(editorCommand('/repo/a.ts', 1, {GLIMPSE_EDITOR: './code -g {file}'}, found('code'))).toBeUndefined();
    expect(editorCommand('/repo/a.ts', 1, {GLIMPSE_EDITOR: 'node_modules/.bin/code {file}'}, found('code'))).toBeUndefined();
    expect(editorCommand('/repo/a.ts', 1, {GLIMPSE_EDITOR: 'code {file}'}, none)).toBeUndefined();
  });

  it('GLIMPSE_EDITOR counts only as an own property of the environment (decision untrusted-input-contained)', () => {
    const inherited = Object.create({GLIMPSE_EDITOR: '/bin/sh -c id'}) as NodeJS.ProcessEnv;
    expect(editorCommand('/repo/a.ts', 1, inherited, none)).toBeUndefined();
    expect(editorCommand('/repo/a.ts', 1, ownEnv({GLIMPSE_EDITOR: 'code -g {file}:{line}'}), found('code'))).toEqual(['/usr/local/bin/code', ['-g', '/repo/a.ts:1']]);
  });
});

describe('ownEnv', () => {
  it('copies own string entries to a frozen object without a prototype', () => {
    const proto = Object.prototype as Record<string, unknown>;
    const env = ownEnv({A: '1', B: undefined});
    try {
      proto.GLIMPSE_EDITOR = 'evil';
      expect(Object.getPrototypeOf(env)).toBeNull();
      expect(Object.isFrozen(env)).toBe(true);
      expect(env.A).toBe('1');
      expect('B' in env).toBe(false);
      expect(env.GLIMPSE_EDITOR).toBeUndefined();
      expect({...env}).toEqual({A: '1'});
      expect(ownEnv(env)).toBe(env);
      if (!Object.hasOwn(process.env, 'GLIMPSE_EDITOR')) {
        // the live process environment, by contrast, answers from the prototype: this was the gadget of F047
        expect(process.env.GLIMPSE_EDITOR).toBe('evil');
        expect(ownEnv(process.env).GLIMPSE_EDITOR).toBeUndefined();
      }
    } finally {
      delete proto.GLIMPSE_EDITOR;
    }
  });
});

// Finding V019: programs come from absolute PATH directories outside the project, by their absolute path.
describe('findProgram and trustedPath', () => {
  let outside: Awaited<ReturnType<typeof tempRoot>>;
  let project: Awaited<ReturnType<typeof tempRoot>>;
  beforeAll(async () => {
    outside = await tempRoot();
    project = await tempRoot();
    for (const dir of [outside.root, join(project.root, 'node_modules', '.bin')]) {
      await mkdir(dir, {recursive: true});
      await writeFile(join(dir, 'myeditor'), '#!/bin/sh\n');
      await chmod(join(dir, 'myeditor'), 0o755);
    }
    await writeFile(join(outside.root, 'notexec'), 'x');
    await chmod(join(outside.root, 'notexec'), 0o644);
    await symlink(join(project.root, 'node_modules', '.bin'), join(outside.root, 'into-project')).catch(() => {});
  });
  afterAll(async () => {
    await outside.cleanup();
    await project.cleanup();
  });

  it.skipIf(process.platform === 'win32')('finds executables in absolute PATH directories outside the project only', () => {
    const env = {PATH: ['/nonexistent-dir', outside.root].join(delimiter)};
    expect(findProgram('myeditor', env, project.root)).toBe(join(outside.root, 'myeditor'));
    expect(findProgram('notexec', env, project.root)).toBeUndefined();
    expect(findProgram('missing', env, project.root)).toBeUndefined();
    expect(findProgram('myeditor', {}, project.root)).toBeUndefined();
    expect(findProgram('../myeditor', env, project.root)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('skips relative entries, directories of the project, and links into it', () => {
    const env = {PATH: ['node_modules/.bin', '.', join(project.root, 'node_modules', '.bin'), join(outside.root, 'into-project'), '/usr/bin'].join(delimiter)};
    expect(trustedPath(env, project.root)).toEqual(['/usr/bin']);
    expect(findProgram('myeditor', env, project.root)).toBeUndefined();
  });

  it('an inherited PATH is not a PATH (decision untrusted-input-contained)', () => {
    expect(trustedPath(Object.create({PATH: '/usr/bin'}) as NodeJS.ProcessEnv, project.root)).toEqual([]);
  });

  // Finding V019, re-attack b19: the editor was found by its absolute path, but it starts with `#!/usr/bin/env bash`,
  // and with PATH=.:… and the server in the project, a repository-committed ./bash ran.
  it.skipIf(process.platform === 'win32')('a launched program sees the trusted PATH only, and starts outside the project', () => {
    const env = ownEnv({HOME: '/home/u', DISPLAY: ':0', PATH: ['.', 'node_modules/.bin', join(project.root, 'node_modules', '.bin'), outside.root, '/usr/bin'].join(delimiter)});
    const {env: child, cwd} = launchOptions(env, project.root);
    expect(child.PATH).toBe([outside.root, '/usr/bin'].join(delimiter));
    expect({HOME: child.HOME, DISPLAY: child.DISPLAY}).toEqual({HOME: '/home/u', DISPLAY: ':0'});
    expect(isAbsolute(cwd)).toBe(true);
    expect(relative(project.root, realpathSync(cwd)).startsWith('..')).toBe(true);
    // Windows spells it Path: one entry is left
    expect(Object.keys(launchOptions({Path: '/usr/bin', A: '1'}, project.root).env).sort()).toEqual(['A', 'PATH']);
  });

  it.skipIf(process.platform === 'win32')('an editor launcher that looks up its interpreter on PATH never runs one the repository supplies', async () => {
    const markers = {repo: join(outside.root, 'repo-bash-ran'), user: join(outside.root, 'user-code-ran')};
    const userbin = join(outside.root, 'userbin');
    await mkdir(userbin, {recursive: true});
    await writeFile(join(userbin, 'code'), `#!/usr/bin/env bash\necho "$*" >> '${markers.user}'\n`, {mode: 0o755});
    await writeFile(join(project.root, 'bash'), `#!/bin/sh\necho "$*" >> '${markers.repo}'\nexec /bin/sh "$@"\n`, {mode: 0o755});
    const env = ownEnv({...process.env, PATH: ['.', userbin, '/usr/bin', '/bin'].join(delimiter)});
    const ran = async (marker: string) => {
      for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 50));
      return existsSync(marker);
    };
    // as before the fix: the user's environment and the project as the working directory
    detachedLauncher(join(userbin, 'code'), ['-g', 'a.ts:1'], {env, cwd: project.root});
    expect(await ran(markers.repo)).toBe(true);
    await rm(markers.repo, {force: true});
    await rm(markers.user, {force: true});
    detachedLauncher(join(userbin, 'code'), ['-g', 'a.ts:1'], launchOptions(env, project.root));
    expect(await ran(markers.user)).toBe(true);
    expect(existsSync(markers.repo)).toBe(false);
  });
});
describe('portCandidates', () => {
  it('GLIMPSE_PORT or 4517, then the next 19, then an ephemeral port', () => {
    const fallback = portCandidates({});
    expect(fallback).toHaveLength(21);
    expect(fallback.slice(0, 3)).toEqual([4517, 4518, 4519]);
    expect(fallback.at(-2)).toBe(4536);
    expect(fallback.at(-1)).toBe(0);
    expect(portCandidates({GLIMPSE_PORT: '5000'}).slice(0, 2)).toEqual([5000, 5001]);
    expect(portCandidates({GLIMPSE_PORT: '0'})).toEqual([0]);
    expect(portCandidates({GLIMPSE_PORT: 'abc'})[0]).toBe(4517);
    expect(portCandidates({GLIMPSE_PORT: '99999'})[0]).toBe(4517);
    expect(portCandidates({GLIMPSE_PORT: '65530'})).toEqual([65530, 65531, 65532, 65533, 65534, 65535, 0]);
  });
});

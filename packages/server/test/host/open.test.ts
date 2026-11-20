// Desktop launching: which command is built for the tab and the editor, and when nothing is opened at all.
import {chmod, writeFile} from 'node:fs/promises';
import {delimiter, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {portCandidates} from '../../src/host/host.ts';
import {canOpen, editorCommand, onPath, osOpenCommand} from '../../src/host/open.ts';
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
});

describe('editorCommand', () => {
  const none = () => false;

  it('fills the GLIMPSE_EDITOR template inside single arguments', () => {
    expect(editorCommand('/repo/src/a b.ts', 12, {GLIMPSE_EDITOR: 'code -g {file}:{line}'}, 'darwin', none)).toEqual(['code', ['-g', '/repo/src/a b.ts:12']]);
    expect(editorCommand('/repo/a.ts', undefined, {GLIMPSE_EDITOR: '  nvim   +{line}   {file} '}, 'linux', none)).toEqual(['nvim', ['+1', '/repo/a.ts']]);
    expect(editorCommand('/repo/a.ts', 3, {GLIMPSE_EDITOR: 'subl'}, 'linux', none)).toEqual(['subl', ['/repo/a.ts']]);
  });

  it('a hostile file name stays one argument and is never interpreted', () => {
    const file = '/repo/$(touch pwned); `id` && x.ts';
    expect(editorCommand(file, 1, {GLIMPSE_EDITOR: 'code -g {file}:{line}'}, 'darwin', none)).toEqual(['code', ['-g', `${file}:1`]]);
  });

  it('otherwise picks the first known editor on PATH, else the OS opener', () => {
    expect(editorCommand('/repo/a.ts', 7, {}, 'darwin', name => name === 'cursor' || name === 'zed')).toEqual(['cursor', ['-g', '/repo/a.ts:7']]);
    expect(editorCommand('/repo/a.ts', 7, {}, 'darwin', name => name === 'zed')).toEqual(['zed', ['/repo/a.ts:7']]);
    expect(editorCommand('/repo/a.ts', -4, {}, 'darwin', name => name === 'code')).toEqual(['code', ['-g', '/repo/a.ts:1']]);
    expect(editorCommand('/repo/a.ts', 7, {}, 'linux', none)).toEqual(['xdg-open', ['/repo/a.ts']]);
  });
});

describe('onPath', () => {
  let dir: Awaited<ReturnType<typeof tempRoot>>;
  beforeAll(async () => {
    dir = await tempRoot();
    await writeFile(join(dir.root, 'myeditor'), '#!/bin/sh\n');
    await chmod(join(dir.root, 'myeditor'), 0o755);
    await writeFile(join(dir.root, 'notexec'), 'x');
    await chmod(join(dir.root, 'notexec'), 0o644);
  });
  afterAll(() => dir.cleanup());

  it.skipIf(process.platform === 'win32')('finds executables in PATH directories only', () => {
    const env = {PATH: ['/nonexistent-dir', dir.root].join(delimiter)};
    expect(onPath('myeditor', env)).toBe(true);
    expect(onPath('notexec', env)).toBe(false);
    expect(onPath('missing', env)).toBe(false);
    expect(onPath('myeditor', {})).toBe(false);
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

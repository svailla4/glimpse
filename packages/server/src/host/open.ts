// Launching things on the user's desktop: the viewer tab and the editor. Always an argument vector, never a shell,
// detached, with no stdio (stdout is the JSON-RPC channel).
import {spawn} from 'node:child_process';
import {accessSync, constants} from 'node:fs';
import {delimiter, join} from 'node:path';

export type Launcher = (command: string, args: string[]) => void;

export const detachedLauncher: Launcher = (command, args) => {
  const child = spawn(command, args, {stdio: 'ignore', detached: true, windowsHide: true});
  // A missing opener must not crash the server; the caller has already reported the URL.
  child.on('error', () => {});
  child.unref();
};

/** False under GLIMPSE_NO_OPEN=1 and where there is no desktop to open anything on (SSH, CI, Linux without a display). */
export function canOpen(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (env.GLIMPSE_NO_OPEN === '1' || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/**
 * The OS opener, for the viewer's own http://127.0.0.1 URL and nothing else. A file of the repository is never
 * handed to it: the desktop would run whatever the file says it is (a .command script, an .app bundle, a .jar).
 * On Windows this avoids `cmd /c start`, which would parse the argument.
 */
export function osOpenCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\//.test(url)) throw new Error('the OS opener is only used for the viewer URL');
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

export function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        accessSync(join(dir, name + extension), constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

const goto = (file: string, line: number) => ['-g', `${file}:${line}`];
const colon = (file: string, line: number) => [`${file}:${line}`];
const lineFlag = (file: string, line: number) => ['--line', String(line), file];

/** Editors Glimpse knows how to point at a line, in order of preference. Each opens a file as text and runs nothing. */
const EDITORS: Array<{bin: string; args(file: string, line: number): string[]}> = [
  {bin: 'code', args: goto},
  {bin: 'cursor', args: goto},
  {bin: 'windsurf', args: goto},
  {bin: 'codium', args: goto},
  {bin: 'code-insiders', args: goto},
  {bin: 'zed', args: colon},
  {bin: 'subl', args: colon},
  {bin: 'idea', args: lineFlag},
  {bin: 'webstorm', args: lineFlag},
  {bin: 'pycharm', args: lineFlag},
  {bin: 'goland', args: lineFlag},
];

export const NO_EDITOR = 'no editor to open files with: set GLIMPSE_EDITOR (for example "code -g {file}:{line}") or put code, cursor, zed, subl or a JetBrains launcher on PATH';

/**
 * The command that opens `file` (absolute) at `line`: the GLIMPSE_EDITOR template (`code -g {file}:{line}`), else the
 * first known editor on PATH, else undefined. There is no further fallback: the OS opener would execute what it is
 * given. The template is split on whitespace; {file} and {line} are substituted inside single arguments, so a path
 * with spaces stays one argument. `env` must be the start-up copy (session/env.ts), never a live object.
 */
export function editorCommand(
  file: string, line: number | undefined, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform, has: (name: string) => boolean = name => onPath(name, env, platform),
): [string, string[]] | undefined {
  const at = line !== undefined && Number.isInteger(line) && line > 0 ? line : 1;
  const template = Object.hasOwn(env, 'GLIMPSE_EDITOR') ? env.GLIMPSE_EDITOR?.trim() : undefined;
  if (template) {
    const [command, ...rest] = template.split(/\s+/);
    const args = rest.map(arg => arg.replaceAll('{file}', file).replaceAll('{line}', String(at)));
    if (!template.includes('{file}')) args.push(file);
    return [command!, args];
  }
  const editor = EDITORS.find(candidate => has(candidate.bin));
  return editor ? [editor.bin, editor.args(file, at)] : undefined;
}

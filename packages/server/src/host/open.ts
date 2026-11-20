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

/** The OS opener for a URL or a file. On Windows this avoids `cmd /c start`, which would parse the argument. */
export function osOpenCommand(target: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [target]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', target]];
  return ['xdg-open', [target]];
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

/** Editors Glimpse knows how to point at a line, in order of preference. */
const EDITORS: Array<{bin: string; args(file: string, line: number): string[]}> = [
  {bin: 'code', args: (file, line) => ['-g', `${file}:${line}`]},
  {bin: 'cursor', args: (file, line) => ['-g', `${file}:${line}`]},
  {bin: 'zed', args: (file, line) => [`${file}:${line}`]},
];

/**
 * The command that opens `file` (absolute) at `line`: the GLIMPSE_EDITOR template (`code -g {file}:{line}`), else the
 * first known editor on PATH, else the OS opener. The template is split on whitespace; {file} and {line} are
 * substituted inside single arguments, so a path with spaces stays one argument.
 */
export function editorCommand(
  file: string, line: number | undefined, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform, has: (name: string) => boolean = name => onPath(name, env, platform),
): [string, string[]] {
  const at = line !== undefined && Number.isInteger(line) && line > 0 ? line : 1;
  const template = env.GLIMPSE_EDITOR?.trim();
  if (template) {
    const [command, ...rest] = template.split(/\s+/);
    const args = rest.map(arg => arg.replaceAll('{file}', file).replaceAll('{line}', String(at)));
    if (!template.includes('{file}')) args.push(file);
    return [command!, args];
  }
  const editor = EDITORS.find(candidate => has(candidate.bin));
  return editor ? [editor.bin, editor.args(file, at)] : osOpenCommand(file, platform);
}

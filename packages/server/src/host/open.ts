// Launching things on the user's desktop: the viewer tab and the editor. Always an argument vector, never a shell,
// detached, with no stdio (stdout is the JSON-RPC channel).
import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {delimiter, dirname, isAbsolute, relative, sep} from 'node:path';
import {findProgram, trustedPath} from '../session/paths.ts';

/** The environment and working directory a program started on the desktop gets (launchOptions). */
export interface LaunchOptions { env: NodeJS.ProcessEnv; cwd: string }

export type Launcher = (command: string, args: string[], options: LaunchOptions) => void;

export const detachedLauncher: Launcher = (command, args, options) => {
  const child = spawn(command, args, {stdio: 'ignore', detached: true, windowsHide: true, env: options.env, cwd: options.cwd});
  // A missing opener must not crash the server; the caller has already reported the URL.
  child.on('error', () => {});
  child.unref();
};

const within = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
};

/** A directory outside the project to start programs in: the home directory, else the temporary one, else the root's parent. */
function outsideDir(root: string): string {
  for (const candidate of [homedir(), tmpdir()]) {
    try {
      const real = realpathSync(candidate);
      if (!within(root, real) && !within(root, candidate)) return candidate;
    } catch {
      // not there
    }
  }
  return dirname(root);
}

/**
 * Finding V019, the launcher half: the program found by its absolute path may itself look things up on PATH. An editor
 * launcher starts with `#!/usr/bin/env bash` (VS Code's and Cursor's do), and xdg-open is a shell script that finds
 * its helpers on PATH, so a repository-committed `./bash` ran whenever PATH held `.` and the server ran in the
 * project. The child gets the user's environment with PATH cut to the trusted directories (trustedPath) and a working
 * directory outside the project.
 */
export function launchOptions(env: NodeJS.ProcessEnv, root: string): LaunchOptions {
  const out = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(env)) {
    const value = env[key];
    // Windows spells it Path; one PATH entry is left.
    if (typeof value === 'string' && key.toUpperCase() !== 'PATH') out[key] = value;
  }
  out.PATH = trustedPath(env, root).join(delimiter);
  return {env: out, cwd: outsideDir(root)};
}

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

/** How a program name becomes the absolute path that is started; findProgram (session/paths.ts) in production. */
export interface ProgramLookup {
  /** Realpath of the project: no program is taken from inside it (finding V019). */
  root: string;
  platform?: NodeJS.Platform;
  which?: (name: string) => string | undefined;
}

/**
 * The absolute path to start for `command`: an absolute path as it is (the user wrote it), a bare name as found in an
 * absolute PATH directory outside the project, and nothing for a relative path (`./code`), which would be resolved
 * against whatever directory the server runs in.
 */
export function programFor(command: string, env: NodeJS.ProcessEnv, lookup: ProgramLookup): string | undefined {
  if (isAbsolute(command)) return command;
  if (command.includes('/') || command.includes('\\')) return undefined;
  return (lookup.which ?? (name => findProgram(name, env, lookup.root, lookup.platform)))(command);
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

export const NO_EDITOR = 'no editor to open files with: set GLIMPSE_EDITOR (for example "code -g {file}:{line}") or put code, cursor, zed, subl or a JetBrains launcher on PATH (an absolute directory outside the project)';

/**
 * The command that opens `file` (absolute) at `line`: the GLIMPSE_EDITOR template (`code -g {file}:{line}`), else the
 * first known editor on PATH, else undefined. The program is always an absolute path (programFor). There is no further
 * fallback: the OS opener would execute what it is given. The template is split on whitespace; {file} and {line} are
 * substituted inside single arguments, so a path with spaces stays one argument. `env` must be the start-up copy
 * (session/env.ts), never a live object.
 */
export function editorCommand(file: string, line: number | undefined, env: NodeJS.ProcessEnv, lookup: ProgramLookup): [string, string[]] | undefined {
  const at = line !== undefined && Number.isInteger(line) && line > 0 ? line : 1;
  const template = Object.hasOwn(env, 'GLIMPSE_EDITOR') ? env.GLIMPSE_EDITOR?.trim() : undefined;
  if (template) {
    const [command, ...rest] = template.split(/\s+/);
    const program = programFor(command!, env, lookup);
    if (!program) return undefined;
    const args = rest.map(arg => arg.replaceAll('{file}', file).replaceAll('{line}', String(at)));
    if (!template.includes('{file}')) args.push(file);
    return [program, args];
  }
  for (const candidate of EDITORS) {
    const program = programFor(candidate.bin, env, lookup);
    if (program) return [program, candidate.args(file, at)];
  }
  return undefined;
}

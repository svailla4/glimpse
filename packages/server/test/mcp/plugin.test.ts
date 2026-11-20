// The plugin scaffold (design 6.9): manifests that agree with the server, a generated skill that is not stale, and a
// build script whose bundle starts from an empty directory.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {isBuiltin} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SKILL_DESCRIPTION, skillMarkdown} from '@glimpse/catalog';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {PENDING_CONTEXT_DESCRIPTION} from '../../src/mcp/pendingContext.ts';
import {VERSION} from '../../src/mcp/version.ts';
import {tempRoot} from '../session/fakes.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const readJson = async (path: string) => JSON.parse(await readFile(join(repo, path), 'utf8')) as Record<string, any>;

describe('plugin manifests', () => {
  it('plugin.json names the plugin, carries the server version and no licence claim', async () => {
    const manifest = await readJson('plugin/.claude-plugin/plugin.json');
    expect(manifest).toMatchObject({name: 'glimpse', version: VERSION, license: 'UNLICENSED', network: {hosts: []}});
    expect(manifest.description.length).toBeGreaterThan(40);
  });

  it('.mcp.json starts the bundled server from the plugin root', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is Claude Code's, expanded when the plugin loads
    const bundle = '${CLAUDE_PLUGIN_ROOT}/dist/server.mjs';
    expect(await readJson('plugin/.mcp.json')).toEqual({mcpServers: {glimpse: {command: 'node', args: [bundle]}}});
  });

  it('the UserPromptSubmit hook calls pending_context on the plugin server', async () => {
    const hooks = await readJson('plugin/hooks/hooks.json');
    expect(hooks).toEqual({hooks: {UserPromptSubmit: [{hooks: [{type: 'mcp_tool', server: 'plugin:glimpse:glimpse', tool: 'pending_context', timeout: 5}]}]}});
    expect(PENDING_CONTEXT_DESCRIPTION).toMatch(/hook/);
  });

  it('the repository is its own marketplace, pointing at ./plugin', async () => {
    const marketplace = await readJson('.claude-plugin/marketplace.json');
    expect(marketplace.plugins).toEqual([expect.objectContaining({name: 'glimpse', source: './plugin'})]);
    expect(typeof marketplace.owner.name).toBe('string');
  });

  it('SKILL.md is the generated skill, not a stale or hand-edited copy', async () => {
    const skill = await readFile(join(repo, 'plugin/skills/glimpse/SKILL.md'), 'utf8');
    expect(skill).toBe(skillMarkdown());
    expect(skill.startsWith(`---\nname: glimpse\ndescription: ${SKILL_DESCRIPTION}\n---\n`)).toBe(true);
  });

  it('the plugin README is long enough for the plugin directory and mentions every tool', async () => {
    const readme = await readFile(join(repo, 'plugin/README.md'), 'utf8');
    expect(readme.split(/\s+/).length).toBeGreaterThan(40);
    for (const tool of ['show', 'catalog', 'query', 'events', 'pending_context']) expect(readme).toContain(`\`${tool}\``);
  });

  it('no plugin file contains a local path, an address or a token', async () => {
    for (const file of ['plugin/.claude-plugin/plugin.json', 'plugin/.mcp.json', 'plugin/hooks/hooks.json', 'plugin/README.md', 'plugin/skills/glimpse/SKILL.md', '.claude-plugin/marketplace.json']) {
      const text = await readFile(join(repo, file), 'utf8');
      expect(text, file).not.toMatch(/\/Users\/|\/home\/[a-z]|[\w.+-]+@[\w-]+\.[a-z]{2,}\b(?!\/)/i);
    }
  });
});

describe('scripts/build.mjs', () => {
  let dir: Awaited<ReturnType<typeof tempRoot>>;
  beforeAll(async () => {
    dir = await tempRoot();
  });
  afterAll(() => dir.cleanup());
  const build = (...args: string[]) => spawnSync(process.execPath, [join(repo, 'scripts/build.mjs'), ...args], {cwd: repo, encoding: 'utf8', env: {PATH: process.env.PATH ?? ''}});

  it('bundles the server into one file that starts from an empty directory with no node_modules', () => {
    const out = join(dir.root, 'dist');
    const result = build('--server', '--out', out);
    expect(result.stderr + result.stdout).toMatch(/build: server\s+ok\s/);
    expect(result.stdout).toMatch(/build: skill\s+ok\s/);
    expect(result.stdout).toMatch(/build: verify\s+ok\s+the bundle starts from an empty directory, lists 5 tools, renders the gallery, has no viewer next to it yet \(the page says so\) and exits when stdin closes/);
    expect(result.status).toBe(0);
    expect(existsSync(join(out, 'server.mjs'))).toBe(true);
    expect(existsSync(join(out, 'viewer'))).toBe(false);
  }, 120_000);

  it('the bundle has no bare imports left and embeds no absolute path of this machine', async () => {
    const file = join(dir.root, 'dist', 'server.mjs');
    expect((await stat(file)).size).toBeGreaterThan(500_000);
    const text = await readFile(file, 'utf8');
    const imports = [...text.matchAll(/^import\s[^'"]*['"]([^'"]+)['"];?$/gm)].map(m => m[1]!);
    expect(imports.filter(name => !isBuiltin(name))).toEqual([]);
    expect(text.includes(repo)).toBe(false);
  });

  it('rejects options it does not know', () => {
    const result = build('--bogus');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown option --bogus/);
    expect(build('--out').status).toBe(2);
  });
});

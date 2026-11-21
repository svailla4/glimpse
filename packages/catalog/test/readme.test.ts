// The README is the first thing a reader meets, so what it shows must be true: the example specs compile, the files
// they name exist, and the tables list what the catalog actually has.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  COMPONENTS, INSTRUCTIONS_BUDGET, INSTRUCTIONS_TARGET, SOURCE_BY_NAME, SOURCES, VIEW_INDEX, formatRef, notationKind, parseFileLoc, parseNotation, serverInstructions, type A2uiMessage,
} from '../src/index.ts';
import {compileExpress, expandRefs, strictErrors} from '../testing/index.ts';
import {readText} from './support.ts';

const repoFile = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const readme = readText('../../../README.md');
const pluginReadme = readText('../../../plugin/README.md');

/** The section between `## <title>` and the next `## `. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, `section "${title}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}
const fenced = (text: string) => [...text.matchAll(/```\n([\s\S]*?)\n```/g)].map(m => m[1]!);

describe('README: the example specs', () => {
  const specs = fenced(section(readme, 'Writing a custom spec'));

  it('has three examples, each with the id it was run under', () => {
    expect(specs).toHaveLength(3);
    const ids = [...section(readme, 'Writing a custom spec').matchAll(/\(`id: "([^"]+)"`\)/g)].map(m => m[1]!);
    expect(ids).toHaveLength(3);
    // hyphens are part of what the README shows working
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/);
    expect(ids.some(id => id.includes('-'))).toBe(true);
  });

  it.each(specs.map((spec, i) => [i + 1, spec] as const))('example %i compiles, is strictly valid, and names sources and files that exist', (_n, spec) => {
    const messages = compileExpress('readme', spec);
    const refs = expandRefs(messages);
    expect(strictErrors(messages)).toEqual([]);
    for (const ref of refs.values()) expect(SOURCE_BY_NAME.has(ref.source), formatRef(ref)).toBe(true);
    const create = messages[0] as Extract<A2uiMessage, {createSurface: unknown}>;
    const components = create.createSurface.components as unknown as Array<Record<string, unknown>>;
    expect(components[0]).toMatchObject({id: 'root', component: 'Page'});
    // a diagram grows to 640 px by itself: size s, m or l only cuts it short (review finding, swap round)
    const diagrams = new Set<string>(COMPONENTS.filter(def => def.family === 'diagram').map(def => def.name));
    expect(components.filter(c => diagrams.has(String(c.component)) && ['s', 'm', 'l'].includes(String(c.size))).map(c => c.id)).toEqual([]);
    const files: string[] = [];
    for (const component of components) {
      if (['CodeView', 'FileRef', 'SymbolOutline'].includes(String(component.component)) && typeof component.file === 'string') files.push(component.file);
      if (typeof component.text === 'string') for (const m of component.text.matchAll(/\[\[([^\]]+)\]\]/g)) files.push(m[1]!);
    }
    for (const file of files) expect(existsSync(repoFile(parseFileLoc(file).path)), `${file} exists in this repository`).toBe(true);
    // a path scope in a source ref is a directory of this repository
    for (const ref of refs.values()) if (ref.target && /^[\w./-]+$/.test(ref.target) && ref.target.includes('/')) expect(existsSync(repoFile(ref.target)), formatRef(ref)).toBe(true);
  });

  it('between them the examples use a source ref, a slot, a diagram notation, a code view and an input', () => {
    const all = specs.join('\n');
    for (const needle of ["Graph('deps.modules", "DataTable('git.churn", 'SequenceDiagram(', 'CodeView(', 'Steps($/plan', '$/plan=[', 'ERDiagram(', 'Ask(']) expect(all, needle).toContain(needle);
  });
});

describe('README: what it lists is what exists', () => {
  it('names every component, every source and every preset', () => {
    for (const def of COMPONENTS) expect(section(readme, 'Components'), def.name).toContain(`\`${def.name}\``);
    for (const source of SOURCES) expect(section(readme, 'Data sources'), source.name).toContain(`\`${source.name}\``);
    for (const entry of VIEW_INDEX.split(' | ')) expect(section(readme, 'Views'), entry).toContain(`| \`${entry}\` |`);
    expect(section(readme, 'Components')).toMatch(new RegExp(`^${COMPONENTS.length} components in seven families`, 'm'));
  });

  it('gives the hosted install, the build-from-source route and a plain MCP server, and says where dist comes from', () => {
    const install = section(readme, 'Install');
    for (const command of ['claude plugin marketplace add svailla4/glimpse', 'claude plugin install glimpse@glimpse', 'claude plugin update glimpse@glimpse', 'npm install', 'npm run build', 'claude --plugin-dir /path/to/glimpse/plugin']) {
      expect(install, command).toContain(command);
    }
    expect(install).toMatch(/`plugin\/dist`[^.]*is not committed on `main`/);
    expect(install).toContain('release.yml');
    expect(install).toContain('"args": ["/path/to/glimpse/plugin/dist/server.mjs", "--root", "/path/to/your/project"]');
    expect(pluginReadme).toMatch(/not committed on `main`/);
    for (const command of ['claude plugin marketplace add svailla4/glimpse', 'claude plugin install glimpse@glimpse', 'npm install', 'npm run build', 'claude --plugin-dir']) expect(pluginReadme, command).toContain(command);
  });

  it('has the sections a reader needs: status, tools, security model, limitations', () => {
    expect(readme).toMatch(/\*\*Status: version 0\.1\.0/);
    for (const tool of ['show', 'catalog', 'query', 'events', 'pending_context']) {
      expect(section(readme, 'Tools'), tool).toContain(`| \`${tool}\` |`);
      expect(pluginReadme, tool).toContain(`| \`${tool}\` |`);
    }
    expect(section(readme, 'Security model')).toMatch(/127\.0\.0\.1/);
    expect(section(readme, 'Status and known limitations')).toMatch(/macOS only/);
  });

  it('gives the instructions length as it is, and the behaviour of this round: render reports, field repair, by=module', () => {
    const now = serverInstructions().length.toLocaleString('en-US');
    expect(section(readme, 'Development')).toContain(`| Server instructions | ${INSTRUCTIONS_TARGET.toLocaleString('en-US')} chars (hard limit ${INSTRUCTIONS_BUDGET.toLocaleString('en-US')}) | ${now} |`);
    const tools = section(readme, 'Tools');
    expect(tools).toMatch(/truthful empty state .* prints nothing/);
    expect(tools).toMatch(/rides once on a later tool result as a `viewer: error` line, and only if it is still that component's state/);
    expect(tools).toContain("`fixed x 'churn' -> 'commits'`");
    expect(section(readme, 'Data sources')).toContain("`'git.churn by=module'`");
    const graphs = SOURCES.filter(s => s.kind === 'graph').map(s => `\`${s.name}\``);
    expect(section(readme, 'Data sources')).toContain(`Three sources are graphs (${graphs.join(', ')}) and are drawn with \`Graph\``);
    expect(graphs).toHaveLength(3);
  });

  // Data as text: the section names every component whose data takes a notation (the Rows charts as 'the charts that
  // take rows'), and the examples it gives parse as it says.
  it('says which components take data as text, and its notation examples parse as it says', () => {
    const data = section(readme, 'Data sources');
    for (const def of COMPONENTS) {
      if (!Object.keys(def.props).some(key => notationKind(def.name, key) !== undefined)) continue;
      if (def.family === 'chart') expect(data, def.name).toContain('`List` and the charts that take rows');
      else expect(data, def.name).toContain(`\`${def.name}\``);
    }
    expect(parseNotation('tasks', '- [x] A\n- [~] B')).toEqual({ok: true, ast: [{title: 'A', status: 'done'}, {title: 'B', status: 'doing'}]});
    expect(parseNotation('table', '| v | n |\n|---|---|\n| 007 | 1,866 |\n| 1.10 | 12 |')).toMatchObject({ok: true, ast: [{v: '007', n: 1866}, {v: '1.10', n: 12}]});
    const graph = parseNotation('graph', 'graph LR\na[A<br>sub]:::gone --> b:::modified\nstyle a fill:#f00\nclick a "src/a.ts#L10-20"');
    expect(graph).toMatchObject({ok: true, ast: {nodes: [{id: 'a', label: 'A', sub: 'sub', status: 'deleted', file: 'src/a.ts#L10-20'}, {id: 'b', status: 'modified'}]}});
    for (const slip of [['keyValue', 'Tests:true'], ['graph', 'a:::hot --> b'], ['table', '| a |\n| 1 |']] as const) {
      const result = parseNotation(slip[0], slip[1]);
      expect(result.ok && result.fixes?.length, slip[1]).toBe(1);
    }
  });

  it('carries no absolute local path, user name or token', () => {
    for (const text of [readme, pluginReadme]) expect(text).not.toMatch(/\/Users\/|\/home\/[a-z]|[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}\b(?!\/)/);
  });
});

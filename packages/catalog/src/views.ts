// packages/catalog/src/views.ts
// Preset views: plain Express templates. The server compiles them through the same pipeline as agent specs,
// so every named part can be patched later with show{id, spec}.
import {parseFileLoc} from './datasets.ts';
import {formatRef, parseRef, type SourceRef} from './sources.ts';

export interface ViewMeta {
  name: string;
  doc: string;
  target?: 'path' | 'range' | 'symbol';
  targetRequired?: boolean;
  /** Data slots the agent may fill: path -> meaning. */
  slots?: Record<string, string>;
  /** Named parts the agent is expected to replace: part -> what to put there. Shown by catalog{names:['view:x']}. */
  replace?: Record<string, string>;
  /** Returns Express source (single-quoted strings allowed). `t` is the positional target, already validated. */
  build(t: string | undefined, args: Record<string, string>): string;
}

/** Escapes a value for use inside a single-quoted Express string. */
const s = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
/** 'git.churn' + scope/args -> quoted ref literal. */
const r = (source: string, target?: string, args: Record<string, string> = {}) =>
  `'${s(formatRef({source, target, args} as SourceRef))}'`;
/**
 * Files no import analysis reads (prose, data, patches, images) or with no extension at all (LICENSE, Dockerfile):
 * their 'Imports and importers' graph is a single node (finding V050), so the file preset leaves it out.
 */
const NO_IMPORTS = /(?:^|\/)[^/.]+$|\.(?:md|mdx|markdown|txt|rst|adoc|diff|patch|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|lock|csv|tsv|xml|svg|png|jpe?g|gif|webp|ico|pdf|log|snap)$/i;

const pick = (args: Record<string, string>, ...keys: string[]) =>
  Object.fromEntries(keys.filter(k => args[k] != null).map(k => [k, args[k]!]));

export const VIEWS: readonly ViewMeta[] = [
  {
    name: 'overview', doc: 'Atlas of the repo: KPIs, stack, treemap, languages, module graph, file cycles, activity, hotspots, packages.',
    slots: {'/notes': 'Commentary shown under the stack chips.'},
    build: () => `$/notes=''
root=Page($/meta/repo/name,[kpis,stack,notes,map,langs,deps,Plate('File cycles and external packages',[side],span=4),activity,hot,pkgs],'an atlas of the codebase')
kpis=Stats()
stack=Chips()
notes=Text($/notes)
map=Treemap(title='Where the code is',size='l',span=7)
langs=Plate('Languages',[SegmentedBar(),DataTable('files.langs')],span=5)
deps=Graph(title='How modules depend on each other',size='xl',span=8)
side=Tabs(['File cycles','External'],[DataTable('deps.cycles'),List('deps.external top=12')])
activity=LineChart('git.timeline',mode='stacked',title='Activity by module',span=6)
hot=DataTable('git.hotspots top=15','path commits:bar complexity:bar isTest:bool=Test owner',sort='-score',title='Hotspots',note='Commits x summed indentation depth, a proxy for complexity.',span=6)
pkgs=DataTable('repo.packages',title='Packages',note='One row per manifest file.')`,
  },
  {
    name: 'tree', doc: 'File browser: tree with churn heat beside code, outline and treemap tabs.', target: 'path',
    build: t => `root=Page('${s(t ?? 'Files')}',[Grid([tree,Tabs(['Code','Outline','Map'],[code,outline,map])],'1:2')])
tree=FileTree(${r('files.tree', t)},heat='churn',size='fill')
code=CodeView(size='fill')
outline=SymbolOutline(size='fill')
map=Treemap(${r('files.tree', t)},size='fill')`,
  },
  {
    name: 'deps', doc: 'Architecture map: module graph, heaviest edges, file cycles, dependency matrix, external packages.', target: 'path',
    slots: {'/notes': 'Commentary.'},
    build: t => `$/notes=''
root=Page('Dependencies',[notes,graph,edges,cycles,matrix,ext]${t ? `,'${s(t)}'` : ''})
notes=Text($/notes)
graph=Graph(${r('deps.modules', t)},title='Module dependencies',size='xl',span=8)
edges=DataTable(${r('deps.matrix', t)},'from to weight:bar',sort='-weight',title='Heaviest edges',size='xl',span=4)
cycles=DataTable(${r('deps.cycles', t)},title='File cycles',note='Import cycles between files; the graph marks cycles between modules.',span=6)
matrix=Heatmap(${r('deps.matrix', t)},title='Who imports whom',span=6)
ext=BarChart(${r('deps.external', t, {top: '20'})},title='External packages')`,
  },
  {
    name: 'hotspots', doc: 'Where change and complexity meet: scatter, churn treemap, ranking, co-change pairs.', target: 'path',
    slots: {'/notes': 'Commentary.'},
    build: (t, a) => `$/notes=''
root=Page('Hotspots',[notes,scatter,map,table,coupling]${t ? `,'${s(t)}'` : ''})
notes=Text($/notes)
scatter=ScatterPlot(${r('git.hotspots', t, pick(a, 'since'))},'commits','complexity',r='sloc',label='path',quadrants=true,title='Churn x complexity',note='Complexity is summed indentation depth, a proxy; dot size is non-blank lines.',size='l',span=7)
map=Treemap(${r('files.tree', t)},color='churn',title='Churn on the tree',size='l',span=5)
table=DataTable(${r('git.hotspots', t, {top: '50', ...pick(a, 'since')})},sort='-score',title='Ranking',span=7)
coupling=DataTable(${r('git.coupling', t)},title='Changes together',note='Pairs sharing 3 or more commits; commits touching over 30 files are ignored.',span=5)`,
  },
  {
    name: 'history', doc: 'Git history: daily activity, weekly activity by module, authors, most-changed files, log.', target: 'path',
    build: (t, a) => `root=Page('History',[cal,line,authors,churn,log]${t ? `,'${s(t)}'` : ''})
cal=CalendarHeatmap(${r('git.activity', t, pick(a, 'since'))},title='Commits per day')
line=LineChart(${r('git.timeline', t, pick(a, 'since'))},mode='stacked',title='Activity by module',span=7)
authors=BarChart(${r('git.authors', t, {top: '10', ...pick(a, 'since')})},title='Authors',span=5)
churn=DataTable(${r('git.churn', t, {top: '50', ...pick(a, 'since')})},title='Most changed files',span=6)
log=CommitList(${r('git.log', t)},title='Log',size='l',span=6)`,
  },
  {
    name: 'file', doc: 'One file in depth: code, outline, imports and importers, recent commits.', target: 'path', targetRequired: true,
    slots: {'/notes': 'Commentary.', '/marks': "CodeNote[] shown in the code gutter: [{line,text,kind?}]."},
    build: t => {
      const path = parseFileLoc(t!).path;
      const imports = !NO_IMPORTS.test(path);
      return `$/notes=''
$/marks=[]
root=Page('${s(path)}',[notes,Grid([code,Column([outline,log])],'2:1')${imports ? ',near' : ''}])
notes=Text($/notes)
code=CodeView('${s(t!)}',notes=$/marks,size='fill')
outline=SymbolOutline('${s(path)}',title='Outline',size='l')${imports ? `
near=Graph(${r('deps.files', path)},focus='${s(path)}',title='Imports and importers')` : ''}
log=CommitList(${r('git.log', path, {top: '10'})},title='Recent commits')`;
    },
  },
  {
    name: 'symbol', doc: 'Where an identifier is used: references grouped by file beside the code.', target: 'symbol', targetRequired: true,
    build: t => `root=Page('${s(t!)}',[refs,code])
refs=DataTable(${r('code.refs', t)},group='file',title='References',size='fill',span=5)
code=CodeView(title='Source',size='fill',span=7)`,
  },
  {
    name: 'stack', doc: 'Tooling: stack chips, packages, scripts, external dependencies, TODOs.',
    build: () => `root=Page('Stack',[chips,pkgs,scripts,ext,todos])
chips=Chips()
pkgs=DataTable('repo.packages',title='Packages',note='One row per manifest file.',span=7)
scripts=DataTable('repo.scripts',title='Scripts',span=5)
ext=BarChart('deps.external top=20',title='External packages',span=6)
todos=DataTable('code.todos',title='TODO / FIXME',span=6)`,
  },
  {
    name: 'diff', doc: "Review a change: stats, the diff with its file list, blast radius, commits. Range 'wt' (default), 'staged' or 'main..HEAD'.", target: 'range',
    slots: {'/notes': 'Review notes.'},
    build: t => {
      const range = t ?? 'wt';
      return `$/notes=''
root=Page('Changes',[kpis,notes,diff,impact,log],'${s(range)}')
kpis=Stats(${r('diff.stats', range)})
notes=Text($/notes)
diff=DiffView('${s(range)}',title='Diff',size='fill')
impact=Graph(${r('diff.impact', range)},title='Blast radius',span=7)
log=${range === 'wt' || range === 'staged' ? `List('code.todos top=8',title='Open TODOs',span=5)` : `CommitList(${r('git.log', range)},title='Commits',size='l',span=5)`}`;
    },
  },
  {
    name: 'feature', doc: 'Follow a feature while it is built: plan, design, notes, live working-tree diff, blast radius.',
    slots: {'/plan': "StepItem[]: [{title,note?,status?,file?,node?}] with status todo|doing|done|blocked|skipped.", '/notes': 'Notes.'},
    replace: {design: "the design drawing: $/design={nodes:{A:'Request',B:{label:'OK?',shape:'diamond'}},edges:[['A','B']]}; design=Flowchart($/design,title='Design'), or design=SequenceDiagram({steps:[...]})"},
    build: () => `$/plan=[]
$/notes=''
root=Page('Feature',[Grid([plan,design],'1:2'),notes,changes,impact],'working tree')
plan=Steps($/plan,title='Plan')
design=Text('No design drawn yet.','dim',title='Design')
notes=Text($/notes)
changes=DiffView(title='Working tree',size='xl')
impact=Graph('diff.impact wt',title='Blast radius')`,
  },
];

export const VIEW_BY_NAME: ReadonlyMap<string, ViewMeta> = new Map(VIEWS.map(v => [v.name, v]));

/**
 * 'diff main..HEAD' / 'file src/a.ts' / 'hotspots src since=90d' -> {view, target, args}. Same grammar as source refs.
 * A target written as a keyword ('hotspots path=src') comes back in `args`: the server's show tool turns it into
 * the target and reports the correction, so it is not hidden here.
 */
export function parseViewRef(text: string): {view: string; target?: string; args: Record<string, string>} {
  const ref = parseRef(text);
  return {view: ref.source, target: ref.target, args: ref.args};
}

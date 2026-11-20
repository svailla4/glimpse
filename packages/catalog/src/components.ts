// packages/catalog/src/components.ts
// THE catalog. One entry per component; key order of `props` is the Express positional order.
// Rules (enforced by test/lint.test.ts): no prop named id|component|metadata|catalogId|accessibility|checks;
// schemas are strict; no unions in static props; required props come first.
// Accepting a reasonable guess beats documenting the one right spelling: enum props list the other words authors
// write as `aliases` (the spec pipeline rewrites them and says so), and data shapes say which key spellings a
// component reads (datasets.ts). The shapes and one example each are in docs.ts (SHAPES).
import {component, minor, opt, p} from './props.ts';
import type {
  ChipItem, CodeNote, CommitRow, DirNode, ErData, GraphData, KeyValueData, LayerItem, ListItem, Rows, StatItem,
  StepItem, TourStop,
} from './datasets.ts';

// ---- shared prop groups -----------------------------------------------------------------------------------
/** Every component: columns it spans in the enclosing 12-column grid (Page, Section) or its flex share (Row). */
const CELL = {span: opt(p.int('Grid columns 1-12.', 1, 12))};
const SIZE_ALIASES = {xs: 's', sm: 's', small: 's', md: 'm', medium: 'm', lg: 'l', large: 'l', xlarge: 'xl', full: 'fill', auto: 'fill'} as const;
/**
 * Plate-able leaves: with `title` the component draws its own numbered plate frame; without it renders bare.
 * The viewer kit frames every non-layout component that carries all three of title, note and size (hasFrame).
 * Callout and CodeBlock take a `title` of their own (a lead-in, a header label) and no FRAME: they draw no plate.
 */
const FRAME = {
  title: opt(p.text('Plate title; draws the numbered frame.')),
  note: opt(p.text('Caption under the plate.')),
  size: opt(p.enum(['s', 'm', 'l', 'xl', 'fill'], 'Height 160/280/420/640px or fill the viewport.', SIZE_ALIASES)),
  ...CELL,
};

/**
 * True for components that carry the whole FRAME group (title, note, size): the docs list those props once, and the
 * viewer draws the numbered plate around them when they have a title. One rule for both.
 */
export function hasFrame(def: {family: string; props: object}): boolean {
  return def.family !== 'layout' && 'title' in def.props && 'note' in def.props && 'size' in def.props;
}
const GAP = opt(p.enum(['none', 's', 'm', 'l'], 'Gap 0/8/20/32px.', {'0': 'none', xs: 's', sm: 's', small: 's', md: 'm', medium: 'm', lg: 'l', large: 'l'}));
const ALIGN_ALIASES = {left: 'start', top: 'start', right: 'end', bottom: 'end', middle: 'center', centre: 'center'} as const;
const DIR_ALIASES = {td: 'TB', bt: 'TB', vertical: 'TB', down: 'TB', rl: 'LR', horizontal: 'LR', right: 'LR'} as const;
const TREE_VALUE_ALIASES = {lines: 'loc', sloc: 'loc', size: 'bytes', churn: 'commits'} as const;
const TREE_COLOR_ALIASES = {language: 'lang', commits: 'churn', heat: 'churn'} as const;

// ---- layout (8) ------------------------------------------------------------------------------------------------
export const Page = component('Page', {
  family: 'layout', chunk: 'layout', tier: 'A', allowedParents: ['Surface'],
  doc: 'View root: masthead (title, subtitle, repo provenance) over a 12-column grid.',
  example: "root=Page('Auth flow',[Markdown('Login goes through **AuthService**.')])",
}, {
  title: p.text('View title.'),
  children: p.children('Plates and other content, top to bottom.'),
  subtitle: opt(p.text('One line next to the title.')),
  width: minor(opt(p.enum(['page', 'wide', 'full'], 'Max width 1320px, 1680px or 100%.', {normal: 'page', default: 'page', fill: 'full'}))),
});

export const Plate = component('Plate', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Numbered hairline frame around several children.',
  example: "Plate('Languages',[SegmentedBar(),DataTable('files.langs')],span=5)",
}, {
  title: p.text('Plate title.'),
  children: p.children('Body, stacked vertically.'),
  note: opt(p.text('Caption under the plate.')),
  collapsed: minor(opt(p.flag('Start collapsed.'))),
  ...CELL,
});

export const Section = component('Section', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Heading with a rule; children sit on a nested 12-column grid.',
  example: "Section('History',[CalendarHeatmap(),CommitList()])",
}, {
  title: p.text('Section heading.'),
  children: p.children('Section content.'),
  subtitle: opt(p.text('One line under the heading.')),
  ...CELL,
});

export const Grid = component('Grid', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: "Columns: equal by default, or a ratio like '2:1'. Wraps on narrow screens.",
  example: "Grid([FileTree(),CodeView()],'1:2')",
}, {
  children: p.children('Cells, left to right.'),
  cols: opt(p.str("Column count '3' or ratio '2:1'. Default: one column per child (max 4).")),
  gap: GAP,
  ...CELL,
});

export const Row = component('Row', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Horizontal flex row; children share the width.',
  example: "Row([Stat(42,'files'),Stat('3.1k','loc')])",
}, {
  children: p.children('Items.'),
  gap: GAP,
  align: opt(p.enum(['start', 'center', 'end', 'stretch', 'baseline'], 'Cross-axis alignment.', ALIGN_ALIASES)),
  wrap: minor(opt(p.flag('Allow wrapping. Default true.'))),
  ...CELL,
});

export const Column = component('Column', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Vertical stack.',
  example: "Column([KeyValue($/info),SymbolOutline()])",
}, {
  children: p.children('Items.'),
  gap: GAP,
  align: opt(p.enum(['start', 'center', 'end', 'stretch'], 'Cross-axis alignment.', ALIGN_ALIASES)),
  ...CELL,
});

export const Tabs = component('Tabs', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Tab strip; one child per label, mounted on first activation.',
  example: "Tabs(['Map','Table'],[Treemap(),DataTable('files.list')])",
}, {
  labels: p.strings('Tab labels, one per child.'),
  children: p.children('One child per tab.'),
  ...CELL,
});

export const Split = component('Split', {
  family: 'layout', chunk: 'layout', tier: 'C',
  doc: 'Two resizable panes.',
  example: "Split(FileTree(),CodeView(),'1:2',size='fill')",
}, {
  start: p.child('Left/top pane.'),
  end: p.child('Right/bottom pane.'),
  ratio: opt(p.str("Initial ratio like '1:2'. Default '1:1'.")),
  dir: opt(p.enum(['row', 'col'], 'Side by side or stacked.', {horizontal: 'row', h: 'row', column: 'col', vertical: 'col', v: 'col'})),
  size: minor(opt(p.enum(['s', 'm', 'l', 'xl', 'fill'], 'Height.', SIZE_ALIASES))),
  ...CELL,
});

// ---- content (10) ----------------------------------------------------------------------------------------------
export const Text = component('Text', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Short text with inline `code`, *em*, **strong** and [[path#L10]] file refs.',
  example: "Text('Entry point is [[src/main.ts#L12]].','lead')",
}, {
  text: p.text('Text with inline micro-markup. No HTML.'),
  tone: opt(p.enum(['body', 'lead', 'dim', 'caption', 'mono'], 'Style.', {
    normal: 'body', default: 'body', muted: 'dim', secondary: 'dim', subtle: 'dim', small: 'caption', code: 'mono', heading: 'lead', title: 'lead',
  })),
  ...FRAME,
});

export const Markdown = component('Markdown', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Prose in Markdown (GFM tables, fenced code, [[path#L10]] refs). Raw HTML is ignored.',
  example: "Markdown($/notes)",
}, {
  text: p.text('Markdown source.'),
  ...FRAME,
});

export const Callout = component('Callout', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Marginal note with a coloured rule and tag.',
  example: "Callout('Reads the balance before taking the row lock.','risk',file='src/ledger/post.ts#L42')",
}, {
  text: p.text('Body (inline micro-markup).'),
  kind: opt(p.enum(['note', 'tip', 'warn', 'risk', 'decision', 'question'], 'Tag and colour. Default note.', {
    info: 'note', information: 'note', warning: 'warn', caution: 'warn', danger: 'risk', error: 'risk', critical: 'risk',
    success: 'tip', hint: 'tip', idea: 'tip',
  })),
  title: opt(p.text('Bold lead-in.')),
  file: opt(p.text("File anchor 'path#L10-20'.")),
  ...CELL,
});

export const KeyValue = component('KeyValue', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Definition grid; paths, numbers, lists and booleans format themselves.',
  example: "KeyValue({Language:'TypeScript',Entry:'src/main.ts',Tests:true})",
}, {
  data: p.data<KeyValueData>('KeyValueData', 'Object {Label:value} or [{k,v}].'),
  cols: opt(p.int('Columns 1-3. Default 1.', 1, 3)),
  ...FRAME,
});

export const Chips = component('Chips', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Row of mono chips with a colour dot.',
  example: "Chips(['React','Vite','PostgreSQL'])",
}, {
  data: opt(p.data<ChipItem[]>('ChipItem[]', 'Strings or [{label,tone?}].', 'repo.stack')),
  ...FRAME,
});

export const FileRef = component('FileRef', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Clickable path:line; click selects, Cmd-click opens the editor.',
  example: "FileRef('src/auth/service.ts#L20-58')",
}, {
  file: p.text("'path' or 'path#L10-20'."),
  label: opt(p.text('Text shown instead of the path.')),
  ...CELL,
});

export const Steps = component('Steps', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Numbered plan or walkthrough with status marks and a progress rule.',
  example: "Steps([{title:'Add the middleware',status:'done'},{title:'Wire the router',status:'doing'},{title:'Tests'}],title='Plan')",
}, {
  data: p.data<StepItem[]>('StepItem[]', '[{title,note?,status?,file?}]; status todo|doing|done|blocked|skipped.'),
  current: opt(p.number('Number of the active step, counting from 1 as drawn. Usually omitted: give that step status doing.')),
  ...FRAME,
});

export const Stat = component('Stat', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Hero numeral with label, delta and sparkline.',
  example: "Stat(1284,'files',delta=38)",
}, {
  value: p.data<number | string>('number|string', 'Number or short string.'),
  label: opt(p.text('Caption.')),
  delta: opt(p.number('Signed change.')),
  unit: opt(p.text('Unit after the value.')),
  spark: minor(opt(p.data<number[]>('number[]', 'Numbers for a sparkline.'))),
  format: minor(opt(p.enum(['num', 'compact', 'bytes', 'pct', 'duration'], 'Number format. Default compact.', {
    number: 'num', int: 'num', integer: 'num', full: 'num', short: 'compact', size: 'bytes', percent: 'pct', percentage: 'pct', time: 'duration', ms: 'duration',
  }))),
  ...CELL,
});

export const Stats = component('Stats', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'KPI strip: hairline-separated Stat cells.',
  example: "Stats([{label:'Files',value:412},{label:'Tests',value:1866,delta:12}])",
}, {
  data: opt(p.data<StatItem[]>('StatItem[]', '[{label,value,unit?,delta?,spark?,format?,tone?}].', 'repo.kpis')),
  ...FRAME,
});

// List draws ListItem[] as given. For any other rows (a dataset such as 'deps.external' or 'code.todos') each row
// becomes one item: title = row[roles.label], else the first field of kind text, path, symbol or module, else the
// first string cell; value = row[roles.value], else the first numeric field (none: no value and no bar);
// file = the row's `file` or `path` cell, which makes the title a file entity; sub = the first chip, lang or author
// field that is not the title. Rows without roles and without fields are sniffed from the first row.
export const List = component('List', {
  family: 'content', chunk: 'content', tier: 'B',
  doc: 'Ranked dense rows: title, dim subtitle, trailing value with a bar.',
  example: "List('deps.external top=8',title='External packages')",
}, {
  data: p.data<ListItem[]>('ListItem[]', '[{title,sub?,value?,file?}] or any rows dataset.'),
  limit: opt(p.int('Rows shown. Default 10.', 1, 200)),
  ...FRAME,
});

// ---- data (4) ----------------------------------------------------------------------------------------------------
export const DataTable = component('DataTable', {
  family: 'data', chunk: 'table', tier: 'A',
  doc: 'Virtualized sortable table; columns come from the dataset unless given.',
  example: "DataTable('git.hotspots top=25','path commits:bar complexity:bar owner',sort='-score',title='Hotspots')",
}, {
  data: p.data<Rows>('Rows', 'Rows: source ref, $/path or inline list of objects.'),
  columns: opt(p.str("Shorthand 'key[:kind][=Label] ...'. Kinds: text num bytes pct duration path symbol module author commit lang date bar heat spark chip delta code bool.")),
  sort: opt(p.str("'field' or '-field'.")),
  search: minor(opt(p.flag('Show the search box. Default: when more than 20 rows.'))),
  group: minor(opt(p.str('Group rows by this field.'))),
  ...FRAME,
});

export const FileTree = component('FileTree', {
  family: 'data', chunk: 'table', tier: 'A',
  doc: 'Directory tree with size bars, heat strip and extension badges.',
  example: "FileTree(heat='churn',size='fill')",
}, {
  data: opt(p.data<DirNode>('DirNode', 'Tree dataset.', 'files.tree')),
  metric: opt(p.enum(['loc', 'bytes', 'files', 'commits', 'changes', 'none'], 'Bar metric. Default loc.', {...TREE_VALUE_ALIASES, diff: 'changes', delta: 'changes'})),
  heat: opt(p.enum(['none', 'churn', 'age', 'complexity'], 'Heat strip. Default none.', {commits: 'churn'})),
  depth: minor(opt(p.int('Levels expanded initially. Default 2.', 0, 12))),
  ...FRAME,
});

export const CommitList = component('CommitList', {
  family: 'data', chunk: 'table', tier: 'B',
  doc: 'Git log rows: sha, subject, author, relative date, +/- bars.',
  example: "CommitList('git.log src/auth',title='Recent commits')",
}, {
  data: opt(p.data<CommitRow[]>('CommitRow[]', 'Commit rows.', 'git.log')),
  ...FRAME,
});

export const JsonView = component('JsonView', {
  family: 'data', chunk: 'table', tier: 'C',
  doc: 'Collapsible JSON/config tree.',
  example: "JsonView($/config,2)",
}, {
  data: p.data<unknown>('unknown', 'Any JSON value.'),
  depth: minor(opt(p.int('Levels expanded initially. Default 1.', 0, 12))),
  ...FRAME,
});

// ---- charts (10) ------------------------------------------------------------------------------------------------
export const Sparkline = component('Sparkline', {
  family: 'chart', chunk: 'content', tier: 'A',
  doc: 'Inline trend line with an end dot.',
  example: 'Sparkline([3,5,4,9,12])',
}, {
  data: p.data<number[]>('number[]', 'Numbers.'),
  kind: minor(opt(p.enum(['line', 'bar', 'area'], 'Default line.', {bars: 'bar', column: 'bar'}))),
  ...CELL,
});

export const SegmentedBar = component('SegmentedBar', {
  family: 'chart', chunk: 'content', tier: 'A',
  doc: 'Part-to-whole in one bar with a legend (use instead of a pie).',
  example: "SegmentedBar(title='Languages')",
}, {
  data: opt(p.data<Rows>('Rows', 'Rows.', 'files.langs')),
  label: opt(p.str('Segment field.')),
  value: opt(p.str('Value field.')),
  ...FRAME,
});

export const BarChart = component('BarChart', {
  family: 'chart', chunk: 'charts', tier: 'A',
  doc: 'Bars by category; horizontal when there are many or long labels.',
  example: "BarChart('git.authors top=8','author','commits',title='Who changes it')",
}, {
  data: p.data<Rows>('Rows', 'Rows.'),
  x: opt(p.str('Category field.')),
  y: opt(p.str('Value field(s), space separated.')),
  series: opt(p.str('Field that splits bars into series.')),
  mode: opt(p.enum(['grouped', 'stacked', 'pct'], 'Default grouped.', {group: 'grouped', stack: 'stacked', percent: 'pct', normalized: 'pct'})),
  dir: minor(opt(p.enum(['h', 'v'], 'Orientation. Default automatic.', {horizontal: 'h', row: 'h', vertical: 'v', column: 'v', col: 'v'}))),
  limit: minor(opt(p.int('Bars kept; the rest fold into Other. Default 20.', 1, 200))),
  ...FRAME,
});

export const LineChart = component('LineChart', {
  family: 'chart', chunk: 'charts', tier: 'A',
  doc: 'Lines or stacked areas over time or an ordered x, labelled at the line ends.',
  example: "LineChart('git.timeline',mode='stacked',title='Activity')",
}, {
  data: p.data<Rows>('Rows', 'Rows.'),
  x: opt(p.str('X field (date or number).')),
  y: opt(p.str('Value field(s), space separated.')),
  series: opt(p.str('Field that splits rows into series.')),
  mode: opt(p.enum(['line', 'area', 'stacked', 'pct'], 'Default line.', {lines: 'line', stack: 'stacked', percent: 'pct', normalized: 'pct'})),
  scale: minor(opt(p.enum(['linear', 'log'], 'Y scale.', {lin: 'linear', logarithmic: 'log'}))),
  ...FRAME,
});

export const ScatterPlot = component('ScatterPlot', {
  family: 'chart', chunk: 'charts', tier: 'B',
  doc: 'Points for two measures; optional radius, colour and outlier labels.',
  example: "ScatterPlot('git.hotspots','commits','complexity',r='sloc',label='path',quadrants=true)",
}, {
  data: p.data<Rows>('Rows', 'Rows.'),
  x: opt(p.str('X field.')),
  y: opt(p.str('Y field.')),
  r: opt(p.str('Radius field.')),
  color: opt(p.str('Category field for colour.')),
  label: opt(p.str('Label field (outliers are labelled).')),
  scale: minor(opt(p.enum(['linear', 'logx', 'logy', 'loglog'], 'Axis scales.', {log: 'loglog'}))),
  quadrants: minor(opt(p.flag('Draw median lines.'))),
  ...FRAME,
});

export const Histogram = component('Histogram', {
  family: 'chart', chunk: 'charts', tier: 'B',
  doc: 'Distribution of one numeric field with median and p90 marks.',
  example: "Histogram('files.list','loc',title='File sizes')",
}, {
  data: p.data<Rows | number[]>('Rows|number[]', 'Rows or numbers.'),
  value: opt(p.str('Numeric field.')),
  bins: minor(opt(p.int('Bin count. Default automatic.', 2, 80))),
  log: minor(opt(p.flag('Log-scale counts.'))),
  ...FRAME,
});

export const Heatmap = component('Heatmap', {
  family: 'chart', chunk: 'charts', tier: 'B',
  doc: 'Matrix of cells on a sequential or diverging ramp (also a dependency matrix).',
  example: "Heatmap('deps.matrix','to','from','weight',title='Who imports whom')",
}, {
  data: p.data<Rows>('Rows', 'Rows.'),
  x: opt(p.str('Column field.')),
  y: opt(p.str('Row field.')),
  value: opt(p.str('Cell field.')),
  mode: minor(opt(p.enum(['seq', 'div'], 'Ramp. Default seq.', {sequential: 'seq', diverging: 'div'}))),
  ...FRAME,
});

export const CalendarHeatmap = component('CalendarHeatmap', {
  family: 'chart', chunk: 'charts', tier: 'B',
  doc: 'Daily activity as week columns of day cells.',
  example: "CalendarHeatmap(title='Commits per day')",
}, {
  data: opt(p.data<Rows>('Rows', 'Rows.', 'git.activity')),
  date: opt(p.str('Date field.')),
  value: opt(p.str('Value field.')),
  ...FRAME,
});

export const Treemap = component('Treemap', {
  family: 'chart', chunk: 'charts', tier: 'A',
  doc: 'Zoomable nested rectangles sized by a metric.',
  example: "Treemap(color='churn',title='Where the code is')",
}, {
  data: opt(p.data<DirNode>('DirNode', 'Tree dataset.', 'files.tree')),
  value: opt(p.enum(['loc', 'bytes', 'files', 'commits'], 'Size metric. Default loc.', TREE_VALUE_ALIASES)),
  color: opt(p.enum(['lang', 'churn', 'age', 'complexity', 'depth', 'none'], 'Fill. Default lang.', TREE_COLOR_ALIASES)),
  depth: minor(opt(p.int('Levels shown. Default 2.', 1, 6))),
  ...FRAME,
});

export const Icicle = component('Icicle', {
  family: 'chart', chunk: 'charts', tier: 'C',
  doc: 'Hierarchy as stacked rows; click zooms a subtree.',
  example: "Icicle(title='Tree by size')",
}, {
  data: opt(p.data<DirNode>('DirNode', 'Tree dataset.', 'files.tree')),
  value: opt(p.enum(['loc', 'bytes', 'files', 'commits'], 'Size metric. Default loc.', TREE_VALUE_ALIASES)),
  color: opt(p.enum(['lang', 'churn', 'age', 'complexity', 'depth', 'none'], 'Fill. Default lang.', TREE_COLOR_ALIASES)),
  ...FRAME,
});

// ---- diagrams (5) --------------------------------------------------------------------------------------------
export const Graph = component('Graph', {
  family: 'diagram', chunk: 'diagrams', tier: 'A',
  doc: 'Node-link diagram on a dot grid: clusters, cycle marks, pan/zoom, focus on a node.',
  example: "Graph('deps.modules src/auth',title='How auth depends on the rest')",
}, {
  data: opt(p.data<GraphData>('GraphData', '{nodes:[{id,label}],edges:[{from,to}],groups?}.', 'deps.modules')),
  dir: opt(p.enum(['LR', 'TB'], 'Flow direction. Default LR.', DIR_ALIASES)),
  focus: opt(p.text('Node id to centre; its neighbourhood is emphasised.')),
  depth: opt(p.int('Hops shown around the focus. Default 1.', 1, 4)),
  ...FRAME,
});

export const Flowchart = component('Flowchart', {
  family: 'diagram', chunk: 'diagrams', tier: 'B',
  doc: 'Flowchart or state machine from Mermaid-style arrow notation.',
  example: "Flowchart('Req[Request] --> RL{Over limit?}; RL -->|no| H[Handler]; RL -->|yes| E([429])')",
}, {
  src: p.text("Statements split by ';' or newline: 'A[Label] --> B{Decision}', '-->|label|', '-.->' dashed. Shapes: [box] {diamond} ([pill]) [(store)] ((circle))."),
  dir: opt(p.enum(['TB', 'LR'], 'Flow direction. Default TB.', DIR_ALIASES)),
  ...FRAME,
});

export const SequenceDiagram = component('SequenceDiagram', {
  family: 'diagram', chunk: 'diagrams', tier: 'B',
  doc: 'Lifelines and messages from Mermaid-style sequence notation.',
  example: "SequenceDiagram('User->>API: POST /login; API->>Auth: verify; Auth-->>API: token; API-->>User: 200')",
}, {
  src: p.text("Statements split by ';' or newline: 'A->>B: call', 'B-->>A: reply', 'A-)B: async', 'Note over A,B: text'."),
  ...FRAME,
});

export const Layers = component('Layers', {
  family: 'diagram', chunk: 'diagrams', tier: 'B',
  doc: 'Architecture tiers: horizontal bands of boxes, top tier first.',
  example: "Layers([{name:'API',items:['routes','middleware']},{name:'Domain',items:['ledger','payouts']}])",
}, {
  data: p.data<LayerItem[]>('LayerItem[]', "[{name,items:['label'|{label,file?,note?}],note?}], top tier first."),
  ...FRAME,
});

export const ERDiagram = component('ERDiagram', {
  family: 'diagram', chunk: 'diagrams', tier: 'C',
  doc: 'Tables with column rows and key marks, joined by relation edges.',
  example: "ERDiagram([{name:'users',columns:[{name:'id',type:'uuid',pk:true},{name:'email'}]},{name:'orders',columns:[{name:'id',pk:true},{name:'user_id',fk:'users.id'}]}],title='Data model')",
}, {
  data: p.data<ErData>('ErData', "Tables [{name,columns:[{name,type?,pk?,fk?}]}], or {tables,relations}. fk:'users.id' draws the relation."),
  dir: minor(opt(p.enum(['LR', 'TB'], 'Layout direction. Default LR.', DIR_ALIASES))),
  ...FRAME,
});

// ---- code (5) ----------------------------------------------------------------------------------------------------
export const CodeBlock = component('CodeBlock', {
  family: 'code', chunk: 'code', tier: 'A',
  doc: 'Highlighted snippet you write yourself (short; for files on disk use CodeView).',
  example: "CodeBlock('const x = await limiter.take(ip)','ts')",
}, {
  code: p.text('Source text.'),
  lang: opt(p.str('Language id (ts, py, go, rust, sql, json, sh ...).')),
  mark: opt(p.str("Lines to highlight: '3,7-9' (or 'L3,L7-9').")),
  title: opt(p.text('Header label.')),
  ...CELL,
});

export const CodeView = component('CodeView', {
  family: 'code', chunk: 'code', tier: 'A',
  doc: 'A file read from disk: gutter, highlights, notes. Follows the selection when file is omitted.',
  example: "CodeView('src/auth/service.ts#L20-58',mark='31-36')",
}, {
  file: opt(p.text("'path' or 'path#L10-40'. Omit to follow the selected file.")),
  mark: opt(p.str("Lines of the file to highlight: '12-18,30' (or 'L12-18').")),
  notes: opt(p.data<CodeNote[]>('CodeNote[]', '[{line,text,kind?}] callouts anchored to lines.')),
  ...FRAME,
});

export const DiffView = component('DiffView', {
  family: 'code', chunk: 'code', tier: 'A',
  doc: 'Git diff read by the server: file list, hunks, word-level marks. Live for the working tree.',
  example: "DiffView('main..HEAD',title='This branch')",
}, {
  range: opt(p.text("'wt' (working tree vs HEAD, default), 'staged', or a git range 'main..HEAD'.")),
  file: opt(p.text('Limit to one path.')),
  mode: minor(opt(p.enum(['auto', 'unified', 'split'], 'Layout. Default auto.', {inline: 'unified', 'side-by-side': 'split', sidebyside: 'split', side: 'split'}))),
  ...FRAME,
});

export const CodeTour = component('CodeTour', {
  family: 'code', chunk: 'code', tier: 'B',
  doc: 'Walkthrough: numbered notes on the left, the referenced code on the right.',
  example: "CodeTour([{file:'src/auth/service.ts#L20-58',note:'Entry point.'},{file:'src/auth/cache.ts#L5-30',note:'Token cache.'}])",
}, {
  data: p.data<TourStop[]>('TourStop[]', "[{file:'path#L1-20',title?,note}] in reading order."),
  ...FRAME,
});

export const SymbolOutline = component('SymbolOutline', {
  family: 'code', chunk: 'code', tier: 'B',
  doc: 'Symbols of a file with kind badges and line numbers. Follows the selection when file is omitted.',
  example: 'SymbolOutline()',
}, {
  file: opt(p.text('Path. Omit to follow the selected file.')),
  ...FRAME,
});

// ---- input (2) ----------------------------------------------------------------------------------------------------
export const Button = component('Button', {
  family: 'input', chunk: 'content', tier: 'B',
  doc: 'Queues an event for the agent (delivered with its next Glimpse result or prompt).',
  example: "Button('Approve plan',Event('approve',{plan:1}),'primary')",
}, {
  label: p.text('Button text.'),
  action: p.action("Event('name',{context})."),
  tone: opt(p.enum(['default', 'primary', 'quiet'], 'Style.', {secondary: 'default', normal: 'default', ghost: 'quiet', subtle: 'quiet', link: 'quiet'})),
  ...CELL,
});

export const Ask = component('Ask', {
  family: 'input', chunk: 'content', tier: 'B',
  doc: 'Decision card: the user picks one option; the pick is queued for the agent.',
  example: "Ask('Which store backs the limiter?',['Redis','In-memory'],'store')",
}, {
  prompt: p.text('Question (inline micro-markup).'),
  options: p.strings('Choices.'),
  name: opt(p.str("Event name. Default 'answer'.")),
  ...CELL,
});

export const COMPONENTS = [
  Page, Plate, Section, Grid, Row, Column, Tabs, Split,
  Text, Markdown, Callout, KeyValue, Chips, FileRef, Steps, Stat, Stats, List,
  DataTable, FileTree, CommitList, JsonView,
  Sparkline, SegmentedBar, BarChart, LineChart, ScatterPlot, Histogram, Heatmap, CalendarHeatmap, Treemap, Icicle,
  Graph, Flowchart, SequenceDiagram, Layers, ERDiagram,
  CodeBlock, CodeView, DiffView, CodeTour, SymbolOutline,
  Button, Ask,
] as const;

export type AnyComponentDef = (typeof COMPONENTS)[number];
export type ComponentName = AnyComponentDef['name'];
export const COMPONENT_BY_NAME: ReadonlyMap<string, AnyComponentDef> = new Map(COMPONENTS.map(c => [c.name, c]));

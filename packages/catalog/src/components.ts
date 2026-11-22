// packages/catalog/src/components.ts
// THE catalog. One entry per component; key order of `props` is the Express positional order.
// Rules (enforced by test/lint.test.ts): no prop named id|component|metadata|catalogId|accessibility|checks;
// schemas are strict; no unions in static props; required props come first.
// Accepting a reasonable guess beats documenting the one right spelling: enum props list the other words authors
// write as `aliases` (the spec pipeline rewrites them and says so), and data shapes say which key spellings a
// component reads (datasets.ts). The shapes (SHAPES) and one example call per component (COMPONENT_EXAMPLES) are in
// docs.ts: the tab bundles this file eagerly and never reads them (decision what-if-as-a2ui-calls).
import {component, minor, opt, p} from './props.ts';
import type {
  ChipItem, CodeNote, CommitRow, DirNode, ErData, GraphData, KeyValueData, LayerItem, ListItem, Rows, StatItem,
  StepItem, TourStop,
} from './datasets.ts';
import type {FlowData, SeqData} from './diagrams.ts';
import type {ColumnsValue} from './notation.ts';
import type {AskOptionsValue} from './options.ts';

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
  size: opt(p.enum(['s', 'm', 'l', 'xl', 'fill'], 'Max height 160/280/420/640px or the viewport; shorter content gives a shorter plate.', SIZE_ALIASES)),
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
}, {
  title: p.text('View title.'),
  children: p.children('Plates and other content, top to bottom.'),
  subtitle: opt(p.text('One line next to the title.')),
  width: minor(opt(p.enum(['page', 'wide', 'full'], 'Max width 1320px, 1680px or 100%.', {normal: 'page', default: 'page', fill: 'full'}))),
});

export const Plate = component('Plate', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Numbered hairline frame around several children.',
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
}, {
  title: p.text('Section heading.'),
  children: p.children('Section content.'),
  subtitle: opt(p.text('One line under the heading.')),
  ...CELL,
});

export const Grid = component('Grid', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: "Columns: equal, a ratio like '2:1', or the children's span= on 12 columns. Wraps on narrow screens.",
}, {
  children: p.children('Cells, left to right.'),
  cols: opt(p.str("Column count '3' or ratio '2:1'. Default: one column per child (max 4).")),
  gap: GAP,
  ...CELL,
});

export const Row = component('Row', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Horizontal flex row; children share the width.',
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
}, {
  children: p.children('Items.'),
  gap: GAP,
  align: opt(p.enum(['start', 'center', 'end', 'stretch'], 'Cross-axis alignment.', ALIGN_ALIASES)),
  ...CELL,
});

export const Tabs = component('Tabs', {
  family: 'layout', chunk: 'layout', tier: 'A',
  doc: 'Tab strip; one child per label, mounted on first activation.',
}, {
  labels: p.strings('Tab labels, one per child.'),
  children: p.children('One child per tab.'),
  ...CELL,
});

export const Split = component('Split', {
  family: 'layout', chunk: 'layout', tier: 'C',
  doc: 'Two resizable panes.',
}, {
  start: p.child('Left/top pane.'),
  end: p.child('Right/bottom pane.'),
  ratio: opt(p.str("Initial ratio like '1:2'. Default '1:1'.")),
  dir: minor(opt(p.enum(['row', 'col'], 'Side by side or stacked.', {horizontal: 'row', h: 'row', column: 'col', vertical: 'col', v: 'col'}))),
  size: minor(opt(p.enum(['s', 'm', 'l', 'xl', 'fill'], 'Height the two panes share (fixed, not a maximum).', SIZE_ALIASES))),
  ...CELL,
});

// ---- content (9) ----------------------------------------------------------------------------------------------
export const Text = component('Text', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Text with inline `code`, *em*, **strong** and [[path#L10]] file refs; line breaks are kept.',
}, {
  text: p.text('Text with inline micro-markup. No HTML.'),
  tone: opt(p.enum(['body', 'lead', 'dim', 'caption', 'mono'], 'Style.', {
    normal: 'body', default: 'body', muted: 'dim', secondary: 'dim', subtle: 'dim', small: 'caption', code: 'mono', heading: 'lead', title: 'lead',
  })),
  ...FRAME,
});

export const Callout = component('Callout', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Marginal note with a coloured rule and tag.',
}, {
  text: p.text('Body (inline micro-markup).'),
  kind: opt(p.enum(['note', 'tip', 'warn', 'risk', 'decision', 'question'], 'Tag and colour. Default note.', {
    info: 'note', information: 'note', warning: 'warn', caution: 'warn', danger: 'risk', error: 'risk', critical: 'risk',
    success: 'tip', hint: 'tip', idea: 'tip',
  }, ['info', 'success'])),
  title: opt(p.text('Bold lead-in.')),
  file: opt(p.text("File anchor 'path#L10-20'.")),
  ...CELL,
});

export const KeyValue = component('KeyValue', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Definition grid; paths, numbers, lists and booleans format themselves.',
}, {
  data: p.data<KeyValueData>('KeyValueData', 'Object {Label:value}, or [{label,value}] ([{key,value}] and [{k,v}] work too).'),
  cols: opt(p.int('Columns 1-3. Default 1.', 1, 3)),
  ...FRAME,
});

export const Chips = component('Chips', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Row of mono chips with a colour dot.',
}, {
  data: opt(p.data<ChipItem[]>('ChipItem[]', 'Strings or [{label,tone?}].', 'repo.stack')),
  ...FRAME,
});

export const FileRef = component('FileRef', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Clickable path:line; click selects, Cmd-click opens the editor.',
}, {
  file: p.text("'path' or 'path#L10-20'."),
  label: opt(p.text('Text shown instead of the path.')),
  ...CELL,
});

export const Steps = component('Steps', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Numbered plan or walkthrough with status marks and a progress rule.',
}, {
  data: p.data<StepItem[]>('StepItem[]', 'StepItem below.'),
  current: minor(opt(p.number('Number of the active step, counting from 1 as drawn. Usually omitted: give that step status doing.'))),
  ...FRAME,
});

export const Stat = component('Stat', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'Hero numeral with label, delta and sparkline.',
}, {
  value: p.data<number | string>('number|string', 'Number, short string or a call, e.g. div($/w/seats,60).'),
  label: opt(p.text('Caption.')),
  delta: opt(p.number('Signed change.')),
  unit: minor(opt(p.text('Unit after the value.'))),
  spark: minor(opt(p.data<number[]>('number[]', 'Numbers for a sparkline.'))),
  format: minor(opt(p.enum(['num', 'compact', 'bytes', 'pct', 'duration'], 'Number format. Default: in full below 10,000, else compact.', {
    number: 'num', int: 'num', integer: 'num', full: 'num', short: 'compact', size: 'bytes', percent: 'pct', percentage: 'pct', time: 'duration', ms: 'duration',
  }))),
  ...CELL,
});

export const Stats = component('Stats', {
  family: 'content', chunk: 'content', tier: 'A',
  doc: 'KPI strip: hairline-separated Stat cells.',
}, {
  data: opt(p.data<StatItem[]>('StatItem[]', '[{label,value,unit?,delta?,spark?,format?,tone?}] ([{key,value}] works too), or an object {Label:value}.', 'repo.kpis')),
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
}, {
  data: p.data<ListItem[]>('ListItem[]', '[{title,sub?,value?,file?}] or any rows dataset.'),
  limit: opt(p.int('Rows shown. Default 10.', 1, 200)),
  ...FRAME,
});

// ---- data (4) ----------------------------------------------------------------------------------------------------
export const DataTable = component('DataTable', {
  family: 'data', chunk: 'table', tier: 'A',
  doc: 'Virtualized sortable table; columns come from the dataset unless given.',
}, {
  data: p.data<Rows>('Rows', "Source ref, $/path or inline rows (node:'ID' links a row). A graph source (deps.modules, diff.impact) gives its nodes as rows; Graph draws the graph."),
  // Two forms (the list, and the presets' shorthand string), so a DynamicValue (p.value), read by readColumns (notation.ts).
  columns: opt(p.value<ColumnsValue>("[{key, kind?, label?} | 'key']. Kinds: text num bytes pct duration path symbol module author commit lang date bar heat spark chip delta code bool.")),
  sort: opt(p.str("'field' or '-field'.")),
  search: minor(opt(p.flag('Show the search box. Default: when more than 20 rows.'))),
  group: minor(opt(p.str('Group rows by this field.'))),
  ...FRAME,
});

export const FileTree = component('FileTree', {
  family: 'data', chunk: 'table', tier: 'A',
  doc: 'Directory tree with size bars, heat strip and extension badges.',
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
}, {
  data: opt(p.data<CommitRow[]>('CommitRow[]', 'Commit rows.', 'git.log')),
  ...FRAME,
});

export const JsonView = component('JsonView', {
  family: 'data', chunk: 'table', tier: 'C',
  doc: 'Collapsible JSON/config tree.',
}, {
  data: p.data<unknown>('unknown', 'Any JSON value.'),
  depth: minor(opt(p.int('Levels expanded initially. Default 1.', 0, 12))),
  ...FRAME,
});

// ---- charts (10) ------------------------------------------------------------------------------------------------
export const Sparkline = component('Sparkline', {
  family: 'chart', chunk: 'content', tier: 'A',
  doc: 'Inline trend line with an end dot.',
}, {
  data: p.data<number[]>('number[]', 'Numbers.'),
  kind: minor(opt(p.enum(['line', 'bar', 'area'], 'Default line.', {bars: 'bar', column: 'bar'}))),
  ...CELL,
});

export const SegmentedBar = component('SegmentedBar', {
  family: 'chart', chunk: 'content', tier: 'A',
  doc: 'Part-to-whole in one bar with a legend (use instead of a pie).',
}, {
  data: opt(p.data<Rows>('Rows', 'Rows.', 'files.langs')),
  label: opt(p.str('Segment field.')),
  value: opt(p.str('Value field.')),
  ...FRAME,
});

export const BarChart = component('BarChart', {
  family: 'chart', chunk: 'charts', tier: 'A',
  doc: 'Bars by category; horizontal when there are many or long labels.',
}, {
  data: p.data<Rows>('Rows', 'Rows.'),
  x: opt(p.str('Category field.')),
  y: opt(p.str('Value field(s), space separated.')),
  series: opt(p.str('Field that splits bars into series.')),
  mode: opt(p.enum(['grouped', 'stacked', 'pct'], 'Default grouped.', {group: 'grouped', stack: 'stacked', percent: 'pct', normalized: 'pct'})),
  dir: minor(opt(p.enum(['h', 'v'], 'Orientation. Default automatic.', {horizontal: 'h', row: 'h', vertical: 'v', column: 'v', col: 'v'}))),
  limit: minor(opt(p.int('Bars kept (default 20); the rest fold into other when the measure adds up.', 1, 200))),
  ...FRAME,
});

export const LineChart = component('LineChart', {
  family: 'chart', chunk: 'charts', tier: 'A',
  doc: 'Lines or stacked areas over time or an ordered x, labelled at the line ends.',
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
}, {
  data: opt(p.data<Rows>('Rows', 'Rows.', 'git.activity')),
  date: opt(p.str('Date field.')),
  value: opt(p.str('Value field.')),
  ...FRAME,
});

export const Treemap = component('Treemap', {
  family: 'chart', chunk: 'charts', tier: 'A',
  doc: 'Zoomable nested rectangles sized by a metric.',
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
}, {
  data: opt(p.data<GraphData>('GraphData', '{nodes:[{id,label}],edges:[{from,to}],groups?}.', 'deps.modules')),
  dir: opt(p.enum(['LR', 'TB'], 'Flow direction. Default: whichever reads larger at the plate width, LR on a tie.', DIR_ALIASES)),
  focus: opt(p.text('Node id to centre; its neighbourhood is emphasised.')),
  depth: minor(opt(p.int('Hops shown around the focus. Default 1.', 1, 4))),
  ...FRAME,
});

export const Flowchart = component('Flowchart', {
  family: 'diagram', chunk: 'diagrams', tier: 'B',
  doc: 'Boxes and arrows written as data: flows, state machines, grouped parts.',
}, {
  data: p.data<FlowData>('FlowData', 'FlowData below.'),
  dir: opt(p.enum(['TB', 'LR'], 'Default: whichever reads larger.', DIR_ALIASES)),
  ...FRAME,
});

export const SequenceDiagram = component('SequenceDiagram', {
  family: 'diagram', chunk: 'diagrams', tier: 'B',
  doc: 'Lifelines and numbered messages written as data, with notes and loop/alt frames.',
}, {
  data: p.data<SeqData>('SeqData', 'SeqData below. Actor node: its id unless given; via: nodes passed.'),
  ...FRAME,
});

export const Layers = component('Layers', {
  family: 'diagram', chunk: 'diagrams', tier: 'B',
  doc: 'Architecture tiers: horizontal bands of boxes, top tier first.',
}, {
  data: p.data<LayerItem[]>('LayerItem[]', 'LayerItem below, top tier first.'),
  ...FRAME,
});

export const ERDiagram = component('ERDiagram', {
  family: 'diagram', chunk: 'diagrams', tier: 'C',
  doc: 'Tables with column rows and key marks, joined by relation edges.',
}, {
  data: p.data<ErData>('ErData', "ErData below. fk:'users.id' draws the relation."),
  dir: minor(opt(p.enum(['LR', 'TB'], 'Default: whichever reads larger.', DIR_ALIASES))),
  ...FRAME,
});

// ---- code (5) ----------------------------------------------------------------------------------------------------
export const CodeBlock = component('CodeBlock', {
  family: 'code', chunk: 'code', tier: 'A',
  doc: 'Highlighted snippet you write yourself (short; for files on disk use CodeView).',
}, {
  code: p.text('Source text.'),
  lang: opt(p.str('Language id (ts, py, go, rust, sql, json, sh ...).')),
  mark: opt(p.str("Lines to highlight: '3,7-9' (or 'L3,L7-9').")),
  title: minor(opt(p.text('Header label.'))),
  ...CELL,
});

export const CodeView = component('CodeView', {
  family: 'code', chunk: 'code', tier: 'A',
  doc: 'A file read from disk: gutter, highlights, notes. Follows the selection when file is omitted.',
}, {
  file: opt(p.text("'path' or 'path#L10-40'. Omit to follow the selected file.")),
  mark: opt(p.str("Lines of the file to highlight: '12-18,30' (or 'L12-18').")),
  notes: opt(p.data<CodeNote[]>('CodeNote[]', '[{line,text,kind?}] callouts anchored to lines.')),
  ...FRAME,
});

export const DiffView = component('DiffView', {
  family: 'code', chunk: 'code', tier: 'A',
  doc: 'Git diff read by the server: file list, hunks, word-level marks. Live for the working tree.',
}, {
  range: opt(p.text("'wt' (working tree vs HEAD, default), 'staged', or a git range 'main..HEAD'.")),
  file: opt(p.text('Limit to one path.')),
  mode: minor(opt(p.enum(['auto', 'unified', 'split'], 'Layout. Default auto.', {inline: 'unified', 'side-by-side': 'split', sidebyside: 'split', side: 'split'}))),
  ...FRAME,
});

export const CodeTour = component('CodeTour', {
  family: 'code', chunk: 'code', tier: 'B',
  doc: 'Walkthrough: numbered notes on the left, the referenced code on the right.',
}, {
  data: p.data<TourStop[]>('TourStop[]', "[{file:'path#L1-20',title?,note}] in reading order."),
  ...FRAME,
});

export const SymbolOutline = component('SymbolOutline', {
  family: 'code', chunk: 'code', tier: 'B',
  doc: 'Symbols of a file with kind badges and line numbers. Follows the selection when file is omitted.',
}, {
  file: opt(p.text('Path. Omit to follow the selected file.')),
  ...FRAME,
});

// ---- input (3) ----------------------------------------------------------------------------------------------------
export const Button = component('Button', {
  family: 'input', chunk: 'content', tier: 'B',
  doc: 'Queues an event for the agent (delivered with its next Glimpse result or prompt).',
}, {
  label: p.text('Button text.'),
  action: p.action("Event('name',{context}), or a plain 'name' (read as Event('name'))."),
  tone: opt(p.enum(['default', 'primary', 'quiet'], 'Style.', {secondary: 'default', normal: 'default', ghost: 'quiet', subtle: 'quiet', link: 'quiet'})),
  ...CELL,
});

export const Ask = component('Ask', {
  family: 'input', chunk: 'content', tier: 'B',
  doc: 'Decision card: the user picks one option; the pick is queued for the agent.',
}, {
  prompt: p.text('Question (inline micro-markup).'),
  // A value prop, read by readOptions (catalog options.ts), since a static prop may not be a union (decision ask-options-carry-notes).
  options: p.value<AskOptionsValue>("Choices: ['A','B'], or [{label, note?}] where note says what picking it means or costs."),
  name: opt(p.str("Event name. Default 'answer'.")),
  ...CELL,
});

/**
 * Decision what-if-as-a2ui-calls: writes the number at the $/path its value binds, and every call reading that path recomputes in the
 * tab. In the charts chunk: an input, kept lazy for the eager budget. min, max and step are static, so the server and
 * the tab hold a number to the same limits.
 */
export const Slider = component('Slider', {
  family: 'input', chunk: 'charts', tier: 'B',
  doc: 'A number the user sets: a field, and a range when min and max are given. Calls reading it update.',
}, {
  label: p.text('Caption.'),
  value: p.number('The $/path it writes; seed it: $/w={seats:50000}. Compute from it in any value, inline rows too: add|sub|mul|div(a, b) of numbers, $/paths or calls.'),
  min: minor(opt(p.num('Lowest value. With max, a range is drawn too.'))),
  max: minor(opt(p.num('Highest value.'))),
  step: minor(opt(p.num('Step. Default: a hundredth of max-min, else any.'))),
  unit: minor(opt(p.text('Unit after the field.'))),
  ...CELL,
});

export const COMPONENTS = [
  Page, Plate, Section, Grid, Row, Column, Tabs, Split,
  Text, Callout, KeyValue, Chips, FileRef, Steps, Stat, Stats, List,
  DataTable, FileTree, CommitList, JsonView,
  Sparkline, SegmentedBar, BarChart, LineChart, ScatterPlot, Histogram, Heatmap, CalendarHeatmap, Treemap, Icicle,
  Graph, Flowchart, SequenceDiagram, Layers, ERDiagram,
  CodeBlock, CodeView, DiffView, CodeTour, SymbolOutline,
  Button, Ask, Slider,
] as const;

export type AnyComponentDef = (typeof COMPONENTS)[number];
export type ComponentName = AnyComponentDef['name'];
export const COMPONENT_BY_NAME: ReadonlyMap<string, AnyComponentDef> = new Map(COMPONENTS.map(c => [c.name, c]));

import {describe, expect, it} from 'vitest';
import {COMPONENT_BY_NAME, SOURCE_BY_NAME, VIEW_BY_NAME, acceptsArg, VIEW_INDEX, VIEWS, formatRef, parseViewRef, partsOf, type A2uiMessage, type SourceRef} from '../src/index.ts';
import {compileExpress, expandRefs} from '../testing/index.ts';
import {PRESET_CALLS, corpus, presetSource} from './support.ts';

function compiled(call: string) {
  const {view, source} = presetSource(call);
  const messages = compileExpress(view, source);
  const refs = expandRefs(messages);
  const first = messages[0] as Extract<A2uiMessage, {createSurface: unknown}>;
  return {view, source, surface: first.createSurface, refs: [...refs.values()].map(formatRef).sort()};
}
const refTexts = (refs: Iterable<SourceRef>) => [...refs].map(formatRef).sort();

describe('preset views', () => {
  it('lists the ten presets of the view index, in order', () => {
    expect(VIEWS.map(v => v.name)).toEqual(['overview', 'tree', 'deps', 'hotspots', 'history', 'file', 'symbol', 'stack', 'diff', 'feature']);
    // the index shown to the model names every preset plus the gallery
    expect(VIEW_INDEX.split(' | ').map(entry => entry.split(' ')[0])).toEqual([...VIEWS.map(v => v.name), 'gallery']);
    for (const view of VIEWS) {
      expect(VIEW_BY_NAME.get(view.name)).toBe(view);
      const entry = VIEW_INDEX.split(' | ').find(e => e.split(' ')[0] === view.name)!;
      const expected = view.target ? (view.targetRequired ? `<${view.target === 'symbol' ? 'name' : view.target}>` : `[${view.target}]`) : undefined;
      expect(entry.split(' ')[1], `target of ${view.name} in the index`).toBe(expected);
    }
  });

  it.each(PRESET_CALLS.map(call => [call] as const))('%s compiles to one createSurface whose parts are all reachable and patchable', call => {
    const {source, surface, view} = compiled(call);
    expect(surface.surfaceId).toBe(view);
    const ids = new Set(surface.components.map(c => c.id));
    expect(ids.has('root')).toBe(true);
    expect(surface.components[0]).toMatchObject({id: 'root', component: 'Page'});
    for (const part of partsOf(source)) expect(ids.has(part), `named part ${part}`).toBe(true);
    for (const component of surface.components) expect(COMPONENT_BY_NAME.has(component.component)).toBe(true);
  });

  it.each(VIEWS.filter(v => v.slots).map(v => [v.name, v] as const))('%s initialises every slot it documents', (_name, view) => {
    const source = view.build(view.targetRequired ? 'src/a.ts' : undefined, {});
    const surface = (compileExpress(view.name, source)[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface;
    for (const path of Object.keys(view.slots ?? {})) {
      expect(path).toMatch(/^\/[a-z]+$/);
      expect(surface.dataModel, `slot ${path}`).toHaveProperty(path.slice(1));
    }
  });

  it('every source a preset names is registered, and required targets are present', () => {
    for (const call of PRESET_CALLS) {
      const {view, source} = presetSource(call);
      const messages = compileExpress(view, source);
      for (const ref of expandRefs(messages).values()) {
        const meta = SOURCE_BY_NAME.get(ref.source);
        expect(meta, `${call}: ${ref.source}`).toBeDefined();
        if (meta?.targetRequired) expect(ref.target, `${call}: ${ref.source} needs a target`).toBeTruthy();
        // The rule the spec pipeline applies to argument names (sources.ts): declared in SourceMeta.args, or `top` on rows.
        for (const arg of Object.keys(ref.args)) expect(meta && acceptsArg(meta, arg), `${call}: ${ref.source} ${arg}=`).toBe(true);
      }
    }
  });

  it('overview binds the ten datasets the design lists', () => {
    expect(compiled('overview').refs).toEqual([
      'deps.cycles', 'deps.external top=12', 'deps.modules', 'files.langs', 'files.tree', 'git.hotspots top=15', 'git.timeline',
      'repo.kpis', 'repo.packages', 'repo.stack',
    ]);
  });

  it('a target scopes the sources of tree, deps, hotspots and history', () => {
    expect(compiled('tree src/auth').refs).toEqual(['files.tree src/auth']);
    // Every plate of a scoped deps page shows the scope, not the whole repository beside a scoped graph.
    expect(compiled('deps packages/server').refs).toEqual([
      'deps.cycles packages/server', 'deps.external packages/server top=20', 'deps.matrix packages/server', 'deps.modules packages/server',
    ]);
    expect(compiled('deps').refs).toEqual(['deps.cycles', 'deps.external top=20', 'deps.matrix', 'deps.modules']);
    expect(compiled('hotspots src since=90d').refs).toEqual(['files.tree src', 'git.coupling src', 'git.hotspots src since=90d', 'git.hotspots src since=90d top=50']);
    expect(compiled('history').refs).toEqual(['git.activity', 'git.authors top=10', 'git.churn top=50', 'git.log', 'git.timeline']);
  });

  it('a target with spaces and an apostrophe survives the template', () => {
    const {surface, refs} = compiled("history it's/odd path");
    expect(surface.components[0]).toMatchObject({subtitle: "it's/odd path"});
    expect(refs).toContain("git.log it's/odd path");
  });

  it('file and symbol put their target in the view and the sources', () => {
    const file = compiled('file src/core/index.ts');
    expect(file.surface.components.find(c => c.id === 'code')).toMatchObject({component: 'CodeView', file: 'src/core/index.ts', notes: {'@path': '/marks'}});
    expect(file.refs).toEqual(['deps.files src/core/index.ts', 'git.log src/core/index.ts top=10']);
    expect(compiled('symbol MessageProcessor').refs).toEqual(['code.refs MessageProcessor']);
  });

  it('diff defaults to the working tree and swaps the last part for a commit list on a real range', () => {
    const wt = compiled('diff');
    expect(wt.surface.components.find(c => c.id === 'diff')).toMatchObject({component: 'DiffView', range: 'wt'});
    expect(wt.surface.components.find(c => c.id === 'log')).toMatchObject({component: 'List'});
    expect(wt.refs).toEqual(['code.todos top=8', 'diff.impact wt', 'diff.stats wt']);
    expect(compiled('diff staged').surface.components.find(c => c.id === 'log')).toMatchObject({component: 'List'});
    const range = compiled('diff main..HEAD');
    expect(range.surface.components.find(c => c.id === 'log')).toMatchObject({component: 'CommitList'});
    expect(range.refs).toEqual(['diff.impact main..HEAD', 'diff.stats main..HEAD', 'git.log main..HEAD']);
  });

  // F003: the preset drew two lists of the same files side by side (a FileTree and DiffView's own), each too narrow
  // to show a file name.
  it('diff shows one file list: the DiffView spans the page and there is no second tree of the same files', () => {
    for (const call of ['diff', 'diff staged', 'diff main..HEAD']) {
      const {surface} = compiled(call);
      expect(surface.components.filter(c => c.component === 'FileTree'), call).toEqual([]);
      expect(surface.components.filter(c => c.component === 'DiffView'), call).toHaveLength(1);
      expect((surface.components[0] as {children?: unknown}).children, call).toEqual(['kpis', 'notes', 'diff', 'impact', 'log']);
      expect(surface.components.find(c => c.id === 'diff'), call).not.toHaveProperty('span');
    }
  });

  // F001: the file preset's graph opened unfocused. F038 (probe p_view_file): a target with a line anchor became the
  // page title and the ref of every source.
  it('file focuses its graph on the file, and a line anchor in the target only scrolls the code', () => {
    const plain = compiled('file src/core/index.ts');
    expect(plain.surface.components.find(c => c.id === 'near')).toMatchObject({component: 'Graph', focus: 'src/core/index.ts'});
    const anchored = compiled('file src/core/index.ts#L10-60');
    expect(anchored.surface.components[0]).toMatchObject({title: 'src/core/index.ts'});
    expect(anchored.surface.components.find(c => c.id === 'code')).toMatchObject({file: 'src/core/index.ts#L10-60'});
    expect(anchored.surface.components.find(c => c.id === 'outline')).toMatchObject({file: 'src/core/index.ts'});
    expect(anchored.surface.components.find(c => c.id === 'near')).toMatchObject({focus: 'src/core/index.ts'});
    expect(anchored.refs).toEqual(plain.refs);
  });

  // Finding V050: a .diff file got a full-width one-node 'Imports and importers' graph.
  it('file leaves out the imports graph for a file no import analysis reads', () => {
    for (const path of ['eval/run_039/patch.diff', 'README.md', 'config/app.yaml', 'LICENSE', 'package-lock.json']) {
      const {surface} = compiled(`file ${path}`);
      expect(surface.components.find(c => c.id === 'near'), path).toBeUndefined();
      expect(JSON.stringify(surface.components[0]), path).not.toContain('near');
    }
    for (const path of ['src/core/index.ts', 'tools/stats.py', 'cmd/main.go']) expect(compiled(`file ${path}`).surface.components.find(c => c.id === 'near'), path).toBeDefined();
  });

  // D20: size is a maximum, so the overview's module graph may take the tallest step. At 'l' (420 px) a 24-node module
  // graph of a large polyglot repository could only open in part (13 of 24 nodes in view); at 'xl' it opens whole with
  // its text at 10 px or more, and a small graph still keeps the height of its drawing.
  it('overview lets the module graph grow to the xl step', () => {
    expect(compiled('overview').surface.components.find(c => c.id === 'deps')).toMatchObject({component: 'Graph', size: 'xl', span: 8});
  });

  // Review finding (swap round): presets, the gallery and the recipes gave diagrams size='l'. Under D20 that is a
  // maximum of 420 px, below the 640 px a diagram grows to with no size: the file preset's graph opened with 18 of 44
  // nodes cut, the gallery's ERD sliced through a table. What Glimpse writes itself teaches the model; none of it may
  // cut a diagram short.
  it('no preset, gallery, component example or recipe caps a diagram below its default height', () => {
    const capped: string[] = [];
    for (const {label, messages} of corpus()) {
      for (const message of messages) {
        const components = 'createSurface' in message ? message.createSurface.components : 'updateComponents' in message ? message.updateComponents.components : [];
        for (const component of components as unknown as Array<{id: string; component: string; size?: unknown}>) {
          if (COMPONENT_BY_NAME.get(component.component)?.family !== 'diagram') continue;
          if (component.size === 's' || component.size === 'm' || component.size === 'l') capped.push(`${label}: ${component.component}#${component.id} size=${component.size}`);
        }
      }
    }
    expect(capped).toEqual([]);
    // the presets that draw a graph beside other plates still give it its width
    expect(compiled('file src/core/index.ts').surface.components.find(c => c.id === 'near')).not.toHaveProperty('size');
    expect(compiled('diff main..HEAD').surface.components.find(c => c.id === 'impact')).toMatchObject({component: 'Graph', span: 7});
    expect(compiled('diff main..HEAD').surface.components.find(c => c.id === 'impact')).not.toHaveProperty('size');
    expect(compiled('feature').surface.components.find(c => c.id === 'impact')).not.toHaveProperty('size');
  });

  // F016: the Cycles / External tabs were the only unframed block of the overview.
  it('overview keeps its ten part names and frames the cycles and external tabs', () => {
    const {source, surface} = compiled('overview');
    expect(partsOf(source)).toEqual(['kpis', 'stack', 'notes', 'map', 'langs', 'deps', 'side', 'activity', 'hot', 'pkgs']);
    // `side` is still the Tabs (a patch of it keeps the frame); the plate around it is an inline child of root
    expect(surface.components.find(c => c.id === 'side')).toMatchObject({component: 'Tabs', labels: ['File cycles', 'External']});
    const plate = surface.components.find(c => c.component === 'Plate' && (c as unknown as {children: string[]}).children.includes('side'));
    expect(plate).toMatchObject({title: 'File cycles and external packages', span: 4});
    expect((surface.components[0] as unknown as {children: string[]}).children).toContain(plate!.id);
  });

  // D16 (V011, V036): the overview put 'CYCLES 0' (files) above a module graph with red cycle marks, and a count of
  // manifests under 'Modules'. The plates now say which cycles they list and what a Packages row is.
  it('cycle plates say they list file cycles, and package tables say a row is a manifest', () => {
    const overview = compiled('overview').surface.components;
    expect(overview.find(c => c.id === 'side')).toMatchObject({labels: ['File cycles', 'External']});
    expect(overview.find(c => c.id === 'pkgs')).toMatchObject({title: 'Packages', note: 'One row per manifest file.'});
    expect(VIEW_BY_NAME.get('overview')!.doc).toContain('file cycles');
    const deps = compiled('deps').surface.components;
    expect(deps.find(c => c.id === 'cycles')).toMatchObject({title: 'File cycles', note: expect.stringMatching(/between files; the graph marks cycles between modules/)});
    expect(deps.find(c => c.id === 'graph')).toMatchObject({component: 'Graph', title: 'Module dependencies'});
    expect(VIEW_BY_NAME.get('deps')!.doc).toContain('file cycles');
    expect(compiled('stack').surface.components.find(c => c.id === 'pkgs')).toMatchObject({note: 'One row per manifest file.'});
    // no preset calls a count of manifests "modules"
    for (const call of PRESET_CALLS) expect(presetSource(call).source, call).not.toMatch(/title='Modules'/);
  });

  // F069: "complexity" read as cyclomatic complexity, and test files topped the list unmarked.
  it('the hotspot plates say what they measure and mark tests', () => {
    const hot = compiled('overview').surface.components.find(c => c.id === 'hot') as unknown as {columns: string; note: string};
    // the complexity column takes its header, Indentation, from the source's field label
    expect(hot.columns).toBe('path commits:bar complexity:bar isTest:bool=Test owner');
    expect(SOURCE_BY_NAME.get('git.hotspots')!.fields!.find(f => f.key === 'complexity')!.label).toBe('Indentation');
    expect(hot.note).toMatch(/indentation depth/);
    const {surface} = compiled('hotspots');
    expect(surface.components.find(c => c.id === 'scatter')).toMatchObject({note: expect.stringMatching(/indentation depth/)});
    expect(surface.components.find(c => c.id === 'coupling')).toMatchObject({note: expect.stringMatching(/over 30 files are ignored/)});
  });

  // F008: the placeholder told the person "Replace this part: design=Flowchart(...)".
  it('feature shows the person a neutral design plate and tells the agent, in the catalog, what to put there', () => {
    const {surface} = compiled('feature');
    const design = surface.components.find(c => c.id === 'design') as unknown as {component: string; text: string; title: string};
    expect(design).toMatchObject({component: 'Markdown', title: 'Design'});
    expect(design.text).not.toMatch(/design=|Flowchart|Replace/);
    expect(VIEW_BY_NAME.get('feature')!.replace).toHaveProperty('design');
    expect(VIEW_BY_NAME.get('feature')!.replace!.design).toMatch(/design=Flowchart\(.*design=SequenceDiagram\(/);
  });

  it('parseViewRef uses the source-ref grammar', () => {
    expect(parseViewRef('overview')).toEqual({view: 'overview', target: undefined, args: {}});
    expect(parseViewRef('hotspots src since=90d')).toEqual({view: 'hotspots', target: 'src', args: {since: '90d'}});
    expect(parseViewRef('file  src/my file.ts ')).toEqual({view: 'file', target: 'src/my file.ts', args: {}});
    expect(refTexts([{source: 'git.churn', target: 'src', args: {top: '5', since: '90d'}}])).toEqual(['git.churn src since=90d top=5']);
  });

  // F038: the keyword spelling of a target stays visible to the caller (the show tool accepts it and says so).
  it('parseViewRef leaves a target written as a keyword in args', () => {
    expect(parseViewRef('hotspots path=packages/server')).toEqual({view: 'hotspots', target: undefined, args: {path: 'packages/server'}});
  });
});

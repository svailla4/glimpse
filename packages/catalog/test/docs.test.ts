import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  COMPONENTS, EXAMPLES, INSTRUCTIONS_BUDGET, INSTRUCTIONS_LINE_MAX, INSTRUCTIONS_TARGET, SHAPES, SHARED_PROPS, SKILL_DESCRIPTION, SOURCES, VIEWS, VIEW_INDEX, componentDoc,
  componentIndex, componentsDrawing, exampleCall, examplesDoc, hasFrame, partsOf, serverInstructions, shapeKinds, shapesOf, signatureOf,
  skillMarkdown, sourceDoc, sourceGroups, sourceIndex, typedSignatureList, viewDoc, viewGroups, type Prop,
} from '../src/index.ts';
import {buildArtifacts} from '../testing/artifacts.ts';
import {buildSurface, strictErrors} from '../testing/index.ts';
import {readText} from './support.ts';

/** 'files.{tree list langs} repo.{kpis}' -> ['files.tree', 'files.list', 'files.langs', 'repo.kpis'] */
const expandGroups = (text: string) => [...text.matchAll(/([a-z]+)\.\{([^}]*)\}/g)].flatMap(m => m[2]!.split(' ').map(name => `${m[1]}.${name}`));
const propsOf = (def: (typeof COMPONENTS)[number]) => Object.entries(def.props) as Array<[string, Prop]>;

describe('server instructions', () => {
  const text = serverInstructions();

  it('fit the always-loaded slot with headroom (target 3,750 of a 4,000 budget; the host cuts at 4,096)', () => {
    expect(INSTRUCTIONS_TARGET).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET * 0.94);
    expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_TARGET);
  });

  it('name every source, every preset and every component', () => {
    const sources = /^Sources: (.*)$/m.exec(text)![1]!;
    expect(sources).toBe(sourceGroups());
    expect(expandGroups(sources)).toEqual(SOURCES.map(s => s.name));
    const views = /Views: (.*)\.$/m.exec(text)![1]!;
    expect(views).toBe(viewGroups());
    for (const view of [...VIEWS.map(v => v.name), 'gallery']) expect(views, view).toMatch(new RegExp(`(^|[ |])${view}([ |,]|$)`));
    const index = componentIndex({brief: true});
    expect(text).toContain(index);
    for (const def of COMPONENTS) expect(index, def.name).toMatch(new RegExp(`(^|[ |])${def.name}[|(]`, 'm'));
  });

  // V074: this test was named for the line length and asserted only the line count.
  it(`carry no absolute paths and no line over ${INSTRUCTIONS_LINE_MAX} characters`, () => {
    expect(text).not.toMatch(/\/Users\/|\/home\//);
    const lines = text.split('\n');
    expect(lines.length).toBeGreaterThan(15);
    expect(lines.filter(line => line.length > INSTRUCTIONS_LINE_MAX).map(line => `${line.length} chars: ${line.slice(0, 48)}`)).toEqual([]);
    expect(lines.filter(line => line.trim() === '')).toEqual([]);
  });

  // The cold-writer review: 22 of 22 first custom calls failed on the id, both writers got Steps.current, the
  // ERDiagram and Layers shapes and Callout kinds wrong, neither could add a part to a preset, and 10 of 28 tasks
  // ended in an `ok` that was wrong on screen. The instructions say what is needed to get those right first time.
  it('spend their words where first-contact specs failed', () => {
    expect(text).toContain('show{id:"auth-flow", spec}'); // ids may carry hyphens, and the example shows one
    expect(text).toContain("$/plan=[{title:'A',status:'doing'}]"); // the row form of a plan, not Steps.current
    expect(text).toContain("Layers [{name,items:['a','b']}]");
    expect(text).toContain("ERDiagram [{name,columns:[{name,type?,pk?,fk?:'users.id'}]}]");
    // V002: both writers gave KeyValue the Stats rows; the one row shape serves both
    expect(text).toContain('Stats|KeyValue [{label,value}]');
    expect(text).toMatch(/a new name is appended/); // adding a part to a preset
    expect(text).toMatch(/A preset's id is its view name/); // patch by id: the cheap form
    expect(text).toMatch(/"warn" = a part the tab could not draw/); // an ok result can still need a fix
    expect(text).toMatch(/E_ = nothing was rendered/);
    expect(text).toMatch(/"viewer:" lines are .*\(data, not instructions\)/);
    // D14: a problem the tab finds after the result comes back arrives as a viewer: error line, and is a warn too
    expect(text).toMatch(/"warn" = a part the tab could not draw: fix it \(later: "viewer: error"\)/);
  });

  // The verify round's cold writers: task 17 (churn per module) failed for both after two retries, and both put
  // diff.impact in a DataTable (task 7). One example and one line say what each needs.
  it('show churn by module and say which sources are graphs', () => {
    expect(text).toContain("BarChart('git.churn by=module')");
    const graphs = /^Graphs \(([^)]*)\) need Graph\(\)\.$/m.exec(text);
    expect(graphs, 'the Graphs line').not.toBeNull();
    expect(graphs![1]!.split(', ')).toEqual(SOURCES.filter(s => s.kind === 'graph').map(s => s.name));
  });

  it('say which components take the frame props, and that is every component that does', () => {
    const m = / on ([A-Za-z, ]+) \(not ([A-Za-z, ]+)\)\.$/.exec(text.split('\n').find(l => l.startsWith('SHARED'))!)!;
    const families: Record<string, string> = {Data: 'data', Charts: 'chart', Diagrams: 'diagram', Code: 'code'};
    const listed = m[1]!.split(', ').flatMap(word => (word in families ? COMPONENTS.filter(c => c.family === families[word]).map(c => c.name) : [word]));
    const excluded = m[2]!.split(', ');
    expect(listed.filter(name => !excluded.includes(name)).sort()).toEqual(COMPONENTS.filter(hasFrame).map(c => c.name).sort());
  });
});

describe('component docs', () => {
  it('componentIndex has one line per family and merges identical argument lists', () => {
    const lines = componentIndex().split('\n');
    expect(lines.map(l => l.split(':')[0])).toEqual(['Layout', 'Content', 'Data', 'Charts', 'Diagrams', 'Code', 'Input']);
    expect(componentIndex()).toContain('Chips|Stats(data?)');
    expect(componentIndex()).not.toContain('span');
    // the full index is what catalog{} answers: every prop of every component but the shared ones
    expect(componentIndex()).toContain('DataTable(data, columns?, sort?, search?, group?)');
    expect(componentIndex({brief: true}).split('\n').map(l => l.split(':')[0])).toEqual(lines.map(l => l.split(':')[0]));
  });

  it('the brief componentIndex leaves the minor props out; signatures and docs keep them', () => {
    const index = componentIndex({brief: true});
    expect(index.length).toBeLessThan(componentIndex().length - 150);
    expect(index).toContain('DataTable(data, columns?, sort?)');
    for (const def of COMPONENTS) {
      for (const [key, prop] of propsOf(def)) {
        if (!prop.minor) continue;
        expect(signatureOf(def, {brief: true}), `${def.name}.${key}`).not.toMatch(new RegExp(`[( ]${key}\\??[,)]`));
        expect(signatureOf(def), `${def.name}.${key}`).toMatch(new RegExp(`[( ]${key}[=?]`));
        expect(componentDoc(def.name), `${def.name}.${key}`).toContain(`  ${key}: `);
      }
    }
  });

  it('typedSignatureList has one line per component under seven family headers', () => {
    const lines = typedSignatureList().split('\n');
    expect(lines.filter(l => l.startsWith('# '))).toHaveLength(7);
    expect(lines.filter(l => /^[ABC] /.test(l))).toHaveLength(COMPONENTS.length);
    expect(lines).toContain('A DataTable(data*~:Rows, columns:str, sort:str, search:flag, group:str) +frame');
    expect(lines).toContain("A Chips(data~:ChipItem[]='repo.stack') +frame");
  });

  it.each(COMPONENTS.map(def => [def.name, def] as const))('componentDoc(%s) is a compact, complete entry', (name, def) => {
    const doc = componentDoc(name)!;
    expect(doc.length).toBeGreaterThanOrEqual(100);
    expect(doc.length).toBeLessThanOrEqual(1000);
    expect(doc.startsWith(signatureOf(def))).toBe(true);
    expect(doc).toContain(def.doc);
    expect(doc.endsWith(`  e.g. ${def.example}`)).toBe(true);
    const frame = hasFrame(def);
    for (const key of Object.keys(def.props)) {
      if (key === 'span') continue;
      // the three frame props are one line, not three (they are the same on 30 components)
      if (frame && (SHARED_PROPS as readonly string[]).includes(key)) expect(doc, key).not.toContain(`  ${key}: `);
      else expect(doc, key).toContain(`  ${key}: `);
    }
    expect(doc.includes('  +frame: title= (draws the numbered plate) note= size=s|m|l|xl|fill')).toBe(frame);
  });

  // Review finding (swap round): the docs said only "max height", so a model reasonably read size='l' as larger than
  // the default and capped diagrams at 420 px, below the 640 px they grow to with no size.
  it('say that size is only a maximum, and that a diagram with no size grows to 640px', () => {
    expect(serverInstructions().split('\n').find(l => l.startsWith('SHARED'))).toContain('size=s|m|l|xl|fill (only a max height)');
    for (const def of COMPONENTS.filter(hasFrame)) {
      const doc = componentDoc(def.name)!;
      expect(doc.includes('(max height; unsized diagrams grow to 640px)'), def.name).toBe(def.family === 'diagram');
      expect(doc, def.name).toContain('(max height');
    }
  });

  it('frame components omit the shared props from their signature', () => {
    const table = COMPONENTS.find(c => c.name === 'DataTable')!;
    expect(hasFrame(table)).toBe(true);
    expect(signatureOf(table)).toBe('DataTable(data, columns?, sort?, search?, group?)');
    expect(hasFrame(COMPONENTS.find(c => c.name === 'Plate')!)).toBe(false);
    expect(componentDoc('Nope')).toBeUndefined();
  });

  // V002: KeyValue answered [{label,value}] (the Stats rows) with 'no pairs to show', and Stats an object with E_SHAPE.
  // Both read the same three shapes now; the docs say so, and each documented form compiles.
  it('KeyValue and Stats document the shapes both accept', () => {
    const keyValue = componentDoc('KeyValue')!;
    for (const form of ['{Label:value}', '[{label,value}]', '[{key,value}]', '[{k,v}]']) expect(keyValue, form).toContain(form);
    expect(SHAPES.KeyValueData!.sig).toMatch(/\[\{label, value\}\] \(\{key, value\} and \{k, v\} work too\)/);
    const stats = componentDoc('Stats')!;
    for (const form of ['[{label,value,', '[{key,value}]', 'an object {Label:value}']) expect(stats, form).toContain(form);
    for (const spec of [
      "KeyValue([{label:'A',value:'1'}])", "KeyValue([{key:'A',value:'1'}])", "KeyValue([{k:'A',v:'1'}])", "KeyValue({A:'1'})",
      "Stats([{label:'Files',value:412}])", "Stats([{key:'Files',value:412}])", 'Stats({Files:412,Tests:1866})',
    ]) expect(strictErrors(buildSurface('shapes', `root=Page('S',[${spec}])`)), spec).toEqual([]);
  });

  // V042: a plain string action is read as Event('name') by the spec pipeline; the docs say it is accepted.
  it("Button says a plain 'name' is accepted as its action", () => {
    expect(componentDoc('Button')).toMatch(/action: action \(required\) - Event\('name',\{context\}\), or a plain 'name'/);
  });

  // V009: both writers drew diff.impact in a DataTable; the catalog answer for a table says where a graph goes.
  it('DataTable says a graph source gives its nodes as rows, and Graph draws it', () => {
    expect(componentDoc('DataTable')).toMatch(/A graph source \(deps\.modules, diff\.impact\) gives its nodes as rows; Graph draws the graph\./);
  });

  // F039: title= on Markdown, Text and Stats was an E_PROP, so the model dropped the heading it was asked for.
  it.each(['Text', 'Markdown', 'Chips', 'Stats'])('%s takes the frame props, so title= draws a plate instead of failing', name => {
    expect(hasFrame(COMPONENTS.find(c => c.name === name)!)).toBe(true);
    const arg = name === 'Text' || name === 'Markdown' ? "'Body'," : '';
    const messages = buildSurface('framed', `root=Page('T',[${name}(${arg}title='What changed and why',note='n',size='m')])`);
    expect(strictErrors(messages)).toEqual([]);
    const first = messages[0]!;
    const component = 'createSurface' in first ? first.createSurface.components.find(c => c.component === name) : undefined;
    expect(component).toMatchObject({title: 'What changed and why', note: 'n', size: 'm'});
  });
});

describe('data shapes', () => {
  const SCALARS = ['number', 'string', 'unknown'];

  it('documents the shapes an author writes by hand', () => {
    for (const name of ['ErData', 'LayerItem', 'StepItem', 'StatItem', 'ListItem', 'TourStop', 'CodeNote', 'KeyValueData']) expect(SHAPES, name).toHaveProperty(name);
  });

  it('every shape a data prop names is documented, and every documented shape is used', () => {
    const used = new Set<string>();
    for (const def of COMPONENTS) {
      for (const [key, prop] of propsOf(def)) {
        if (prop.kind !== 'data') continue;
        for (const part of prop.shape!.split('|').map(p => p.replace(/\[\]$/, ''))) {
          if (SCALARS.includes(part)) continue;
          expect(SHAPES, `${def.name}.${key}: ${part}`).toHaveProperty(part);
          used.add(part);
        }
        expect(shapesOf(prop.shape).every(s => s in SHAPES)).toBe(true);
      }
    }
    expect([...used].sort()).toEqual(Object.keys(SHAPES).sort());
    expect(shapesOf('Rows|number[]')).toEqual(['Rows']);
    expect(shapesOf('StepItem[]')).toEqual(['StepItem']);
    expect(shapesOf('number|string')).toEqual([]);
    expect(shapesOf(undefined)).toEqual([]);
  });

  it('componentDoc shows each shape of the component with a one-line example', () => {
    for (const def of COMPONENTS) {
      const doc = componentDoc(def.name)!;
      const shapes = new Set(propsOf(def).flatMap(([, prop]) => shapesOf(prop.shape)));
      for (const shape of shapes) {
        expect(doc, `${def.name}: ${shape}`).toContain(`  ${shape}: ${SHAPES[shape]!.sig}\n    e.g. ${SHAPES[shape]!.example}\n`);
        expect(SHAPES[shape]!.example).not.toContain('\n');
      }
      for (const shape of Object.keys(SHAPES)) if (!shapes.has(shape)) expect(doc, `${def.name}: ${shape}`).not.toContain(`  ${shape}: `);
    }
    expect(componentDoc('Steps')).toContain("StepItem: {title, note?, status?: todo|doing|done|blocked|skipped, file?: 'path#L10'}");
    expect(componentDoc('ERDiagram')).toContain("fk?: true|'table.column'");
    expect(componentDoc('ERDiagram')).toContain("relations: [{from: 'orders.user_id', to: 'users.id'");
  });

  // An example that does not compile would teach the model a form the server rejects.
  it.each(COMPONENTS.flatMap(def => propsOf(def).flatMap(([key, prop]) => shapesOf(prop.shape).map(shape => [def.name, key, shape] as const))))(
    '%s(%s=<the %s example>) compiles and is strictly valid',
    (name, key, shape) => {
      const def = COMPONENTS.find(c => c.name === name)!;
      const required = propsOf(def).filter(([k, prop]) => prop.required && k !== key).map(([k, prop]) => `${k}=${prop.kind === 'children' ? '[]' : "'x'"}`);
      const spec = `$/v=${SHAPES[shape]!.example}\nroot=Page('S',[${name}(${[`${key}=$/v`, ...required].join(',')})])`;
      const messages = buildSurface('shape', spec);
      expect(strictErrors(messages)).toEqual([]);
      const first = messages[0]!;
      expect('createSurface' in first && first.createSurface.dataModel?.v).toBeDefined();
    },
  );
});

describe('source docs', () => {
  it('sourceIndex lists the 26 sources; sourceGroups is the same list grouped by prefix', () => {
    expect(SOURCES).toHaveLength(26);
    expect(sourceIndex().split(' ')).toEqual(SOURCES.map(s => s.name));
    expect(expandGroups(sourceGroups())).toEqual(SOURCES.map(s => s.name));
    expect(sourceGroups().startsWith('files.{tree list langs} repo.{kpis stack packages scripts} ')).toBe(true);
    expect(sourceGroups().length).toBeLessThan(sourceIndex().length - 80);
  });

  it.each(SOURCES.map(s => [s.name, s] as const))('sourceDoc(%s) shows the ref grammar, kind, budget and fields', (name, source) => {
    const doc = sourceDoc(name)!;
    expect(doc.startsWith(`'${name}`)).toBe(true);
    expect(doc).toContain(`-> ${source.kind}`);
    expect(doc).toContain(`max ${source.budget}`);
    for (const field of source.fields ?? []) expect(doc).toContain(field.key);
    for (const arg of Object.keys(source.args ?? {})) expect(doc).toContain(`[${arg}=]`);
    if (source.target) expect(doc).toContain(source.targetRequired ? `<${source.target}>` : `[${source.target}]`);
  });

  // V009: a graph source asked of the catalog names the component that draws it, with a call to copy.
  it('a graph or tree source names the components that draw it', () => {
    expect(componentsDrawing('graph')).toEqual(['Graph']);
    expect(componentsDrawing('tree')).toEqual(['FileTree', 'Treemap', 'Icicle']);
    expect(componentsDrawing('rows')).toEqual(expect.arrayContaining(['DataTable', 'BarChart', 'List', 'Stats', 'KeyValue']));
    expect(componentsDrawing('rows')).not.toContain('Graph');
    for (const source of SOURCES) {
      const doc = sourceDoc(source.name)!;
      if (source.kind === 'graph' || source.kind === 'tree') expect(doc, source.name).toContain(`  a ${source.kind}: draw it with ${componentsDrawing(source.kind).join(' | ')}, e.g. `);
      else expect(doc, source.name).not.toContain('draw it with');
    }
    expect(sourceDoc('diff.impact')).toContain("e.g. Graph('diff.impact'); a DataTable or a rows chart cannot");
    expect(sourceDoc('deps.files')).toContain("e.g. Graph('deps.files <path>')");
  });

  it('shapeKinds is the dataset kinds a data shape draws', () => {
    expect(shapeKinds('GraphData')).toEqual(new Set(['graph']));
    expect(shapeKinds('DirNode')).toEqual(new Set(['tree']));
    expect(shapeKinds('KeyValueData')).toEqual(new Set(['record', 'rows']));
    expect(shapeKinds('StatItem[]')).toEqual(new Set(['rows']));
    expect(shapeKinds('Rows|number[]')).toEqual(new Set(['rows']));
    for (const anything of ['unknown', 'number|string', '', undefined]) expect(shapeKinds(anything), String(anything)).toBeUndefined();
  });

  // V008: churn per module had no route the model could find; by=module is in the source doc with its fields.
  it('git.churn documents by=module and the fields of those rows', () => {
    const doc = sourceDoc('git.churn')!;
    expect(doc).toContain("'git.churn [path] [top=] [since=] [by=]'");
    expect(doc).toMatch(/by=module: one row per module of deps\.modules/);
    expect(doc).toContain('\n  by=module fields: module:module commits:bar authors:num files:num');
  });

  // D16: the KPI strip says what each number counts, in the words of the plates beside it.
  it('repo.kpis and files.langs say what the Languages, Modules and File cycles numbers count', () => {
    const kpis = sourceDoc('repo.kpis')!;
    expect(kpis).toMatch(/Languages \(the rows of files\.langs but 'Unclassified'\)/);
    expect(kpis).toMatch(/Modules \(as deps\.modules groups files, before its 24-node cut\)/);
    expect(kpis).toMatch(/File cycles \(the rows of deps\.cycles/);
    expect(kpis).not.toMatch(/manifest/);
    expect(sourceDoc('files.langs')).toMatch(/one 'Unclassified' row/);
    expect(sourceDoc('deps.cycles')).toMatch(/between files \(file level; the module graph marks cycles between modules\)/);
  });

  it('answers undefined for an unknown source', () => {
    expect(sourceDoc('git.nope')).toBeUndefined();
  });

  // F069: the columns read as cyclomatic complexity and source lines; they are neither.
  it('says what the hotspot and coupling numbers measure', () => {
    expect(sourceDoc('git.hotspots')).toMatch(/complexity = summed indentation depth; sloc = non-blank lines/);
    expect(sourceDoc('git.coupling')).toMatch(/commits over 30 files ignored/);
    const hotspots = SOURCES.find(s => s.name === 'git.hotspots')!;
    expect(hotspots.fields!.find(f => f.key === 'complexity')!.label).toBe('Indentation');
    expect(hotspots.fields!.find(f => f.key === 'sloc')!.label).toBe('Lines');
  });
});

describe('view docs', () => {
  it.each(VIEWS.map(v => [v.name, v] as const))('viewDoc(%s) gives the doc, slots, parts and Express source', (name, view) => {
    const doc = viewDoc(name)!;
    expect(viewDoc(`view:${name}`)).toBe(doc);
    expect(doc.startsWith(`view:${name}`)).toBe(true);
    expect(doc).toContain(view.doc);
    for (const slot of Object.keys(view.slots ?? {})) expect(doc).toContain(`slot $${slot}: `);
    const source = view.build(view.targetRequired ? (view.target === 'symbol' ? '<name>' : `<${view.target}>`) : undefined, {});
    expect(doc.endsWith(source)).toBe(true);
    expect(doc).toContain(`  parts: ${partsOf(source).join(' ')}`);
    for (const part of Object.keys(view.replace ?? {})) {
      expect(partsOf(source), `${name} replaces a part it has`).toContain(part);
      expect(doc).toContain(`  replace ${part} with `);
    }
  });

  it('builds the source for a given target', () => {
    expect(viewDoc('view:diff', 'main..HEAD')).toContain("DiffView('main..HEAD'");
    expect(viewDoc('tree', 'src/auth')).toContain("FileTree('files.tree src/auth'");
  });

  it('documents the gallery and rejects unknown names', () => {
    expect(viewDoc('view:gallery')).toContain('parts: layout content data charts diagrams code input');
    expect(viewDoc('view:nope')).toBeUndefined();
  });

  it('partsOf lists named parts in order without root', () => {
    expect(partsOf(`$/notes=''\nroot=Page('T',[a,b])\na=Text('x')\nb = Text('y')\na=Text('z')`)).toEqual(['a', 'b']);
  });

  it('viewGroups is VIEW_INDEX with shared targets merged', () => {
    expect(viewGroups()).toBe('overview, stack, feature, gallery, tree|deps|hotspots|history [path], file <path>, symbol <name>, diff [range]');
    const names = viewGroups().split(', ').flatMap(group => group.split(' ')[0]!.split('|'));
    expect(names.sort()).toEqual(VIEW_INDEX.split(' | ').map(entry => entry.split(' ')[0]!).sort());
  });
});

describe('examples and the plugin skill', () => {
  it('has the six recipes of the design, each a complete call', () => {
    expect(EXAMPLES.map(e => e.title)).toEqual(['Explain a module', 'Review a branch', 'Plan a feature', 'Trace a request', 'Find hotspots', 'Compare two modules']);
    for (const example of EXAMPLES) {
      expect(example.view ?? example.id, example.title).toBeTruthy();
      expect(exampleCall(example)).toMatch(/^show\{(view|id):/);
      if (!example.view) expect(example.spec).toMatch(/^root=Page\(/);
    }
    expect(examplesDoc().split('\n\n')).toHaveLength(6);
  });

  it('skillMarkdown has the front matter the plugin needs, the instructions and every recipe', () => {
    const skill = skillMarkdown();
    expect(skill.startsWith(`---\nname: glimpse\ndescription: ${SKILL_DESCRIPTION}\n---\n`)).toBe(true);
    expect(skill).toContain(serverInstructions());
    for (const example of EXAMPLES) {
      expect(skill).toContain(`### ${example.title}`);
      if (example.spec) expect(skill).toContain(example.spec);
    }
    expect(skill).not.toMatch(/\/Users\/|\/home\//);
  });
});

describe('generated files are fresh', () => {
  const artifacts = buildArtifacts();

  it('covers catalog.json, instructions, signatures, the gallery, 26 datasets and 4 host answers', () => {
    expect(Object.keys(artifacts)).toHaveLength(3 + 1 + 26 + 4);
  });

  it.each(Object.keys(artifacts).map(path => [path] as const))('%s matches what `npm run generate` writes', path => {
    expect(existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url))), `${path} is missing: run "npm run generate"`).toBe(true);
    expect(readText(`../${path}`) === artifacts[path], `${path} is stale: run "npm run generate"`).toBe(true);
  });

  it('instructions.txt is serverInstructions() and signatures.txt is typedSignatureList()', () => {
    expect(readText('../generated/instructions.txt')).toBe(serverInstructions() + '\n');
    expect(readText('../generated/signatures.txt')).toBe(typedSignatureList() + '\n');
  });
});

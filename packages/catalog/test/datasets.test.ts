import {describe, expect, it} from 'vitest';
import {
  COMPONENT_BY_NAME, GALLERY_DATA, GALLERY_ROOT, GALLERY_SPEC, formatFileLoc, galleryRoot, gallerySpec, parseFileLoc, parseFlow, parseLineRanges,
  type A2uiMessage, type ErTable, type GraphData, type WireComponent,
} from '../src/index.ts';
import {buildSurface, strictErrors} from '../testing/index.ts';

describe('file anchors and line ranges', () => {
  it('parseFileLoc and formatFileLoc round-trip path, path#L10 and path#L10-40', () => {
    expect(parseFileLoc('src/a.ts')).toEqual({path: 'src/a.ts'});
    expect(parseFileLoc('src/a.ts#L10')).toEqual({path: 'src/a.ts', line: 10});
    expect(parseFileLoc(' src/a.ts#L10-L40 ')).toEqual({path: 'src/a.ts', line: 10, endLine: 40});
    for (const loc of ['src/a.ts', 'src/a.ts#L10', 'src/a.ts#L10-40']) expect(formatFileLoc(parseFileLoc(loc))).toBe(loc);
  });

  it.each([
    ['3,7-9', [[3, 3], [7, 9]]],
    [' 12 - 18 , 30 ', [[12, 18], [30, 30]]],
    ['', []],
    [undefined, []],
  ] as const)('parseLineRanges(%j)', (spec, ranges) => {
    expect(parseLineRanges(spec)).toEqual(ranges);
  });

  // F041: mark='L1-60' highlighted nothing, although files are written 'path#L1-60' everywhere else.
  it.each([
    ['L1-60', [[1, 60]]],
    ['L3,L7-9', [[3, 3], [7, 9]]],
    ['L7-L9', [[7, 9]]],
    ['#L10-20', [[10, 20]]],
    ['l5', [[5, 5]]],
    ['3, L7-9 ,#L12', [[3, 3], [7, 9], [12, 12]]],
  ] as const)('parseLineRanges(%j) reads the file-anchor spelling', (spec, ranges) => {
    expect(parseLineRanges(spec)).toEqual(ranges);
  });

  it('drops what is not a line number', () => {
    expect(parseLineRanges('3,abc,7..9,L,12')).toEqual([[3, 3], [12, 12]]);
    expect(parseLineRanges('3,,7')).toEqual([[3, 3], [7, 7]]);
  });
});

describe('gallery', () => {
  const surface = (buildSurface('gallery', GALLERY_SPEC)[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface;
  const model = surface.dataModel as {g: Record<string, unknown>};
  const one = (component: string): WireComponent => {
    const found = surface.components.filter(c => c.component === component);
    expect(found, component).toHaveLength(1);
    return found[0]!;
  };
  const props = (component: WireComponent) => component as unknown as Record<string, any>;

  it('GALLERY_SPEC is the data plus the default layout', () => {
    expect(GALLERY_SPEC).toBe(GALLERY_DATA + '\n' + GALLERY_ROOT);
    expect(gallerySpec()).toBe(GALLERY_SPEC);
    expect(galleryRoot()).toBe(GALLERY_ROOT);
  });

  // The forms decision D5 accepts beyond the canonical one are in the showcase, so every screenshot run and the
  // end-to-end gallery test exercise them.
  it('exercises the accepted forms: 1-based Steps.current, ER as a table list with fk strings, Layers title and label, mark L-ranges', () => {
    const steps = props(one('Steps'));
    const plan = model.g.plan as Array<{status?: string}>;
    expect(steps.current).toBe(2);
    expect(plan[steps.current - 1]!.status, 'current, counted from 1, is the step that is being done').toBe('doing');

    const schema = model.g.schema as ErTable[];
    expect(Array.isArray(schema), 'a bare table list, not {tables, relations}').toBe(true);
    expect(schema.flatMap(t => t.columns).filter(c => typeof c.fk === 'string').map(c => c.fk)).toEqual(['users.id', 'users.id']);

    const layers = props(one('Layers')).data as Array<Record<string, unknown>>;
    expect(layers.map(layer => Object.keys(layer)[0])).toEqual(['name', 'title', 'label']);

    expect(props(one('CodeView')).mark).toBe('L1-3');
    expect(parseLineRanges(props(one('CodeView')).mark)).toEqual([[1, 3]]);
    expect(props(one('Markdown')).title, 'title= on Markdown draws a plate (F039)').toBe('Markdown');
  });

  it('has an ER table wide enough to fold and graph nodes with a status', () => {
    const schema = model.g.schema as ErTable[];
    // ERDiagram folds a table past 12 columns
    expect(Math.max(...schema.map(t => t.columns.length))).toBeGreaterThan(12);
    const graph = model.g.graph as GraphData;
    expect(graph.nodes.filter(n => n.status).map(n => n.status)).toEqual(['modified', 'affected']);
  });

  // F014: half the file links were struck through as missing, because they named fixture paths that are not in the
  // repository being shown. F092: the outline read README.md, which has no symbols.
  it('points every plate that reads the disk, and every file link in prose, at one file of the host repository', () => {
    const paths = (text: string) => [...text.matchAll(/\[\[([^\]#]+)/g)].map(m => m[1]);
    for (const [file, root] of [['README.md', GALLERY_ROOT], ['packages/server/src/main.ts', galleryRoot({file: 'packages/server/src/main.ts'})]] as const) {
      const built = (buildSurface('g', GALLERY_DATA + '\n' + root)[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface.components.map(props);
      expect(strictErrors(buildSurface('g', GALLERY_DATA + '\n' + root))).toEqual([]);
      const by = (component: string) => built.filter(c => c.component === component);
      expect(by('SymbolOutline')[0]!.file).toBe(file);
      expect(parseFileLoc(by('CodeView')[0]!.file).path).toBe(file);
      expect(by('CodeTour')[0]!.data.map((stop: {file: string}) => parseFileLoc(stop.file).path)).toEqual([file, file]);
      expect(by('FileRef').map(c => parseFileLoc(c.file).path)).toEqual([file]);
      expect(by('Callout').filter(c => c.file).map(c => parseFileLoc(c.file).path)).toEqual([file]);
      expect(by('KeyValue')[0]!.data.Entry).toBe(file);
      for (const text of [...by('Text'), ...by('Markdown')].map(c => String(c.text))) for (const path of paths(text)) expect(path).toBe(file);
      expect([...by('Text'), ...by('Markdown')].flatMap(c => paths(String(c.text))).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('escapes the file it is given', () => {
    const root = galleryRoot({file: "it's/odd \\ file.ts"});
    const built = (buildSurface('g', GALLERY_DATA + '\n' + root)[0] as Extract<A2uiMessage, {createSurface: unknown}>).createSurface.components.map(props);
    expect(built.find(c => c.component === 'SymbolOutline')!.file).toBe("it's/odd \\ file.ts");
  });

  // F014: ten columns in a span-8 plate pushed the last ones off screen with no scroll cue.
  it('gives the ten-column DataTable the full width', () => {
    const table = props(one('DataTable'));
    expect(String(table.columns).split(' ')).toHaveLength(10);
    expect(table.span).toBeUndefined();
  });

  it('still shows all 44 components, and its flowchart parses', () => {
    expect(new Set(surface.components.map(c => c.component)).size).toBe(COMPONENT_BY_NAME.size);
    expect(parseFlow(props(one('Flowchart')).src).ok).toBe(true);
  });
});

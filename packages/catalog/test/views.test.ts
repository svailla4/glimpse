import {describe, expect, it} from 'vitest';
import {COMPONENT_BY_NAME, SOURCE_BY_NAME, VIEW_BY_NAME, acceptsArg, VIEW_INDEX, VIEWS, formatRef, parseViewRef, partsOf, type A2uiMessage, type SourceRef} from '../src/index.ts';
import {compileExpress, expandRefs} from '../testing/index.ts';
import {PRESET_CALLS, presetSource} from './support.ts';

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
    expect(compiled('deps packages/server').refs).toContain('deps.modules packages/server');
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
    expect(wt.refs).toEqual(['code.todos top=8', 'diff.impact wt', 'diff.stats wt', 'diff.tree wt']);
    expect(compiled('diff staged').surface.components.find(c => c.id === 'log')).toMatchObject({component: 'List'});
    const range = compiled('diff main..HEAD');
    expect(range.surface.components.find(c => c.id === 'log')).toMatchObject({component: 'CommitList'});
    expect(range.refs).toEqual(['diff.impact main..HEAD', 'diff.stats main..HEAD', 'diff.tree main..HEAD', 'git.log main..HEAD']);
  });

  it('parseViewRef uses the source-ref grammar', () => {
    expect(parseViewRef('overview')).toEqual({view: 'overview', target: undefined, args: {}});
    expect(parseViewRef('hotspots src since=90d')).toEqual({view: 'hotspots', target: 'src', args: {since: '90d'}});
    expect(parseViewRef('file  src/my file.ts ')).toEqual({view: 'file', target: 'src/my file.ts', args: {}});
    expect(refTexts([{source: 'git.churn', target: 'src', args: {top: '5', since: '90d'}}])).toEqual(['git.churn src since=90d top=5']);
  });
});

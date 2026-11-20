// Bounded auto-repair: what is fixed, what is reported, and what is deliberately left as an error.
import {beforeAll, describe, expect, it} from 'vitest';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {repair} from '../../src/spec/repair.ts';

let tools: Toolchain;
beforeAll(async () => {
  tools = await loadToolchain();
});
const compile = (source: string) => compileSpec(tools, {surfaceId: 's', sources: [source], surfaces: []});

describe('repair', () => {
  it('renames a misspelt component wherever it is called', () => {
    expect(repair('root=Page("x",[DataTabel("a"),DataTabel("b")])', {kind: 'component', name: 'DataTabel'}))
      .toEqual({text: 'root=Page("x",[DataTable("a"),DataTable("b")])', note: 'DataTabel -> DataTable'});
  });

  it('fixes the case of a component name', () => {
    expect(repair('root=page("x",[])', {kind: 'component', name: 'page'})?.text).toBe('root=Page("x",[])');
  });

  it('never edits strings, comments or identifiers that are not calls', () => {
    const text = 'root=Page("DataTabel(x)",[DataTabel("y")]) # DataTabel(\nDataTabel=Text("DataTabel(")';
    expect(repair(text, {kind: 'component', name: 'DataTabel'})?.text).toBe('root=Page("DataTabel(x)",[DataTable("y")]) # DataTabel(\nDataTabel=Text("DataTabel(")');
  });

  it('renames a misspelt prop only as a keyword argument of that component', () => {
    const text = 'root=Page("x",[DataTable("a",colums="path"),Text("colums=1"),Grid([DataTable("b", colums = "n")],cols="2")])';
    expect(repair(text, {kind: 'prop', component: 'DataTable', name: 'colums'})).toEqual({
      text: 'root=Page("x",[DataTable("a",columns="path"),Text("colums=1"),Grid([DataTable("b", columns = "n")],cols="2")])',
      note: 'colums -> columns',
    });
  });

  it('leaves names that are too far from anything, or ambiguous', () => {
    expect(repair('root=Page("x",[Chart("a")])', {kind: 'component', name: 'Chart'})).toBeUndefined();
    expect(repair('root=Page("x",[Widget()])', {kind: 'component', name: 'Widget'})).toBeUndefined();
    expect(repair('root=Page("x",[DataTable("a",colour="x")])', {kind: 'prop', component: 'DataTable', name: 'colour'})).toBeUndefined();
    expect(repair('root=Page("x",[Stat(1,x=2)])', {kind: 'prop', component: 'Stat', name: 'x'})).toBeUndefined();
  });

  it('closes brackets left open at the end of the input', () => {
    expect(repair('root=Page("x",[Markdown("y"),Grid([Text("a")', {kind: 'eof'})).toEqual({text: 'root=Page("x",[Markdown("y"),Grid([Text("a")])])', note: 'end of input -> ])])'});
    expect(repair('$/plan=[{title:"A"', {kind: 'eof'})?.text).toBe('$/plan=[{title:"A"}]');
  });

  it('puts the closers on a new line when the text ends in a comment, and ignores brackets inside strings', () => {
    expect(repair('root=Page("(x",[Text("a") # tail\n', {kind: 'eof'})?.text).toBe('root=Page("(x",[Text("a") # tail\n])');
  });

  it('does not guess when brackets are mismatched or already balanced', () => {
    expect(repair('root=Page("x",[Text("a"))', {kind: 'eof'})).toBeUndefined();
    expect(repair('root=Page("x",[Text("a")])', {kind: 'eof'})).toBeUndefined();
  });
});

describe('repair inside compileSpec', () => {
  it('fixes a component, a prop and a missing bracket in one call and reports each', () => {
    const {messages, fixes} = compile(`root=Page('x',[DataTabel('fake.rows',colums='path')`);
    expect(fixes).toEqual(['end of input -> ])', 'DataTabel -> DataTable', 'colums -> columns']);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components[1]).toEqual({id: 'root_children_0', component: 'DataTable', data: 'fake.rows', columns: 'path'});
  });

  it('gives up after four repairs', () => {
    expect(compile(`root=Page('x',[Texxt('a'),Markdwn('b'),Callot('c'),Chps()])`).fixes).toHaveLength(4);
    expect(() => compile(`root=Page('x',[Texxt('a'),Markdwn('b'),Callot('c'),Chps(),Sttat(1)])`)).toThrow(/^E_UNKNOWN /);
  });

  it('does not repair enum values, types or references', () => {
    expect(() => compile(`root=Page('x',[Callout('y','risky')])`)).toThrow(/^E_ENUM/);
    expect(() => compile(`root=Page('x',[notez])\nnotes=Text('a')`)).toThrow(/^E_REF/);
  });
});

// Express -> messages: the normalizer table as the compiler sees it, surface creation and patching on a seeded twin,
// preset-plus-patch on one twin, and line mapping for multi-line strings.
import {VIEW_BY_NAME, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {calcText, compileSpec, loadToolchain, originalLine, rootLineOf, strayText, unclosedString, type Seed, type Toolchain} from '../../src/spec/compile.ts';
import {normalizeSpec} from '../../src/spec/normalize.ts';

let tools: Toolchain;
beforeAll(async () => {
  tools = await loadToolchain();
});

const compile = (sources: string | string[], seed?: Seed) =>
  compileSpec(tools, {surfaceId: 'demo', ...(seed ? {seed} : {}), sources: Array.isArray(sources) ? sources : [sources], surfaces: seed ? ['demo'] : []});
const kind = (message: A2uiMessage) => Object.keys(message).find(key => key !== 'version')!;
const created = (messages: A2uiMessage[]): WireComponent[] => {
  const first = messages[0]!;
  if (!('createSurface' in first)) throw new Error('expected createSurface');
  return first.createSurface.components;
};
const seedOf = (messages: A2uiMessage[]): Seed => {
  const first = messages[0]!;
  if (!('createSurface' in first)) throw new Error('expected createSurface');
  return {components: first.createSurface.components, data: first.createSurface.dataModel ?? {}};
};

describe('normalizer, as the compiler receives it', () => {
  it.each([
    ['apostrophe inside single quotes', `root=Page('x',[Text('It doesn't retry')])`, "It doesn't retry"],
    ['apostrophe before a closing delimiter', `root=Page('x',[Text('dogs' ears', 'lead')])`, "dogs' ears"],
    ['double quotes nested in single quotes', `root=Page('x',[Text('say "hi" twice')])`, 'say "hi" twice'],
    ['single quotes nested in double quotes', `root=Page('x',[Text("it's 'fine'")])`, "it's 'fine'"],
    ['escaped apostrophe', `root=Page('x',[Text('rock \\'n\\' roll')])`, "rock 'n' roll"],
    ['escape sequences are kept for the compiler', `root=Page('x',[Text('a\\tb')])`, 'a\tb'],
    ['a raw newline inside a string', `root=Page('x',[Text('line one\nline two')])`, 'line one\nline two'],
    ['a comment marker inside a string is text', `root=Page('x',[Text('see http://x.y/#frag')])`, 'see http://x.y/#frag'],
  ])('%s', (_name, spec, expected) => {
    const text = created(compile(spec).messages).find(c => c.component === 'Text')!;
    expect(text.text).toBe(expected);
  });

  it('comments are ignored, apostrophes in them included', () => {
    const {messages} = compile(`# it's a comment\nroot=Page('x',[a]) // don't mind me\na=Text('y')`);
    expect(created(messages).map(c => c.id)).toEqual(['root', 'a']);
  });

  it('spec/normalize.ts re-exports the catalog normalizer', () => {
    expect(normalizeSpec(`a=Text('it's')`)).toBe(`a=Text("it's")`);
  });
});

describe('compileSpec', () => {
  it('a spec with root creates the surface in one message, data folded in', () => {
    const {messages, fixes} = compile(`$/notes='hello'\nroot=Page('Title',[notes])\nnotes=Markdown($/notes)`);
    expect(messages.map(kind)).toEqual(['createSurface']);
    expect(fixes).toEqual([]);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('unreachable');
    expect(first.createSurface.surfaceId).toBe('demo');
    expect(first.createSurface.dataModel).toEqual({notes: 'hello'});
    expect(created(messages)).toEqual([
      {id: 'root', component: 'Page', title: 'Title', children: ['notes']},
      {id: 'notes', component: 'Markdown', text: {'@path': '/notes'}},
    ]);
  });

  it('a patch of an existing surface compiles to the delta only', () => {
    const seed = seedOf(compile(VIEW_BY_NAME.get('feature')!.build(undefined, {})).messages);
    const {messages} = compile(`$/plan/0/status='done';$/plan/1/status='doing'\ndesign=Flowchart({edges:[['A','B']]},title='Design')`, seed);
    expect(messages.map(kind).sort()).toEqual(['updateComponents', 'updateDataModel', 'updateDataModel']);
    const update = messages.find(m => 'updateComponents' in m)!;
    if (!('updateComponents' in update)) throw new Error('unreachable');
    expect(update.updateComponents.components).toEqual([{id: 'design', component: 'Flowchart', data: {edges: [['A', 'B']]}, title: 'Design'}]);
    expect(messages.filter(m => 'updateDataModel' in m).map(m => ('updateDataModel' in m ? m.updateDataModel.path : ''))).toEqual(['/plan/0/status', '/plan/1/status']);
  });

  it('root= on an existing surface compiles to an update of root (the store decides it is a replace)', () => {
    const seed = seedOf(compile(`root=Page('One',[a])\na=Text('a')`).messages);
    const {messages} = compile(`root=Page('Two',[a,Text('new')])`, seed);
    expect(messages.map(kind)).toEqual(['updateComponents']);
  });

  it('a preset followed by a spec compiles on one twin: create, then the patch', () => {
    const {messages, texts} = compile([VIEW_BY_NAME.get('feature')!.build(undefined, {}), `$/plan=[{title:'A',status:'doing'}]`]);
    expect(messages.map(kind)).toEqual(['createSurface', 'updateDataModel']);
    expect(texts).toHaveLength(2);
  });

  it('the seed is not mutated and nothing persists between calls', () => {
    const seed = seedOf(compile(`$/n=1\nroot=Page('One',[a])\na=Text('a')`).messages);
    const before = JSON.stringify(seed);
    compile(`a=Text('changed')\n$/n=2`, seed);
    expect(() => compile(`a=Bogus('broken')`, seed)).toThrow(/^E_UNKNOWN/);
    expect(JSON.stringify(seed)).toBe(before);
    // a later compile against the same seed starts from the seed, not from the earlier patch
    expect(compile(`$/n=3`, seed).messages.map(kind)).toEqual(['updateDataModel']);
  });

});

// Finding F036: both cold writers added a part to a preset and got E_REF with nothing they could resend.
describe('a new part nobody refers to', () => {
  const stored = () => seedOf(compile(`root=Page($/meta/repo/name,[kpis,notes],subtitle='Overview')\nkpis=Stats()\nnotes=Markdown('n')`).messages);

  it('is appended to the stored root on a patch, and the fix says so', () => {
    const {messages, fixes} = compile(`notes=Markdown('changed')\ntodos=DataTable('code.todos',title='TODO comments')`, stored());
    expect(fixes).toEqual(['todos appended to root (resend root=... to place it elsewhere)']);
    expect(messages.map(kind)).toEqual(['updateComponents', 'updateComponents']);
    const [rootUpdate, patch] = messages as Array<Extract<A2uiMessage, {updateComponents: unknown}>>;
    // the root keeps everything it had: the bound title, the subtitle, the children in order
    expect(rootUpdate!.updateComponents.components).toEqual([{id: 'root', component: 'Page', title: {'@path': '/meta/repo/name'}, children: ['kpis', 'notes', 'todos'], subtitle: 'Overview'}]);
    expect(patch!.updateComponents.components.map(c => [c.id, c.component])).toEqual([['notes', 'Markdown'], ['todos', 'DataTable']]);
  });

  it('works for several parts at once and for a preset patched in the same call', () => {
    expect(compile(`a=Text('a')\nb=Text('b')\nc=Text('c')`, stored()).fixes).toHaveLength(3);
    const overview = VIEW_BY_NAME.get('overview')!.build(undefined, {});
    const {messages, fixes} = compile([overview, `todos=DataTable('code.todos',title='TODO comments')`]);
    expect(fixes).toEqual(['todos appended to root (resend root=... to place it elsewhere)']);
    const root = messages.flatMap(message => ('updateComponents' in message ? message.updateComponents.components : [])).find(c => c.id === 'root')!;
    expect((root.children as string[]).at(-1)).toBe('todos');
    expect(root.children).toEqual([...(created(messages).find(c => c.id === 'root')!.children as string[]), 'todos']);
  });

  it('stays an error when the text writes its own root, and on a new view', () => {
    expect(() => compile(`root=Page('x',[a])\na=Text('a')\nb=Text('b')`, stored())).toThrow(/^E_REF "b" is not reachable from root: resend its parent with the new child\.$/);
    expect(() => compile(`root=Page('x',[a])\na=Text('a')\nb=Text('b')`)).toThrow(/^E_REF "b" is not reachable from root/);
  });

  it('rootLineOf writes the exact statement to resend, or nothing when it cannot be exact', () => {
    const root = stored().components.find(c => c.id === 'root')!;
    const line = rootLineOf(root, 'todos')!;
    expect(line).toBe(`root=Page(title=$/meta/repo/name,children=[kpis,notes,todos],subtitle='Overview')`);
    // the line is real Express: it compiles against the stored view together with the part it adopts
    expect(compile(`${line}\ntodos=Text('t')`, stored()).fixes).toEqual([]);
    expect(rootLineOf({id: 'root', component: 'Page', title: `it's`, children: ['a']}, 'b')).toBe(`root=Page(title='it\\'s',children=[a,b])`);
    expect(rootLineOf({id: 'root', component: 'Page', title: 'x', children: {componentId: 'row', path: '/items'}}, 'b')).toBeUndefined();
    expect(rootLineOf(undefined, 'b')).toBeUndefined();
  });
});

// Finding F054: the compiler accepts bare words and strings as statements and does nothing with them.
describe('what the compiler lets through in silence', () => {
  it('reports text that is not a statement', () => {
    expect(compile(`root=Page('U',[Text('abc')]) trailing garbage here`).warnings).toEqual(['line 1: ignored text that is not a statement: "trailing garbage here"']);
    expect(compile(`Here is the view\nroot=Page('U',[a])\na=Text('x'); $/n=5 extra`).warnings).toEqual([
      'line 1: ignored text that is not a statement: "Here is the view"',
      'line 3: ignored text that is not a statement: "extra"',
    ]);
    expect(strayText(`a=Text("x") b=Text("y"); $/k=[1,2] # note\n$/m={a:1}\nc=d`)).toEqual([]);
    expect(strayText('"just a string"')).toEqual(['line 1: ignored text that is not a statement: "\\"just a string\\""']);
  });

  it('a clean spec has no warnings', () => {
    expect(compile(`# heading\nroot=Page('x',[a, Grid([b],_,'m')]) // tail\na=Text('one')\nb=Steps($/plan)\n$/plan=[{title:'A',status:'done'}]`).warnings).toEqual([]);
  });

  it('refuses to close brackets after a string that swallowed code, and says where it began', () => {
    expect(unclosedString(`root=Page('U',[Text('abc`)).toEqual({line: 1, col: 21, swallowed: 'abc'});
    expect(unclosedString(`root=Page('U',[Text('it's fine')])`)).toBeUndefined();
    expect(unclosedString(`a=Text("open\nb=Text('x')`)).toMatchObject({line: 1, col: 8});
    expect(unclosedString(`# it's a comment\na=Text('x')`)).toBeUndefined();
    // truncated mid-string: repaired, and the note says a string was cut
    expect(compile(`root=Page('U',[Text('abc`).fixes).toEqual(['unterminated string at line 1 col 21, end of input -> )])']);
    // a string that ran over the rest of the call: closing brackets would render the code as text
    expect(() => compile(`root=Page('U',[Text('one), Text(two)])`)).toThrow(/^E_SYNTAX line 1 col 21: this string never ends/);
  });
});

describe('calls (decision D25)', () => {
  it('a call with more than two arguments is E_TYPE with the line, not computed without the rest', () => {
    expect(() => compile(`$/a=1\nroot=Page('x',[Stat(div($/a,2,3),'n')])`))
      .toThrow(/^E_TYPE line 2: div takes 2 arguments \(a, b\); this call passes 3\. Nest calls for more: add\(add\(\$\/a,\$\/b\),\$\/c\)\.$/);
    // a nested call is counted on its own, and the line is the one the author wrote
    expect(() => compile(`root=Page('x',[a,b])\na=Text('one\ntwo')\nb=Stat(add(mul(1,2,3,4),5))`)).toThrow(/^E_TYPE line 4: mul takes 2 arguments \(a, b\); this call passes 4\./);
    // by keyword, an argument beyond a and b is the compiler's own E_PROP
    expect(() => compile(`root=Page('x',[Stat(div(a=1,b=2,c=3))])`)).toThrow(/^E_PROP div: unknown argument "c"\. Arguments: a b$/);
    expect(calcText(`x=Stat(add(add(1,2),3))`, `x=Stat(add(add(1,2),3))`)).toEqual({warnings: []});
  });

  it('a call written as a statement of its own is left out and said, never refused', () => {
    const {messages, warnings, steps} = compile(`root=Page('x',[Stat(1,'n')])\n\ndiv(1,2)`);
    expect(messages.map(kind)).toEqual(['createSurface']);
    expect(steps).toEqual([0]);
    expect(warnings).toEqual([`line 3: div(...) on its own computes nothing and was left out; use it as an argument, e.g. Stat(div(...),'label').`]);
    // an alias renamed first is said by its own name
    const renamed = compile(`root=Page('x',[Stat(1,'n')]); multiply(2,3)`);
    expect(renamed.fixes).toEqual(['multiply -> mul']);
    expect(renamed.warnings).toEqual([`line 1: mul(...) on its own computes nothing and was left out; use it as an argument, e.g. Stat(mul(...),'label').`]);
    // and in a patch; a patch of nothing else defines nothing, and says why
    const seed = seedOf(compile(`root=Page('x',[a])\na=Stat(1,'n')`).messages);
    expect(compile(`$/k=1\nadd(1,2)`, seed).warnings).toEqual([`line 2: add(...) on its own computes nothing and was left out; use it as an argument, e.g. Stat(add(...),'label').`]);
    expect(() => compile(`add(1,2)`, seed)).toThrow(/^E_REF the spec defines nothing to render: line 1: add\(\.\.\.\) on its own computes nothing/);
  });

  it('a named call nothing in the text uses is a warning; one that is used is not', () => {
    // review S9: a whole spec has no other parts to resend, so it is told that nothing uses the name
    expect(compile(`root=Page('x',[Stat(1,'n')])\nrps=div(1,2)`).warnings)
      .toEqual([`line 2: nothing uses rps, so rps=div(...) computes nothing; use it as an argument, e.g. Stat(rps,'label').`]);
    const used = compile(`root=Page('x',[s])\ns=Stat(rps,'n')\nrps=div(1,2)`);
    expect(used.warnings).toEqual([]);
    expect(created(used.messages).find(c => c.id === 's')!.value).toEqual({'@call': 'div', args: {a: 1, b: 2}});
    // a patch that resends the named call without the parts that use it
    const seed = seedOf(used.messages);
    expect(compile(`$/k=1\nrps=div(3,4)`, seed).warnings).toEqual(['line 2: rps=div(...) is copied into the arguments that use rps, so on its own it changes nothing; resend the parts that use rps.']);
    expect(() => compile(`rps=div(3,4)`, seed)).toThrow(/^E_REF the spec defines nothing to render: line 1: rps=div\(\.\.\.\) is copied into the arguments that use rps/);
    expect(compile(`rps=div(3,4)\ns=Stat(rps,'n')`, seed).warnings).toEqual([]);
  });

  it('fixes multiply -> mul, and says there are no operators for * and +, not for -', () => {
    expect(compile(`root=Page('x',[Stat(multiply(2,3))])`).fixes).toEqual(['multiply -> mul']);
    expect(() => compile(`root=Page('x',[Stat($/x*2)])`)).toThrow(/There are no operators: write mul\(a, b\), div\(a, b\), add\(a, b\) or sub\(a, b\)\.$/);
    expect(() => compile(`root=Page('x',[Stat($/x + 2)])`)).toThrow(/There are no operators/);
    expect(() => compile(`root=Page('x',[Stat($/a-$/b)])`)).toThrow(/^E_SYNTAX line 1 col \d+: token recognition error at: '-\$'$/);
  });
});

describe('originalLine', () => {
  it('is the identity when no string spans lines', () => {
    const source = `root=Page('x',[a])\na=Text('one')\nb=Text('two')`;
    expect([1, 2, 3].map(line => originalLine(source, line))).toEqual([1, 2, 3]);
  });

  it('skips the lines a multi-line single-quoted string swallowed', () => {
    const source = `a=Text('one\ntwo\nthree')\nb=Text('x')\nc=Text('y')`;
    // normalized: line 1 holds the whole string, line 2 is b, line 3 is c
    expect(originalLine(source, 1)).toBe(1);
    expect(originalLine(source, 2)).toBe(4);
    expect(originalLine(source, 3)).toBe(5);
  });

  it('is used for syntax errors', () => {
    const source = `root=Page('x',[a])\na=Markdown('one\ntwo')\nb=Text('y',,)`;
    expect(() => compile(source)).toThrow(/^E_SYNTAX line 4 col /);
  });
});

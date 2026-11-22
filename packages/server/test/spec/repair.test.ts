// Bounded auto-repair: what is fixed, what is reported, and what is deliberately left as an error.
import {GALLERY_SPEC, VIEWS} from '@glimpse/catalog';
import {beforeAll, describe, expect, it} from 'vitest';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {enumMeant, repair} from '../../src/spec/repair.ts';

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
    expect(repair('root=Page("x",[Callout("y"),Grid([Text("a")', {kind: 'eof'})).toEqual({text: 'root=Page("x",[Callout("y"),Grid([Text("a")])])', note: 'end of input -> ])])'});
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

  // Decision D26: Markdown was removed; a spec written from habit or from an older skill still draws, as Text, and the
  // model hears what Text does not draw.
  it('draws a removed Markdown as Text and says what Text does not carry over', () => {
    const {messages, fixes} = compile(`root=Page('x',[Markdown('hi'),notes])\nnotes=Markdown($/notes,title='Notes')`);
    expect(fixes).toEqual(['Markdown -> Text: headings, tables and code fences show as written: use Section, DataTable, CodeBlock']);
    // a result prints a fix in at most 120 characters (mcp/result.ts): the note must arrive whole
    expect(fixes[0]!.length).toBeLessThanOrEqual(120);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components.slice(1)).toEqual([
      {id: 'notes', component: 'Text', text: {'@path': '/notes'}, title: 'Notes'},
      {id: 'root_children_0', component: 'Text', text: 'hi'},
    ]);
  });

  it('gives up after six repairs', () => {
    expect(compile(`root=Page('x',[Texxt('a'),Colum([]),Callot('c'),Chps(),Sttat(1),Lisst([])])`).fixes).toHaveLength(6);
    expect(() => compile(`root=Page('x',[Texxt('a'),Colum([]),Callot('c'),Chps(),Sttat(1),Lisst([]),Stepz([])])`)).toThrow(/^E_UNKNOWN /);
  });

  it('does not guess at an enum value that resembles nothing, nor at references', () => {
    expect(() => compile(`root=Page('x',[Callout('y','purple')])`)).toThrow(/^E_ENUM Callout\.kind: "purple" is not allowed\. Use: note tip warn risk decision question/);
    expect(() => compile(`root=Page('x',[notez])\nnotes=Text('a')`)).toThrow(/^E_REF/);
  });

  // Decision D5 and finding F035: 3 of 4 first Callout attempts wrote kind 'warning'.
  it.each([
    [`Callout('Careful','warning')`, 'Callout.kind warning -> warn', {kind: 'warn'}],
    [`Callout('Careful',kind='danger')`, 'Callout.kind danger -> risk', {kind: 'risk'}],
    [`Callout('Careful','error')`, 'Callout.kind error -> risk', {kind: 'risk'}],
    [`Callout('Careful','Warn')`, 'Callout.kind Warn -> warn', {kind: 'warn'}],
    [`Callout('Careful','risky')`, 'Callout.kind risky -> risk', {kind: 'risk'}],
    [`Text('a',tone='muted')`, 'Text.tone muted -> dim', {tone: 'dim'}],
  ])('accepts the enum synonym in %s', (call, note, props) => {
    const {messages, fixes} = compile(`root=Page('x',[${call}])`);
    expect(fixes).toEqual([note]);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components[1]).toMatchObject(props);
  });

  // Blind-writer measurement: six of twelve pages carried 'fixed Callout.kind info -> note' (five) or
  // 'success -> tip' (one), the most frequent result line. What models write for a kind is taken without a word.
  it.each([
    [`Callout('Careful',kind='info')`, {kind: 'note'}],
    [`Callout('Careful','success')`, {kind: 'tip'}],
    [`Callout('Careful','Info')`, {kind: 'note'}],
  ])('takes the kind models write, %s, without a fixed line', (call, props) => {
    const {messages, fixes} = compile(`root=Page('x',[${call}])`);
    expect(fixes).toEqual([]);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components[1]).toMatchObject(props);
  });

  it('replaces only the argument that sets the prop, never a string that happens to read the same', () => {
    const {messages, fixes} = compile(`root=Page('warning',[Callout('warning','warning'),Text('warning')])`);
    expect(fixes).toEqual(['Callout.kind warning -> warn']);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components.map(c => [c.component, c.title ?? c.text, c.kind])).toEqual([['Page', 'warning', undefined], ['Callout', 'warning', 'warn'], ['Text', 'warning', undefined]]);
  });

  // Finding F037: Grid([...],4) and Split(a,b,0.3) were rejected without saying what is accepted. Finding V015: the
  // quoting changes nothing the author would notice, so it is silent.
  it('quotes a number where the prop takes a string, positional or by keyword, without a fixed line', () => {
    const {messages, fixes} = compile(`root=Page('x',[Grid([Text('a')],4),Grid([Text('b')],cols=3,gap='m'),Split(Text('c'),Text('d'),0.3),Grid([Text('e')],cols=12)])`);
    expect(fixes).toEqual([]);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components.filter(c => c.component === 'Grid').map(c => c.cols)).toEqual(['4', '3', '12']);
    expect(first.createSurface.components.find(c => c.component === 'Split')!.ratio).toBe('0.3');
  });
});

// Decision D15 for enums (finding V069): aliases are rewritten in one pass before anything is compiled.
describe('rewrite before the first compile', () => {
  const componentsOf = (source: string) => {
    const first = compile(source).messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    return first.createSurface.components;
  };

  it('rewrites every enum alias of a spec, however many there are', () => {
    const {fixes} = compile(`root=Page('Seven aliases',[Callout('a','warning'),Callout('b',kind='Danger'),Treemap(value='lines',color='language',size='large'),Graph(dir='down'),Stat(5,'x',format='percent'),Text('t',tone='muted'),Grid([Text('g')],gap='small')])`);
    expect(fixes).toEqual([
      'Callout.kind warning -> warn', 'Callout.kind Danger -> risk', 'Treemap.value lines -> loc', 'Treemap.color language -> lang', 'Treemap.size large -> l',
      'Graph.dir down -> TB', 'Stat.format percent -> pct', 'Text.tone muted -> dim', 'Grid.gap small -> s',
    ]);
  });

  // Finding V042: the instructions write Button(label, action); a model writes the action as a plain name.
  it('reads a plain string action as Event of that name', () => {
    const {fixes} = compile(`root=Page('x',[go])\ngo=Button('Draft the doc','draft')`);
    expect(fixes).toEqual([`Button.action 'draft' -> Event('draft')`]);
    expect(componentsOf(`root=Page('x',[go])\ngo=Button('Draft the doc','draft')`).find(c => c.id === 'go')!.action).toEqual({event: {name: 'draft'}});
    expect(compile(`root=Page('x',[Button('Go',Event('go',{n:1}))])`).fixes).toEqual([]);
  });

  it('reads a list of field names, where a prop takes them as one string, as that string; DataTable columns take the list as it is', () => {
    const {fixes, messages} = compile(`root=Page('x',[DataTable('git.log',columns=['sha','subject','date']),LineChart('git.activity',y=['commits'])])`);
    expect(fixes).toEqual([`LineChart.y ['commits'] -> 'commits'`]);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components.find(c => c.component === 'DataTable')!.columns).toEqual(['sha', 'subject', 'date']);
  });

  // Finding V043: surface ids take hyphens, so part names are written that way too.
  it('reads a hyphenated part name with underscores, everywhere it is used', () => {
    const {fixes, messages} = compile(`root=Page("Kebab", [my-part, other-long-name])\nmy-part=Text("hello")\nother-long-name=Text('a-b stays in a string')`);
    expect(fixes).toEqual(['my-part -> my_part (part names use letters, digits and _)', 'other-long-name -> other_long_name (part names use letters, digits and _)']);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components.map(c => c.id)).toEqual(['root', 'my_part', 'other_long_name']);
    expect(first.createSurface.components.find(c => c.id === 'other_long_name')!.text).toBe('a-b stays in a string');
  });
});

describe('the presets and the gallery need none of it', () => {
  it.each([...VIEWS.map(view => [view.name, view.build(view.targetRequired ? (view.target === 'symbol' ? 'Session' : 'src/a.ts') : undefined, {})] as const), ['gallery', GALLERY_SPEC] as const])('%s compiles with no fix and no warning', (_, source) => {
    const {fixes, warnings} = compile(source);
    expect(fixes).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('function names (decision D25)', () => {
  it('renames a function written another way wherever it is called, and says so', () => {
    expect(repair('root=Page("x",[Stat(multiply($/a,2)),Stat(multiply(1,2))])', {kind: 'call', name: 'multiply'}))
      .toEqual({text: 'root=Page("x",[Stat(mul($/a,2)),Stat(mul(1,2))])', note: 'multiply -> mul'});
    expect(repair('Stat(Div(1,2),"Div(")', {kind: 'call', name: 'Div'})).toEqual({text: 'Stat(div(1,2),"Div(")', note: 'Div -> div'});
  });

  it('leaves a name that stands for none of the four', () => {
    expect(repair('Stat(pow(2,3))', {kind: 'call', name: 'pow'})).toBeUndefined();
    expect(repair('Stat(mod(2,3))', {kind: 'call', name: 'mod'})).toBeUndefined();
  });

  it('compiles multiply, Div, sum and mult as the function they mean, with a fixed line; pow and mod stay errors', () => {
    for (const [written, meant] of [['multiply', 'mul'], ['Div', 'div'], ['sum', 'add'], ['mult', 'mul']] as const) {
      const {fixes, messages} = compile(`root=Page('x',[Stat(${written}(6,3),'n')])`);
      expect(fixes, written).toEqual([`${written} -> ${meant}`]);
      const first = messages[0]!;
      if (!('createSurface' in first)) throw new Error('expected createSurface');
      expect(first.createSurface.components[1]!.value).toEqual({'@call': meant, args: {a: 6, b: 3}});
    }
    expect(() => compile(`root=Page('x',[Stat(pow(2,3))])`)).toThrow(/^E_UNKNOWN "pow" is not a function\. Functions: add sub mul div, each \(a, b\)\.$/);
    expect(() => compile(`root=Page('x',[Stat(mod(2,3))])`)).toThrow(/^E_UNKNOWN "mod" is not a function\./);
  });

  // Review S7: each alias spent one of the six repair passes, so the seventh was 'not a function'.
  it('renames every function alias before the first compile, one fixed line per name, however many there are', () => {
    const stat = (call: string) => `Stat(${call}($/w/seats,2),'n')`;
    const {fixes} = compile(`root=Page('T',[r])\n$/w={seats:50000}\nr=Row([Stat(divide(multiply($/w/seats,0.6),2),'a'),${['Mul', 'times', 'minus', 'plus', 'subtract', 'times'].map(stat).join(',')}])`);
    expect(fixes).toEqual(['divide -> div', 'multiply -> mul', 'Mul -> mul', 'times -> mul', 'minus -> sub', 'plus -> add', 'subtract -> sub']);
  });

  // Review S1: every lower-case unknown name was called 'not a function', so table and tree lost their repair.
  it('a lower-case component name is still repaired; a function-like one is a function; a word of several is either', () => {
    expect(compile(`root=Page('x',[a])\na=table('fake.rows')`).fixes).toEqual(['table -> DataTable']);
    expect(compile(`root=Page('x',[a])\na=tree()`).fixes).toEqual(['tree -> FileTree']);
    expect(compile(`root=Page('x',[a])\na=tabel('fake.rows')`).fixes).toEqual(['tabel -> DataTable']);
    expect(() => compile(`root=Page('x',[a])\na=pow(2,3)`)).toThrow(/^E_UNKNOWN "pow" is not a function\. Functions: add sub mul div, each \(a, b\)\.$/);
    expect(() => compile(`root=Page('x',[a])\na=chart('fake.rows')`))
      .toThrow(/^E_UNKNOWN "chart" is not a component or a function\. Nearest: BarChart LineChart \w+\. Functions: add sub mul div, each \(a, b\)\.$/);
  });

  // D25 and D26 together: the removed Markdown is a component in any case (D25 reads a lower-case component name as
  // that component), so it becomes Text with D26's note and never "not a function"; the D25 readings are unchanged.
  it('reads a removed Markdown in any case as Text with its note, next to table, pow and multiply as before', () => {
    const note = 'headings, tables and code fences show as written: use Section, DataTable, CodeBlock';
    const lower = compile(`root=Page('x',[a,b])\na=markdown('hi')\nb=Text('ok')`);
    expect(lower.fixes).toEqual([`markdown -> Text: ${note}`]);
    const first = lower.messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    expect(first.createSurface.components.find(c => c.id === 'a')).toEqual({id: 'a', component: 'Text', text: 'hi'});
    const together = compile(`root=Page('x',[a,b,c])\n$/w={n:2}\na=Markdown('hi')\nb=table('fake.rows')\nc=Stat(multiply($/w/n,2),'n')`);
    expect(together.fixes).toEqual(['multiply -> mul', `Markdown -> Text: ${note}`, 'table -> DataTable']);
    expect(() => compile(`root=Page('x',[Markdown('hi'),Stat(pow(2,3))])`)).toThrow(/^E_UNKNOWN "pow" is not a function\. Functions: add sub mul div, each \(a, b\)\.$/);
  });
});

describe('errors that point at the mistake', () => {
  // Finding V041: Tabel was read as Tabs, and the error then blamed Tabs for a missing children prop.
  it('a misspelt component is matched by its words, and a guess that does not fit says what was written', () => {
    const {fixes} = compile(`root=Page('x',[Tabel('fake.rows')])`);
    expect(fixes).toEqual(['Tabel -> DataTable']);
    expect(compile(`root=Page('x',[Table('fake.rows')])`).fixes).toEqual(['Table -> DataTable']);
    expect(() => compile(`root=Page('x',[Chart('a')])`)).toThrow(/^E_UNKNOWN "Chart" is not a component\. Nearest: \w+Chart \w+Chart/);
    expect(() => compile(`root=Page('x',[Tabz()])`)).toThrow(/^E_UNKNOWN "Tabz" is not a component \(read as Tabs, it fails: Tabs: missing required prop "\w+"\.?\)\. Nearest: Tabs/);
    // when the spec also calls the component by its own name, the failure may be that call's: said as it is
    expect(() => compile(`root=Page('x',[Tabz(),Tabs(['a'])])`)).toThrow(/^E_REQUIRED Tabs: missing required prop/);
  });

  // Final confirm s27: Button('Go','go') was accepted with a fixed note, Buton('Go','go') was rejected with "Expects
  // ... a plain 'name' (read as Event('name'))": the renamed call never got the rewrites the real name gets.
  it('a renamed component gets the same deterministic rewrites as one written by its own name', () => {
    const {fixes, messages} = compile(`root=Page('Oops',[Buton('Go', 'go'),Calout('Careful','warning'),Grd([Text('a')],3)])`);
    expect(fixes).toEqual(['Buton -> Button', `Button.action 'go' -> Event('go')`, 'Calout -> Callout', 'Callout.kind warning -> warn', 'Grd -> Grid']);
    const first = messages[0]!;
    if (!('createSurface' in first)) throw new Error('expected createSurface');
    const comps = first.createSurface.components;
    expect(comps.find(c => c.component === 'Button')!.action).toEqual({event: {name: 'go'}});
    expect(comps.find(c => c.component === 'Callout')!.kind).toBe('warn');
    expect(comps.find(c => c.component === 'Grid')!.cols).toBe('3');
    // a renamed prop too: actoin= is action=, and its plain name is an Event
    expect(compile(`root=Page('x',[Button('Go',actoin='go')])`).fixes).toEqual(['actoin -> action', `Button.action 'go' -> Event('go')`]);
  });

  // Finding V022: "Text" is not a component. Nearest: Text.
  it('a known component written as a statement of its own is said to need a name', () => {
    expect(() => compile(`root=Page('x',[])\nText('hi')`)).toThrow(/^E_REF line 2: Text\(\.\.\.\) is not assigned to a name\. Write part=Text\(\.\.\.\) and list part in a parent's children/);
  });

  // Finding V040: a missing closing quote swallowed the next component into prose, with a bare ok.
  it('a string that runs on into the next component is a warning that says where', () => {
    expect(compile(`root=Page('Unclosed',[Text('this string never ends), Text('after')])`).warnings).toEqual([
      "line 1 col 28: this string runs on into Text(...), so that part is drawn as text. A ' closes a string only before , ) ] } : = ; or a line end; check its quotes.",
    ]);
    expect(compile(`root=Page('Fine',[Text('Use Text(...) for a label, and DataTable for rows.')])`).warnings).toEqual([]);
  });
});

describe('enumMeant', () => {
  it('prefers the same word in another case, then a synonym the prop allows, then a near miss', () => {
    expect(enumMeant('STACKED', ['grouped', 'stacked', 'pct'])).toBe('stacked');
    expect(enumMeant('percent', ['grouped', 'stacked', 'pct'])).toBe('pct');
    expect(enumMeant('error', ['neutral', 'good', 'warn', 'bad', 'info'])).toBe('bad');
    expect(enumMeant('error', ['note', 'tip', 'warn', 'risk'])).toBe('risk');
    expect(enumMeant('stackd', ['grouped', 'stacked', 'pct'])).toBe('stacked');
    expect(enumMeant('purple', ['note', 'tip', 'warn', 'risk'])).toBeUndefined();
    expect(enumMeant('', ['note'])).toBeUndefined();
    // a word of Object.prototype is not a synonym
    expect(enumMeant('constructor', ['note', 'tip'])).toBeUndefined();
  });
});

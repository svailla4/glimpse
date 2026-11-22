// The Express normalizer is shared by the server, the catalog tooling, the generated fixtures and the viewer test
// harness, so its behaviour is pinned here, next to its definition.
import {describe, expect, it} from 'vitest';
import {normalizeSpec} from '../src/index.ts';
import {compileExpress} from '../testing/index.ts';

describe('normalizeSpec', () => {
  it.each([
    // plain single quotes become double quotes
    [`a=Text('hello')`, `a=Text("hello")`],
    [`a=Text('')`, `a=Text("")`],
    [`$/notes=''`, `$/notes=""`],
    [`a=Callout('y' , 'risk')`, `a=Callout("y" , "risk")`],
    [`$/plan=[{title:'A'},{title:'B'}]`, `$/plan=[{title:"A"},{title:"B"}]`],
    // apostrophes: a ' closes the string only before , ) ] } : = ; or the end of the line
    [`a=Text('doesn't matter')`, `a=Text("doesn't matter")`],
    [`a=Text('it's', 'lead')`, `a=Text("it's", "lead")`],
    [`$/plan=[{title:'B',note:'it's'}]`, `$/plan=[{title:"B",note:"it's"}]`],
    // nested quotes
    [`a=Text('say "hi"')`, `a=Text("say \\"hi\\"")`],
    [`a=Text("it's 'fine'")`, `a=Text("it's 'fine'")`],
    // escapes: \' is an apostrophe, everything else is copied as written
    [`a=Text('escaped \\' quote')`, `a=Text("escaped ' quote")`],
    [`a=Text('tab\\there')`, `a=Text("tab\\there")`],
    [`a=Text('ends with backslash\\\\')`, `a=Text("ends with backslash\\\\")`],
    // a raw newline inside a string becomes \n
    [`a=Text('line one\nline two')`, `a=Text("line one\\nline two")`],
    // comments are copied unchanged, quotes and all; comment markers inside strings are text
    [`a=Text('x') # it's a comment\nb=Text('y')`, `a=Text("x") # it's a comment\nb=Text("y")`],
    [`a=Text('x') // it's a comment\nb=Text('y')`, `a=Text("x") // it's a comment\nb=Text("y")`],
    [`a=Text('http://x.y/z#frag')`, `a=Text("http://x.y/z#frag")`],
    // statements on one line
    [`a=Text('a');b=Text('c')`, `a=Text("a");b=Text("c")`],
    // an unterminated string is closed at the end of the input, so the compiler reports the real problem
    [`a=Text('unterminated`, `a=Text("unterminated"`],
  ])('%j', (source, expected) => {
    expect(normalizeSpec(source)).toBe(expected);
  });

  // F054: Text('abc'.repeat(10)) rendered the text  abc'.repeat(10))])  with only a "fixed end of input" note,
  // because the quote after abc was read as an apostrophe and the string ran to the end of the input.
  it.each([
    // a ' followed by code, in a string that never closes, was the closing quote: the code after it stays code
    [`root=Page('U',[Text('abc'.repeat(10))])`, `root=Page("U",[Text("abc".repeat(10))])`],
    [`a=Text('abc' + name)`, `a=Text("abc" + name)`],
    [`a=Text('it's 'quoted'.trim())`, `a=Text("it's 'quoted".trim())`],
    // output cut short is still one string, apostrophes and all: nothing after them looks like code
    [`a=Text('don't stop`, `a=Text("don't stop"`],
    [`a=Text('It's a call to foo(bar) and`, `a=Text("It's a call to foo(bar) and"`],
    [`a=Text('the users' data (all of it`, `a=Text("the users' data (all of it"`],
    // a string that does close is never second-guessed
    [`a=Text('5' 6" boards (pine)')`, `a=Text("5' 6\\" boards (pine)")`],
  ])('an unterminated string: %j', (source, expected) => {
    expect(normalizeSpec(source)).toBe(expected);
  });

  it('after the fix the compiler reports the stray code instead of rendering it', () => {
    expect(() => compileExpress('s', `root=Page('U',[Text('abc'.repeat(10))])`)).toThrow();
  });

  it('leaves text without single quotes untouched and is idempotent', () => {
    const source = `root=Page("T",[a])\na=Stat(12,"files",delta=3)`;
    expect(normalizeSpec(source)).toBe(source);
    const quoted = `root=Page('It's here',[Text('say "hi"')])`;
    expect(normalizeSpec(normalizeSpec(quoted))).toBe(normalizeSpec(quoted));
  });

  it('the compiler receives the normalized text: apostrophes and nested quotes survive into the wire message', () => {
    const [message] = compileExpress('s', `root=Page('It's here',[Text('say "hi"')])`);
    const components = message && 'createSurface' in message ? message.createSurface.components : [];
    expect(components.find(c => c.id === 'root')).toMatchObject({title: "It's here"});
    expect(components.find(c => c.component === 'Text')).toMatchObject({text: 'say "hi"'});
  });
});

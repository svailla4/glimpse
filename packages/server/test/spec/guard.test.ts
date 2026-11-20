// Decision D10 and blocker F047: nothing a spec says may reach Object.prototype. The attack was
//   $/__proto__/GLIMPSE_EDITOR='/bin/sh -c ...'
// which the Express compiler's path setter wrote into Object.prototype while compiling: every later JSON-RPC message
// then failed validation (a hung server) and the editor command came from the polluted prototype.
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {compileSpec, loadToolchain, type Toolchain} from '../../src/spec/compile.ts';
import {SpecError} from '../../src/spec/errors.ts';
import {pathProblem, restoreBuiltins, scanSpec, stringValue, tokenize, unsafeKey, unsafeSegment, valueProblem} from '../../src/spec/guard.ts';
import {normalizeSpec} from '../../src/spec/normalize.ts';

let tools: Toolchain;
beforeAll(async () => {
  tools = await loadToolchain();
});
const compile = (source: string) => compileSpec(tools, {surfaceId: 's', sources: [source], surfaces: []});
const polluted = () => Object.keys(Object.prototype).concat(Object.getOwnPropertyNames(Object.prototype).filter(name => !BASELINE.has(name)));
const BASELINE = new Set(Object.getOwnPropertyNames(Object.prototype));

afterEach(() => {
  // Whatever a test did, the next one starts clean; a non-empty answer here is a failure of the guard itself.
  expect(restoreBuiltins()).toEqual([]);
});

describe('reserved names never reach the compiler', () => {
  it.each([
    [`root=Page('x',[])\n$/__proto__/GLIMPSE_EDITOR='/bin/sh -c id'`, '__proto__', 'data path segment'],
    [`root=Page('x',[])\n$/__proto__/polluted='yes'`, '__proto__', 'data path segment'],
    [`root=Page('x',[])\n$/a/__proto__/b=1`, '__proto__', 'data path segment'],
    [`root=Page('x',[])\n$__proto__/b=1`, '__proto__', 'data path segment'],
    [`root=Page('x',[])\n$/constructor/prototype/polluted=1`, 'constructor', 'data path segment'],
    [`root=Page('x',[])\n$/a/prototype/b=1`, 'prototype', 'data path segment'],
    [`root=Page('x',[Text($/__proto__/toString)])`, '__proto__', 'data path segment'],
    [`root=Page('x',[])\n$/a={"__proto__":{"polluted":1}}`, '__proto__', 'data key'],
    [`root=Page('x',[])\n$/a={__proto__:{polluted:1}}`, '__proto__', 'data key'],
    [`root=Page('x',[])\n$/a=[{ok:1},{'constructor':{prototype:{polluted:1}}}]`, 'constructor', 'data key'],
  ])('%s is refused with E_PATH', (spec, name, what) => {
    let thrown: unknown;
    try {
      compile(spec);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SpecError);
    expect((thrown as SpecError).problems).toEqual([{code: 'E_PATH', message: `"${name}" cannot be used as a ${what}: __proto__, constructor and prototype are reserved. Rename it.`}]);
    expect(polluted()).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).GLIMPSE_EDITOR).toBeUndefined();
  });

  it('the next call compiles as if nothing had happened', () => {
    expect(() => compile(`root=Page('x',[])\n$/__proto__/polluted='yes'`)).toThrow(/^E_PATH/);
    expect(compile(`root=Page('x',[Text('fine')])\n$/notes='ok'`).messages).toHaveLength(1);
  });

  it('prose may mention the names: only paths and keys are judged', () => {
    const {messages} = compile(`root=Page('About __proto__',[Text('constructor and prototype are words'),Text($/notes)])\n$/notes='see $/__proto__/x and {__proto__: 1}'\n$/proto={kind:'prototype',label:'constructor'}`);
    expect(JSON.stringify(messages)).toContain('constructor and prototype are words');
    expect(scanSpec(normalizeSpec(`$/a='__proto__'\n$/b=['constructor','prototype']`))).toBeUndefined();
  });
});

describe('the backstop', () => {
  it('restoreBuiltins removes what was added and puts back what was replaced', () => {
    const original = Object.prototype.toString;
    try {
      (Object.prototype as Record<string, unknown>).polluted = 'yes';
      (Array.prototype as unknown as Record<string, unknown>).extra = 1;
      Object.prototype.toString = () => 'hijacked';
      expect(restoreBuiltins().sort()).toEqual(['Array.prototype.extra', 'Object.prototype.polluted', 'Object.prototype.toString']);
    } finally {
      delete (Object.prototype as Record<string, unknown>).polluted;
      delete (Array.prototype as unknown as Record<string, unknown>).extra;
      Object.prototype.toString = original;
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.toString).toBe(original);
    expect(restoreBuiltins()).toEqual([]);
  });

  it('a compiler that pollutes anyway fails the call with E_PATH and leaves nothing behind', () => {
    // A stand-in for a path form the scan does not know: the "compiler" writes to the prototype directly.
    const hostile: Toolchain = {
      newTwin: () => () => {
        (Object.prototype as Record<string, unknown>).GLIMPSE_EDITOR = '/bin/sh -c id';
        return [];
      },
    };
    expect(() => compileSpec(hostile, {surfaceId: 's', sources: [`root=Page('x',[])`], surfaces: []})).toThrow(/^E_PATH the spec reached Object\.prototype\.GLIMPSE_EDITOR/);
    expect(({} as Record<string, unknown>).GLIMPSE_EDITOR).toBeUndefined();
  });

  it('compiled messages are checked again: a reserved key in a value or a path is refused', () => {
    const withKey = JSON.parse('{"version":"1.0","updateDataModel":{"surfaceId":"s","path":"/a","value":{"x":[{"__proto__":{"p":1}}]}}}');
    const withPath = {version: '1.0', updateDataModel: {surfaceId: 's', path: '/a/__proto__/b', value: 1}};
    for (const message of [withKey, withPath]) {
      const toolchain: Toolchain = {newTwin: () => () => [message as never]};
      expect(() => compileSpec(toolchain, {surfaceId: 's', seed: {components: [], data: {}}, sources: ['x=1'], surfaces: ['s']})).toThrow(/^E_PATH "__proto__" cannot be used/);
    }
  });
});

describe('guard helpers', () => {
  it('unsafeSegment and pathProblem read JSON pointers and $ paths', () => {
    expect(unsafeSegment('/a/b')).toBeUndefined();
    expect(unsafeSegment('/a/__proto__')).toBe('__proto__');
    expect(unsafeSegment('$/constructor')).toBe('constructor');
    expect(unsafeSegment('/a/proto~0type')).toBeUndefined();
    expect(pathProblem('/plan/0/status')).toBeUndefined();
    expect(pathProblem('/x/prototype')?.code).toBe('E_PATH');
  });

  it('unsafeKey finds an own key at any depth and survives cycles', () => {
    expect(unsafeKey({a: [{b: {c: 1}}]})).toBeUndefined();
    expect(unsafeKey(JSON.parse('{"a":[{"b":{"__proto__":{}}}]}'))).toBe('__proto__');
    expect(unsafeKey({a: {constructor: 1}})).toBe('constructor');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(unsafeKey(loop)).toBeUndefined();
    expect(valueProblem('constructor')).toBeUndefined();
    expect(valueProblem(null)).toBeUndefined();
  });

  it('tokenize keeps strings whole and drops comments', () => {
    const {tokens, endsInComment} = tokenize('a=Text("x # not ) a comment", r"raw\\d") // tail ( [\n$/p/q=-1.5 # end');
    expect(tokens.map(token => `${token.kind}:${token.text}`)).toEqual([
      'ident:a', 'punct:=', 'ident:Text', 'punct:(', 'string:"x # not ) a comment"', 'punct:,', 'string:r"raw\\d"', 'punct:)',
      'path:$/p/q', 'punct:=', 'number:-1.5',
    ]);
    expect(tokens.at(-1)!.line).toBe(2);
    expect(endsInComment).toBe(true);
    expect(stringValue(tokens[4]!)).toBe('x # not ) a comment');
    expect(stringValue(tokens[6]!)).toBe('raw\\d');
    expect(stringValue(tokenize('"say \\"hi\\""').tokens[0]!)).toBe('say "hi"');
  });
});

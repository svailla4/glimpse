// Decision what-if-as-a2ui-calls: the four functions add|sub|mul|div(a, b), and what the server and the Slider read about calls.
import {Catalog, ComponentContext, GenericBinder, MessageProcessor} from '@a2ui/web_core/v1_0';
import {describe, expect, it} from 'vitest';
import {
  CALC_ALIASES, CALC_NAMES, CATALOG_ID, COMPONENT_BY_NAME, COMPONENTS, applyCalc, calcApis, calcFunctions, calcName, callReads, callsIn, explainValue,
  inputValue, isCall, reads, type Call,
} from '../src/index.ts';
import {compileExpress} from '../testing/index.ts';

const at = (path: string): {'@path': string} => ({'@path': path});
const call = (name: string, a: unknown, b: unknown): Call => ({'@call': name, args: {a, b}});
/** A reader over a plain data model: '/w/seats' -> data.w.seats. */
const reader = (data: Record<string, unknown>) => (path: string) =>
  path.split('/').slice(1).reduce<unknown>((v, key) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[key] : undefined), data);

describe('applyCalc', () => {
  it.each([
    ['add', 2, 3, 5], ['sub', 2, 3, -1], ['mul', 2, 3, 6], ['div', 3, 2, 1.5], ['div', 0, 5, 0], ['mul', -2, 0.5, -1],
  ] as const)('%s(%s, %s) is %s', (name, a, b, value) => {
    expect(applyCalc(name, a, b)).toBe(value);
  });

  it.each([
    ['div', 1, 0, 'division by zero'], ['div', 0, 0, 'zero by zero'], ['add', Number.NaN, 1, 'NaN'], ['add', 1, '2', 'a string'],
    ['mul', '3', 2, 'a numeric string'], ['add', Number.POSITIVE_INFINITY, 1, 'Infinity'], ['sub', 1, Number.NEGATIVE_INFINITY, '-Infinity'],
    ['mul', 1e308, 10, 'an overflow'], ['add', null, 1, 'null'], ['add', undefined, 1, 'undefined'], ['pow', 2, 3, 'an unknown name'],
    ['toString', 1, 2, 'an inherited name'],
  ] as ReadonlyArray<readonly [string, unknown, unknown, string]>)('%s(%s, %s) has no value: %s', (name, a, b) => {
    expect(applyCalc(name, a, b)).toBeUndefined();
  });
});

describe('calcName', () => {
  it('reads the four names in any case, and the aliases; nothing else', () => {
    for (const name of CALC_NAMES) expect(calcName(name)).toBe(name);
    expect(calcName('Div')).toBe('div');
    expect(calcName(' MUL ')).toBe('mul');
    expect(Object.fromEntries(Object.keys(CALC_ALIASES).map(alias => [alias, calcName(alias)]))).toEqual({
      plus: 'add', sum: 'add', minus: 'sub', subtract: 'sub', times: 'mul', multiply: 'mul', product: 'mul', divide: 'div', quotient: 'div',
    });
    expect(calcName('Multiply')).toBe('mul');
    for (const other of ['pow', 'mod', 'mult', 'round', '', 'constructor', 'toString']) expect(calcName(other), other).toBeUndefined();
    expect(calcName(3)).toBeUndefined();
  });

  it('no alias is one of the names, and every alias is lower case', () => {
    for (const [alias, name] of Object.entries(CALC_ALIASES)) {
      expect(alias).toBe(alias.toLowerCase());
      expect(CALC_NAMES as readonly string[]).not.toContain(alias);
      expect(CALC_NAMES).toContain(name);
    }
  });
});

describe('explainValue', () => {
  const w = reader({w: {seats: 50000, conv: 0.6, secs: 120, zero: 0, text: '50k', big: 1e308, list: [1, 2], long: 'x'.repeat(60)}});

  it('computes nested calls from numbers and absolute $/paths', () => {
    expect(explainValue(call('div', call('mul', at('/w/seats'), at('/w/conv')), at('/w/secs')), w)).toEqual({value: 250});
    expect(explainValue(call('sub', 10, call('add', 1, 2)), w)).toEqual({value: 7});
  });

  it('gives a value that is not a call as it is, and a binding its data', () => {
    expect(explainValue(42, w)).toEqual({value: 42});
    expect(explainValue('text', w)).toEqual({value: 'text'});
    expect(explainValue(at('/w/seats'), w)).toEqual({value: 50000});
    expect(explainValue(at('/w/none'), w)).toEqual({value: undefined});
  });

  it('says why a call has no value, naming the operand and its path', () => {
    expect(explainValue(call('div', at('/w/seats'), at('/w/zero')), w)).toEqual({problem: 'div: b = $/w/zero is 0 (division by zero)', reason: 'division by zero'});
    expect(explainValue(call('div', 1, 0), w)).toEqual({problem: 'div: b is 0 (division by zero)', reason: 'division by zero'});
    expect(explainValue(call('mul', at('/w/text'), 2), w)).toEqual({problem: 'mul: a = $/w/text is "50k", not a number', reason: 'not a number'});
    expect(explainValue(call('mul', 2, at('/w/list')), w)).toEqual({problem: 'mul: b = $/w/list is [1,2], not a number', reason: 'not a number'});
    expect(explainValue(call('add', 'two', 2), w)).toEqual({problem: 'add: a is "two", not a number', reason: 'not a number'});
    expect(explainValue(call('add', Number.NaN, 2), w)).toEqual({problem: 'add: a is NaN, not a number', reason: 'not a number'});
    expect(explainValue(call('add', at('/w/long'), 2), w)).toEqual({problem: `add: a = $/w/long is "${'x'.repeat(38)}…, not a number`, reason: 'not a number'});
    expect(explainValue(call('add', at('/w/none'), 2), w)).toEqual({problem: 'add: a = $/w/none is not set', reason: 'not set'});
    expect(explainValue({'@call': 'add', args: {a: 1}}, w)).toEqual({problem: 'add: b is not set', reason: 'not set'});
    expect(explainValue({'@call': 'add'}, w)).toEqual({problem: 'add: a is not set', reason: 'not set'});
    expect(explainValue(call('mul', at('/w/big'), 10), w)).toEqual({problem: 'mul: the result is too large', reason: 'too large'});
    expect(explainValue(call('pow', 2, 3), w)).toEqual({problem: 'pow is not a function (add sub mul div)', reason: 'unknown'});
  });

  it('a relative path is not read, and says to write an absolute one', () => {
    // review S6: a reason of its own, so calcNotes says it (no unbound line names a relative path)
    expect(explainValue(call('mul', at('w/seats'), 2), w)).toEqual({problem: 'mul: a = $w/seats is relative; write an absolute $/path', reason: 'relative'});
    expect(explainValue(call('add', 1, call('div', 4, at('n'))), w)).toEqual({problem: 'div: b = $n is relative; write an absolute $/path', reason: 'relative'});
    expect(explainValue(at('seats'), w)).toEqual({problem: '$seats is relative; write an absolute $/path', reason: 'relative'});
  });

  it('the innermost reason wins: a named call copied into mul(rps,4) says division by zero, not "not a number"', () => {
    const rps = call('div', call('mul', at('/w/seats'), at('/w/conv')), at('/w/zero'));
    expect(explainValue(call('mul', rps, 4), w)).toEqual({problem: 'div: b = $/w/zero is 0 (division by zero)', reason: 'division by zero'});
    // the first operand is explained first
    expect(explainValue(call('add', call('pow', 1, 2), at('/w/text')), w)).toMatchObject({reason: 'unknown'});
  });
});

describe('callsIn', () => {
  it('finds the outermost calls of a prop and of inline rows, with where each is', () => {
    const rps = call('div', call('mul', at('/w/seats'), 0.6), 120);
    const stats = {id: 'peak', component: 'Stats', data: [{label: 'Peak', value: rps}, {label: 'Redis', value: call('mul', rps, 4), unit: 'ops/s'}], title: 'Load'};
    expect(callsIn(stats)).toEqual([{at: 'data/0/value', call: rps}, {at: 'data/1/value', call: call('mul', rps, 4)}]);
    expect(callsIn({id: 's', component: 'Stat', value: rps, label: 'x'})).toEqual([{at: 'value', call: rps}]);
    expect(callsIn({id: 's', component: 'Stat', value: 3, nested: {deep: {v: rps}}})).toEqual([{at: 'nested/deep/v', call: rps}]);
  });

  it('never looks into a binding, and skips id and component', () => {
    expect(callsIn({id: 's', component: 'Slider', value: at('/w/seats'), label: 'Seats'})).toEqual([]);
    expect(callsIn({value: {'@path': '/w', extra: call('add', 1, 2)}})).toEqual([]);
    expect(callsIn({id: call('add', 1, 2) as never, component: 'Stat'})).toEqual([]);
  });

  it('isCall tells a call from a binding and from data', () => {
    expect(isCall(call('add', 1, 2))).toBe(true);
    expect(isCall({'@call': 'add'})).toBe(true);
    for (const other of [at('/w'), {'@call': 3}, null, 'add(1,2)', [call('add', 1, 2)]]) expect(isCall(other)).toBe(false);
  });
});

describe('callReads and reads', () => {
  const rps = call('div', call('mul', at('/w/seats'), at('/w/conv')), at('/w/secs'));

  it('lists the absolute paths a call reads, through nested calls', () => {
    expect([...callReads(rps)]).toEqual(['/w/seats', '/w/conv', '/w/secs']);
    expect([...callReads(call('add', at('rel'), 1))]).toEqual([]);
    expect([...callReads(call('add', at('/a'), at('/a')))]).toEqual(['/a']);
  });

  it('a write reaches a call when one path holds the other, either way', () => {
    expect(reads(rps, '/w/seats')).toBe(true);
    expect(reads(rps, '/w')).toBe(true); // a write to the enclosing object
    expect(reads(call('add', at('/w'), 1), '/w/seats')).toBe(true); // a write inside what the call reads
    expect(reads(rps, '/w/sea')).toBe(false); // a prefix of a name is not a path around it
    expect(reads(rps, '/x')).toBe(false);
  });
});

describe('inputValue', () => {
  it('holds a finite number to the limits that are finite numbers', () => {
    expect(inputValue(80000, {min: 1000, max: 200000})).toBe(80000);
    expect(inputValue(5, {min: 1000, max: 200000})).toBe(1000);
    expect(inputValue(1e9, {min: 1000, max: 200000})).toBe(200000);
    expect(inputValue(-3, {})).toBe(-3);
    expect(inputValue(-3, {min: 0})).toBe(0);
    expect(inputValue(7, {min: '5', max: Number.NaN})).toBe(7);
    expect(inputValue(7, {max: Number.POSITIVE_INFINITY})).toBe(7);
  });

  it('is undefined for anything that is not a finite number', () => {
    for (const v of ['80000', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {value: 1}]) expect(inputValue(v, {min: 0, max: 10}), String(v)).toBeUndefined();
  });
});

describe('the two schemas', () => {
  it('name the same four functions', () => {
    expect(calcApis().map(f => f.name)).toEqual([...CALC_NAMES]);
    expect(calcFunctions().map(f => f.name)).toEqual([...CALC_NAMES]);
    for (const f of [...calcApis(), ...calcFunctions()]) expect(f.returnType).toBe('number');
  });

  it('strict (catalog.json and the compiler): numbers, bindings and calls, a and b both, nothing else', () => {
    for (const api of calcApis()) {
      expect(api.schema.safeParse({a: 1, b: 2.5}).success, api.name).toBe(true);
      expect(api.schema.safeParse({a: at('/w/seats'), b: call('mul', 1, 2)}).success).toBe(true);
      expect(api.schema.safeParse({a: 'x', b: 2}).success).toBe(false);
      expect(api.schema.safeParse({a: 1, b: 2, c: 3}).success).toBe(false);
      expect(api.schema.safeParse({a: 1}).success).toBe(false);
    }
  });

  it('permissive (the tab): any value is accepted, and one that is not a number gives no value', () => {
    for (const fn of calcFunctions()) {
      expect(fn.schema.safeParse({a: 'x', b: null}).success, fn.name).toBe(true);
      expect(fn.schema.safeParse({}).success).toBe(true);
      expect(fn.execute({a: '6', b: 3}, undefined as never)).toBeUndefined();
    }
    const [add, sub, mul, div] = calcFunctions();
    expect([add!, sub!, mul!, div!].map(fn => fn.execute({a: 6, b: 3}, undefined as never))).toEqual([9, 3, 18, 2]);
    expect(div!.execute({a: 6, b: 0}, undefined as never)).toBeUndefined();
  });

  // What the tab does with them, through A2UI itself (the viewer builds its catalog the same way): a Stat whose value
  // is a call recomputes when a Slider's setter writes the path, and a value the call cannot use gives no value and
  // no EXPRESSION_ERROR.
  it('in an A2UI surface, a call recomputes when the Slider writes its path, and never raises an error', () => {
    const catalog = new Catalog(CATALOG_ID, '1.0', COMPONENTS.map(c => ({name: c.name, schema: c.schema})), calcFunctions());
    const processor = new MessageProcessor([catalog]);
    const errors: string[] = [];
    processor.model.onError.subscribe((e: {code: string}) => void errors.push(e.code));
    const spec = "$/w={seats:50000,conv:0.6,secs:120}\nroot=Page('T',[s,r])\ns=Slider('Seats',$/w/seats,1000,200000)\nr=Stat(div(mul($/w/seats,$/w/conv),$/w/secs),'req/s')";
    expect(processor.processMessagesWithErrors(compileExpress('t', spec) as never)).toEqual([]);
    const surface = processor.getSurface('t')!;
    const binder = (id: string, name: string) => new GenericBinder(new ComponentContext(surface, id), COMPONENT_BY_NAME.get(name)!.schema);
    const slider = binder('s', 'Slider');
    const stat = binder('r', 'Stat');
    slider.subscribe(() => {});
    stat.subscribe(() => {});
    expect((stat.snapshot as {value: unknown}).value).toBe(250);
    (slider.snapshot as unknown as {setValue: (n: number) => void}).setValue(80000);
    expect(surface.dataModel.get('/w/seats')).toBe(80000);
    expect((stat.snapshot as {value: unknown}).value).toBe(400);
    surface.dataModel.set('/w/secs', 0);
    expect((stat.snapshot as {value: unknown}).value).toBeUndefined();
    surface.dataModel.set('/w/secs', '2 min');
    expect((stat.snapshot as {value: unknown}).value).toBeUndefined();
    surface.dataModel.set('/w/secs', 60);
    expect((stat.snapshot as {value: unknown}).value).toBe(800);
    expect(errors).toEqual([]);
  });
});

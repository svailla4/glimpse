import {describe, expect, it} from 'vitest';
import {FIELD_KINDS, readColumns} from '../src/index.ts';

describe('readColumns: the shorthand string the presets use', () => {
  it.each([
    ['path', [{key: 'path'}]],
    ['path commits:bar', [{key: 'path'}, {key: 'commits', kind: 'bar'}]],
    ['last:date=Last_change', [{key: 'last', kind: 'date', label: 'Last change'}]],
    ['owner=Main_owner', [{key: 'owner', label: 'Main owner'}]],
    ['  a   b:num  ', [{key: 'a'}, {key: 'b', kind: 'num'}]],
    ['from to weight:bar', [{key: 'from'}, {key: 'to'}, {key: 'weight', kind: 'bar'}]],
    ['ratio:pct=a=b', [{key: 'ratio', kind: 'pct', label: 'a=b'}]],
    ['', []],
  ])('%j', (spec, fields) => {
    expect(readColumns(spec)).toEqual({fields, problems: []});
  });

  it('accepts every field kind', () => {
    expect(FIELD_KINDS).toHaveLength(19);
    const read = readColumns(FIELD_KINDS.map(kind => `f_${kind}:${kind}`).join(' '));
    expect(read.fields.map(field => field.kind)).toEqual([...FIELD_KINDS]);
    expect(read.problems).toEqual([]);
  });

  it('never throws: an unknown kind draws without it, a token with no key is left out, and both are named', () => {
    expect(readColumns('path commits:sparkle=Commits :bar')).toEqual({
      fields: [{key: 'path'}, {key: 'commits', label: 'Commits'}],
      problems: [
        {column: 2, type: 'kind', message: expect.stringContaining('unknown kind "sparkle" for column "commits". Kinds: text num bytes')},
        {column: 3, type: 'dropped', message: '":bar" has no field name'},
      ],
    });
  });
});

describe('readColumns: the list (the documented form)', () => {
  it('reads keys, kinds and labels; a bare string is a key; field/name and title are read too', () => {
    expect(readColumns(['path', {key: 'commits', kind: 'bar'}, {field: 'last', kind: 'date', label: 'Last change'}, {name: 'owner', title: 'Main owner'}])).toEqual({
      fields: [{key: 'path'}, {key: 'commits', kind: 'bar'}, {key: 'last', kind: 'date', label: 'Last change'}, {key: 'owner', label: 'Main owner'}],
      problems: [],
    });
    // a label is written as it reads: no underscores needed
    expect(readColumns([{key: 'a', label: 'two words_kept'}]).fields).toEqual([{key: 'a', label: 'two words_kept'}]);
  });

  it('judges each entry on its own and names what it cannot read', () => {
    expect(readColumns(['path', {key: 'n', kind: 'sparkle'}, {kind: 'bar'}, 42, {key: 'c', width: 80, color: 'red'}])).toEqual({
      fields: [{key: 'path'}, {key: 'n'}, {key: 'c'}],
      problems: [
        {column: 2, type: 'kind', message: expect.stringMatching(/^unknown kind "sparkle" for column "n"\. Kinds: text num/)},
        {column: 3, type: 'dropped', message: "no key: expected 'key' or {key, kind?, label?}"},
        {column: 4, type: 'dropped', message: "expected 'key' or {key, kind?, label?}, received a number"},
        {column: 5, type: 'ignored', message: 'ignored keys width, color of column "c"'},
      ],
    });
  });

  it('refuses a value that is neither a list nor a string, and reads nothing from it', () => {
    expect(readColumns({path: true})).toEqual({fields: [], problems: [{column: 0, type: 'shape', message: "expected a list ['key' or {key, kind?, label?}], received an object"}]});
    expect(readColumns(undefined)).toEqual({fields: [], problems: []});
  });
});

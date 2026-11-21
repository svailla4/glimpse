import {describe, expect, it} from 'vitest';
import {FIELD_KINDS, checkColumns, parseColumns} from '../src/index.ts';

describe('parseColumns', () => {
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
    expect(parseColumns(spec)).toEqual(fields);
    expect(checkColumns(spec)).toEqual([]);
  });

  it('accepts every field kind', () => {
    expect(FIELD_KINDS).toHaveLength(19);
    const spec = FIELD_KINDS.map(kind => `f_${kind}:${kind}`).join(' ');
    expect(parseColumns(spec).map(f => f.kind)).toEqual([...FIELD_KINDS]);
    expect(checkColumns(spec)).toEqual([]);
  });

  it('never throws: an unknown kind renders as text and checkColumns reports its position', () => {
    expect(parseColumns('path commits:sparkle=Commits :bar')).toEqual([{key: 'path'}, {key: 'commits', label: 'Commits'}]);
    expect(checkColumns('path commits:sparkle=Commits :bar')).toEqual([
      {statement: 2, message: expect.stringContaining('unknown kind "sparkle" for column "commits". Kinds: text num bytes')},
      {statement: 3, message: 'column ":bar" has no field name'},
    ]);
  });
});

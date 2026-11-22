import {describe, expect, it} from 'vitest';
import {readOptions} from '../src/index.ts';

describe('readOptions: Ask options (decision ask-options-carry-notes)', () => {
  it('reads labels and {label, note} in one list, in order', () => {
    expect(readOptions(['Redis', {label: 'In-memory', note: 'One instance only; counts reset on restart'}])).toEqual({
      options: [{label: 'Redis'}, {label: 'In-memory', note: 'One instance only; counts reset on restart'}],
      problems: [],
      renamed: [],
    });
  });

  it('reads a key the author plainly meant, and says which', () => {
    const read = readOptions([{title: 'Hold 24 h', description: 'The guest is sure of the nights'}]);
    expect(read.options).toEqual([{label: 'Hold 24 h', note: 'The guest is sure of the nights'}]);
    expect(read.renamed).toEqual([{option: 1, from: 'title', to: 'label'}, {option: 1, from: 'description', to: 'note'}]);
    expect(read.problems).toEqual([]);
  });

  it('leaves out an entry with no label, an empty one and a repeat, and names each', () => {
    const read = readOptions(['A', '', {note: 'why'}, 'A', 3]);
    expect(read.options).toEqual([{label: 'A'}]);
    expect(read.problems).toEqual([
      {option: 2, type: 'dropped', message: `expected 'label' or {label, note?}, received ""`},
      {option: 3, type: 'dropped', message: `no label: expected 'label' or {label, note?}`},
      {option: 4, type: 'dropped', message: '"A" repeats an earlier option'},
      {option: 5, type: 'dropped', message: `expected 'label' or {label, note?}, received number 3`},
    ]);
  });

  it('says what it did not read, and draws the rest', () => {
    const read = readOptions([{label: 'A', note: 'n', tone: 'primary', title: 'B'}]);
    expect(read.options).toEqual([{label: 'A', note: 'n'}]);
    expect(read.problems).toEqual([{option: 1, type: 'ignored', message: 'ignored keys tone, title of option "A"'}]);
  });

  it('refuses a value that is not a list, and reads nothing as nothing', () => {
    expect(readOptions('A, B').problems).toEqual([{option: 0, type: 'shape', message: `expected a list ['label' or {label, note?}], received "A, B"`}]);
    expect(readOptions(undefined)).toEqual({options: [], problems: [], renamed: []});
  });
});

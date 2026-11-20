import {describe, expect, it} from 'vitest';
import {FIELD_KINDS, GALLERY_ROOT, checkColumns, parseColumns, parseFlow, parseSequence, type FlowAst, type SeqAst} from '../src/index.ts';

function flow(src: string): FlowAst {
  const result = parseFlow(src);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.ast;
}
function seq(src: string): SeqAst {
  const result = parseSequence(src);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.ast;
}
const flowErrors = (src: string) => { const r = parseFlow(src); return r.ok ? [] : r.errors; };
const seqErrors = (src: string) => { const r = parseSequence(src); return r.ok ? [] : r.errors; };

describe('parseFlow', () => {
  it.each([
    ['A[Label]', {id: 'A', label: 'Label', shape: 'box'}],
    ['A{Is it?}', {id: 'A', label: 'Is it?', shape: 'diamond'}],
    ['A([Start])', {id: 'A', label: 'Start', shape: 'pill'}],
    ['A[(Postgres)]', {id: 'A', label: 'Postgres', shape: 'store'}],
    ['A((hub))', {id: 'A', label: 'hub', shape: 'circle'}],
    ['A', {id: 'A', label: 'A', shape: 'box'}],
    ['my_node2[x]', {id: 'my_node2', label: 'x', shape: 'box'}],
    ['A["a; b [c]"]', {id: 'A', label: 'a; b [c]', shape: 'box'}],
    ['A[ padded  ]', {id: 'A', label: 'padded', shape: 'box'}],
  ])('node %s', (src, node) => {
    expect(flow(src)).toEqual({nodes: [node], edges: []});
  });

  it.each([
    ['A --> B', {from: 'A', to: 'B'}],
    ['A-->B', {from: 'A', to: 'B'}],
    ['A -->|yes| B', {from: 'A', to: 'B', label: 'yes'}],
    ['A -- maybe later --> B', {from: 'A', to: 'B', label: 'maybe later'}],
    ['A -.-> B', {from: 'A', to: 'B', dashed: true}],
    ['A -.->|async| B', {from: 'A', to: 'B', label: 'async', dashed: true}],
    ['A -. async .-> B', {from: 'A', to: 'B', label: 'async', dashed: true}],
    ['A ==> B', {from: 'A', to: 'B'}],
    ['A --- B', {from: 'A', to: 'B'}],
  ])('edge %s', (src, edge) => {
    expect(flow(src).edges).toEqual([edge]);
  });

  it('parses the gallery flowchart', () => {
    expect(flow('Req[Request] --> RL{Over limit?}; RL -->|no| H[Handler]; RL -->|yes| E([429]); H --> DB[(Postgres)]; H -.-> C((cache))')).toEqual({
      nodes: [
        {id: 'Req', label: 'Request', shape: 'box'}, {id: 'RL', label: 'Over limit?', shape: 'diamond'}, {id: 'H', label: 'Handler', shape: 'box'},
        {id: 'E', label: '429', shape: 'pill'}, {id: 'DB', label: 'Postgres', shape: 'store'}, {id: 'C', label: 'cache', shape: 'circle'},
      ],
      edges: [
        {from: 'Req', to: 'RL'}, {from: 'RL', to: 'H', label: 'no'}, {from: 'RL', to: 'E', label: 'yes'}, {from: 'H', to: 'DB'},
        {from: 'H', to: 'C', dashed: true},
      ],
    });
  });

  it('chains edges in one statement and fans out with &', () => {
    expect(flow('A --> B --> C').edges).toEqual([{from: 'A', to: 'B'}, {from: 'B', to: 'C'}]);
    expect(flow('A & B --> C').edges).toEqual([{from: 'A', to: 'C'}, {from: 'B', to: 'C'}]);
  });

  it("a node's first shape and label win; a bare mention never overrides or blocks them", () => {
    expect(flow('A --> B; A[Start]; A{Other}; B([End])').nodes).toEqual([
      {id: 'A', label: 'Start', shape: 'box'}, {id: 'B', label: 'End', shape: 'pill'},
    ]);
  });

  it('splits on ; and newlines, and ignores blanks, %% comments, a Mermaid header and styling lines', () => {
    const ast = flow('flowchart TD\n\n%% a comment; with a semicolon\nA --> B;;\n  B --> C  \nclassDef hot fill:#f00\nstyle A fill:#fff\nsubgraph one\nend');
    expect(ast.nodes.map(n => n.id)).toEqual(['A', 'B', 'C']);
    expect(ast.edges).toHaveLength(2);
    expect(flow('graph LR; A --> B').edges).toEqual([{from: 'A', to: 'B'}]);
  });

  it.each([
    ['A --> ', [{statement: 1, message: 'expected a node id at column 6, found end of statement'}]],
    ['A --> B; B -> C', [{statement: 2, message: 'expected an arrow (-->, -->|label|, -- label -->, -.->) at column 3, found "-> C"'}]],
    ['A --> B\nC[open', [{statement: 2, message: 'unclosed "[" in node C (column 2)'}]],
    ['flowchart TD\n%% note\nA --> B\n--> C\nD --> 9', [
      {statement: 2, message: 'expected a node id at column 1, found "--> C"'},
      {statement: 3, message: 'expected a node id at column 7, found "9"'},
    ]],
    ['', [{statement: 1, message: 'no statements: expected something like "A[Start] --> B{Decision}"'}]],
  ])('reports errors by statement number for %j', (src, errors) => {
    expect(flowErrors(src)).toEqual(errors);
  });
});

describe('parseSequence', () => {
  it.each([
    ['A->>B: call', {kind: 'message', from: 'A', to: 'B', label: 'call', arrow: 'sync'}],
    ['A-->>B: reply', {kind: 'message', from: 'A', to: 'B', label: 'reply', arrow: 'reply'}],
    ['A-)B: fire', {kind: 'message', from: 'A', to: 'B', label: 'fire', arrow: 'async'}],
    ['A ->> B : spaced', {kind: 'message', from: 'A', to: 'B', label: 'spaced', arrow: 'sync'}],
    ['A->>A: retry', {kind: 'message', from: 'A', to: 'A', label: 'retry', arrow: 'sync'}],
    ['A->>B: GET /x?a=1: now', {kind: 'message', from: 'A', to: 'B', label: 'GET /x?a=1: now', arrow: 'sync'}],
    ['A->>+B: activate', {kind: 'message', from: 'A', to: 'B', label: 'activate', arrow: 'sync'}],
    ['auth-service->>db: query', {kind: 'message', from: 'auth-service', to: 'db', label: 'query', arrow: 'sync'}],
    ['A->>B', {kind: 'message', from: 'A', to: 'B', label: '', arrow: 'sync'}],
    ['API v2->>db 1: q', {kind: 'message', from: 'API v2', to: 'db 1', label: 'q', arrow: 'sync'}],
    ['A->B: plain', {kind: 'message', from: 'A', to: 'B', label: 'plain', arrow: 'sync'}],
    ['A-xB: lost', {kind: 'message', from: 'A', to: 'B', label: 'lost', arrow: 'sync'}],
    // a hyphen followed by x inside a name is not the lost-message arrow
    ['auth-xml->>db: parse', {kind: 'message', from: 'auth-xml', to: 'db', label: 'parse', arrow: 'sync'}],
    // arrows in the text belong to the text
    ['A->>B: map x -> y', {kind: 'message', from: 'A', to: 'B', label: 'map x -> y', arrow: 'sync'}],
  ])('message %s', (src, step) => {
    expect(seq(src).steps).toEqual([step]);
  });

  it('parses the gallery sequence: actors in order of first mention, notes over one or two actors', () => {
    const ast = seq('User->>API: POST /login; API->>Auth: verify(password); Auth->>DB: find user; DB-->>Auth: row; Note over Auth,DB: constant-time compare; Auth-->>API: token; API-->>User: 200');
    expect(ast.actors.map(a => a.id)).toEqual(['User', 'API', 'Auth', 'DB']);
    expect(ast.steps).toHaveLength(7);
    expect(ast.steps[4]).toEqual({kind: 'note', over: ['Auth', 'DB'], text: 'constant-time compare'});
    expect(seq('Note over A: alone').steps).toEqual([{kind: 'note', over: ['A'], text: 'alone'}]);
  });

  it('participant fixes order and label', () => {
    const ast = seq('sequenceDiagram\nparticipant DB as Postgres\nparticipant API\nUser->>API: hi\nAPI->>DB: q');
    expect(ast.actors).toEqual([{id: 'DB', label: 'Postgres'}, {id: 'API', label: 'API'}, {id: 'User', label: 'User'}]);
    // declared after first mention: the label changes, the position does not
    expect(seq('A->>B: x; participant B as Backend').actors).toEqual([{id: 'A', label: 'A'}, {id: 'B', label: 'Backend'}]);
  });

  it('ignores blanks, %% comments and Mermaid block keywords', () => {
    const ast = seq('%% comment\nautonumber\nloop every minute\nA->>B: ping;;\nend\nactivate B');
    expect(ast.steps).toEqual([{kind: 'message', from: 'A', to: 'B', label: 'ping', arrow: 'sync'}]);
  });

  it.each([
    ['A->>B: ok; this is not a message', [{statement: 2, message: 'expected "A->>B: text", "A-->>B: text", "A-)B: text", "Note over A: text" or "participant A", found "this is not a message"'}]],
    ['sequenceDiagram\n%% c\nA->>B: ok\n???\nB-->>A: ok\n!!!', [
      {statement: 2, message: expect.stringContaining('found "???"')},
      {statement: 4, message: expect.stringContaining('found "!!!"')},
    ]],
    ['Note over : nobody', [{statement: 1, message: expect.stringContaining('found "Note over : nobody"')}]],
    ['  ', [{statement: 1, message: 'no messages: expected something like "User->>API: POST /login"'}]],
    // an actor is required on both sides of the arrow (design 4.6): the arrow's own characters are never an actor
    ['A->>: x', [{statement: 1, message: 'a message needs an actor on both sides of the arrow: "A->>B: text", found "A->>: x"'}]],
    ['A->>B: ok; A-->>: x; A-): y; A->>', [
      {statement: 2, message: expect.stringContaining('found "A-->>: x"')},
      {statement: 3, message: expect.stringContaining('found "A-): y"')},
      {statement: 4, message: expect.stringContaining('found "A->>"')},
    ]],
    ['->>B: x', [{statement: 1, message: expect.stringContaining('found "->>B: x"')}]],
    ['A->>B->>C: x', [{statement: 1, message: expect.stringContaining('an actor on both sides of the arrow')}]],
    ['A->>B: ok; Note over >: x', [{statement: 2, message: 'a note needs actor names, found ">": "Note over A,B: text"'}]],
    ['participant ->>; A->>B: ok', [{statement: 1, message: expect.stringContaining('"->>" is not an actor name')}]],
  ])('reports errors by statement number for %j', (src, errors) => {
    expect(seqErrors(src)).toEqual(errors);
  });
});

describe('the gallery sources', () => {
  it('every Flowchart and SequenceDiagram literal in the gallery parses', () => {
    const flowSrc = /Flowchart\('([^']+)'/.exec(GALLERY_ROOT)![1]!;
    const seqSrc = /SequenceDiagram\('([^']+)'/.exec(GALLERY_ROOT)![1]!;
    expect(flow(flowSrc).nodes).toHaveLength(6);
    expect(seq(seqSrc).actors).toHaveLength(4);
  });
});

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

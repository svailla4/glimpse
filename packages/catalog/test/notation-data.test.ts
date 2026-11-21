// Data written as text: the notation parsers the server runs on a data prop's string (Graph, ERDiagram, the Rows
// components, List, Steps, KeyValue, Stats, Layers), the classifier and the per-prop dispatch.
import {describe, expect, it} from 'vitest';
import {
  COMPONENTS, NOTATIONS, looksLikeNotation, normalizeSpec, notationFor, notationKind, parseEr, parseGraph, parseKeyValue, parseLayers,
  parseMdTable, parseStats, parseTaskList, type NotationKind, type ParseResult,
} from '../src/index.ts';

function ok<T>(result: ParseResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.ast;
}
const errorsOf = (result: ParseResult<unknown>) => (result.ok ? [] : result.errors.map(({line, col, message, example}) => ({line, col, message, example})));
const fixesOf = (result: ParseResult<unknown>) => (result.ok ? result.fixes ?? [] : `failed: ${JSON.stringify(result.errors)}`);
const err = (line: number, col: number, message: string, example: string) => ({line, col, message, example});

// ---------------------------------------------------------------- graph
describe('parseGraph', () => {
  it.each([
    ['graph LR\na[API] --> b[DB]', {nodes: [{id: 'a', label: 'API'}, {id: 'b', label: 'DB'}], edges: [{from: 'a', to: 'b'}]}, 'LR'],
    ['a --> b', {nodes: [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}], edges: [{from: 'a', to: 'b'}]}, undefined],
    ['flowchart TD\na[API<br>express routes]', {nodes: [{id: 'a', label: 'API', sub: 'express routes'}], edges: []}, 'TB'],
    ['graph BT; a["x [y]"]:::new', {nodes: [{id: 'a', label: 'x [y]', status: 'added'}], edges: []}, 'TB'],
    ['graph RL\na -->|calls| b', {nodes: [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}], edges: [{from: 'a', to: 'b', label: 'calls'}]}, 'LR'],
    ['GRAPH tb\na -- calls --> b', {nodes: [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}], edges: [{from: 'a', to: 'b', label: 'calls'}]}, 'TB'],
    ['a & b --> c --> d', {
      nodes: ['a', 'b', 'c', 'd'].map(id => ({id, label: id})),
      edges: [{from: 'a', to: 'c'}, {from: 'b', to: 'c'}, {from: 'c', to: 'd'}],
    }, undefined],
    ['subgraph api[API]\nr --> s\nend', {
      nodes: [{id: 'r', label: 'r', group: 'api'}, {id: 's', label: 's', group: 'api'}], edges: [{from: 'r', to: 's'}], groups: [{id: 'api', label: 'API'}],
    }, undefined],
    ['subgraph outer\nsubgraph inner\nx\nend\nend', {
      nodes: [{id: 'x', label: 'x', group: 'inner'}], edges: [], groups: [{id: 'outer', label: 'outer'}, {id: 'inner', label: 'inner', parent: 'outer'}],
    }, undefined],
    ['a --> b\nclass a,b changed', {nodes: [{id: 'a', label: 'a', status: 'modified'}, {id: 'b', label: 'b', status: 'modified'}], edges: [{from: 'a', to: 'b'}]}, undefined],
    ['a\nclick a "src/a.ts#L3-9"', {nodes: [{id: 'a', label: 'a', file: 'src/a.ts#L3-9'}], edges: []}, undefined],
    ['Enter credentials --> Valid?', {nodes: [{id: 'Enter_credentials', label: 'Enter credentials'}, {id: 'Valid', label: 'Valid?'}], edges: [{from: 'Enter_credentials', to: 'Valid'}]}, undefined],
  ])('%j', (src, data, dir) => {
    const result = parseGraph(src);
    expect(ok(result)).toEqual(data);
    expect(result.ok && result.dir).toBe(dir ?? undefined);
    expect(fixesOf(result)).toEqual([]);
  });

  it.each([
    ['a -.->|retry| b', {from: 'a', to: 'b', label: 'retry', kind: 'dashed'}],
    ['a -.- b', {from: 'a', to: 'b', kind: 'dashed'}],
    ['a -. later .-> b', {from: 'a', to: 'b', label: 'later', kind: 'dashed'}],
    ['a -.-> b', {from: 'a', to: 'b', kind: 'dashed'}],
    ['a ==> b', {from: 'a', to: 'b'}],
    ['a == heavy ==> b', {from: 'a', to: 'b', label: 'heavy'}],
    ['a --- b', {from: 'a', to: 'b'}],
    ['a ---> b', {from: 'a', to: 'b'}],
    ['a -->|"quoted; label"| b', {from: 'a', to: 'b', label: 'quoted; label'}],
  ])('edge %s', (src, edge) => {
    expect(ok(parseGraph(src)).edges).toEqual([edge]);
  });

  it('every shape draws the same node: the label is what is inside it', () => {
    const data = ok(parseGraph('a([pill]) --> b[(store)] --> c((circle)) --> d{diamond} --> e{{hex}} --> f(round) --> g[box]'));
    expect(data.nodes.map(n => n.label)).toEqual(['pill', 'store', 'circle', 'diamond', 'hex', 'round', 'box']);
    expect(data.nodes.every(n => !('kind' in n))).toBe(true);
  });

  it('the first explicit label wins; a bare mention keeps the id until a label is written', () => {
    expect(ok(parseGraph('a --> b\na[First]\na[Second]')).nodes).toEqual([{id: 'a', label: 'First'}, {id: 'b', label: 'b'}]);
  });

  it.each([
    ['a[x<br/>y]', {label: 'x', sub: 'y'}],
    ['a[x<BR />y]', {label: 'x', sub: 'y'}],
    ['a[x <br> y <br> z]', {label: 'x', sub: 'y z'}],
    ['a[x<br>]', {label: 'x'}],
    ['a[<br>only sub]', {label: 'a', sub: 'only sub'}],
  ])('<br> splits label and sub: %s', (src, parts) => {
    expect(ok(parseGraph(src)).nodes).toEqual([{id: 'a', ...parts}]);
  });

  describe('groups', () => {
    it('nodes declared in blocks and wired after the blocks keep their group', () => {
      const data = ok(parseGraph('subgraph a[A]\nx[X]\nend\nsubgraph b[B]\ny[Y]\nend\nx --> y'));
      expect(data.nodes).toEqual([{id: 'x', label: 'X', group: 'a'}, {id: 'y', label: 'Y', group: 'b'}]);
      expect(data.groups).toEqual([{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]);
    });

    it('a mention outside every block does not count; a bare id listed alone in a block places it', () => {
      expect(ok(parseGraph('x --> y\nsubgraph g\nx\nend')).nodes).toEqual([{id: 'x', label: 'x', group: 'g'}, {id: 'y', label: 'y'}]);
    });

    it('the first block a node is mentioned in wins: a cross edge in a later block does not move it', () => {
      expect(ok(parseGraph('subgraph a\nx\nend\nsubgraph b\ny --> x\nend')).nodes).toEqual([{id: 'x', label: 'x', group: 'a'}, {id: 'y', label: 'y', group: 'b'}]);
    });

    it('a second block with the same id reopens the group', () => {
      const data = ok(parseGraph('subgraph g[G]\nx\nend\nsubgraph g\ny\nend'));
      expect(data.groups).toEqual([{id: 'g', label: 'G'}]);
      expect(data.nodes.map(n => n.group)).toEqual(['g', 'g']);
    });

    it.each([
      ['subgraph "Data layer"', {id: 'Data_layer', label: 'Data layer'}],
      ['subgraph Web tier', {id: 'Web_tier', label: 'Web tier'}],
      ['subgraph worker[worker (Go)]', {id: 'worker', label: 'worker (Go)'}],
      ['subgraph api ["API v2"]', {id: 'api', label: 'API v2'}],
      ['subgraph 3 workers', {id: 'n_3_workers', label: '3 workers'}],
      ['subgraph core-lib', {id: 'core-lib', label: 'core-lib'}],
    ])('%s', (head, group) => {
      const data = ok(parseGraph(`${head}\nx\nend`));
      expect(data.groups).toEqual([group]);
      expect(data.nodes).toEqual([{id: 'x', label: 'x', group: group.id}]);
    });

    it('direction inside a block is accepted and ignored', () => {
      expect(ok(parseGraph('subgraph g\ndirection LR\nx\nend')).nodes).toEqual([{id: 'x', label: 'x', group: 'g'}]);
    });
  });

  describe('status', () => {
    it.each([
      ['new', 'added'], ['added', 'added'], ['changed', 'modified'], ['modified', 'modified'],
      ['gone', 'deleted'], ['deleted', 'deleted'], ['removed', 'deleted'], ['affected', 'affected'], ['NEW', 'added'],
    ])(':::%s and class a %s give %s', (name, status) => {
      expect(ok(parseGraph(`a[A]:::${name}`)).nodes).toEqual([{id: 'a', label: 'A', status}]);
      expect(ok(parseGraph(`a:::${name}`)).nodes).toEqual([{id: 'a', label: 'a', status}]);
      expect(ok(parseGraph(`a\nclass a ${name}`)).nodes).toEqual([{id: 'a', label: 'a', status}]);
    });

    it('on a free-text node, in a chain, with spaces after the commas; the last one written wins', () => {
      expect(ok(parseGraph('Read config:::new --> b:::gone --> c')).nodes).toEqual([
        {id: 'Read_config', label: 'Read config', status: 'added'}, {id: 'b', label: 'b', status: 'deleted'}, {id: 'c', label: 'c'},
      ]);
      expect(ok(parseGraph('a & b\nclass a, b changed')).nodes.map(n => n.status)).toEqual(['modified', 'modified']);
      expect(ok(parseGraph('a:::new\nclass a gone')).nodes).toEqual([{id: 'a', label: 'a', status: 'deleted'}]);
      expect(ok(parseGraph('class a gone\na:::new')).nodes).toEqual([{id: 'a', label: 'a', status: 'added'}]);
    });
  });

  it.each([
    ['click a "src/a.ts#L3-9"', 'src/a.ts#L3-9'],
    ['click a href "src/a.ts"', 'src/a.ts'],
    ['click a src/a.ts', 'src/a.ts'],
    ['click a "src/a.ts#L10-20" "Open the handler"', 'src/a.ts#L10-20'],
    ['click a href "src/a.ts#L1" "tip" _blank', 'src/a.ts#L1'],
    ['click a README.md', 'README.md'],
  ])('%s', (click, file) => {
    expect(ok(parseGraph(`a --> b\n${click}`)).nodes[0]).toEqual({id: 'a', label: 'a', file});
  });

  it('a click before the node is declared still links it; the last click wins', () => {
    expect(ok(parseGraph('click a "x.ts"\na[A]\nclick a "y.ts"')).nodes).toEqual([{id: 'a', label: 'A', file: 'y.ts'}]);
  });

  it('ignores %% comments, blank lines and \\r\\n line breaks; lines count from 1 over the whole string', () => {
    expect(ok(parseGraph('\r\n%% a comment\r\ngraph LR\r\n\r\na --> b\r\n'))).toEqual({nodes: [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}], edges: [{from: 'a', to: 'b'}]});
    expect(errorsOf(parseGraph('%% c\n\na --> b\r\nc =>'))[0]).toMatchObject({line: 4, col: 3});
  });

  it.each([
    ['G1 at the end of a statement', 'a --> b\nc -->', [err(2, 6, 'expected a node id, found end of statement', 'a[Label] --> b[Label]')]],
    ['G1 after ; on the same line', 'a --> b; --> c', [err(1, 10, 'expected a node id, found "--> c"', 'a[Label] --> b[Label]')]],
    ['G2', 'a --> b\nC[open --> B', [err(2, 2, 'unclosed "[" in node C', 'C[open]')]],
    ['G2 at the end', '  x((hub', [err(1, 4, 'unclosed "((" in node x', 'x((hub))')]],
    ['G3 =>', 'a => b', [err(1, 3, 'expected an arrow (-->, -->|label|, -- label -->, -.->), found "=> b"', 'a --> b')]],
    ['G3 ->>', 'a ->> b', [err(1, 3, 'expected an arrow (-->, -->|label|, -- label -->, -.->), found "->> b"', 'a --> b')]],
    ['G3 ~>', 'a[A] ~> b', [err(1, 6, 'expected an arrow (-->, -->|label|, -- label -->, -.->), found "~> b"', 'a[A] --> b')]],
    ['G3 other', 'a[A] ~~ b', [err(1, 6, 'expected an arrow (-->, -->|label|, -- label -->, -.->), found "~~ b"', 'a -->|label| b')]],
    ['G4', 'web-app[Web] --> b', [err(1, 1, 'node ids are letters, digits and _: write web_app', 'web_app[Web] --> b')]],
    ['G4 later in a chain', 'a --> my-web-app[Web]', [err(1, 7, 'node ids are letters, digits and _: write my_web_app', 'a --> my_web_app[Web]')]],
    ['G5', 'a <--> b', [err(1, 3, '"<-->" is not an edge: write two, a --> b and b --> a', 'a --> b; b --> a')]],
    ['G5 named', 'api <--> db', [err(1, 5, '"<-->" is not an edge: write two, a --> b and b --> a', 'api --> db; db --> api')]],
    ['G6', 'a --> b\nend', [err(2, 1, '"end" closes no subgraph', 'subgraph g[Group]')]],
    ['G7', 'subgraph api[API]\napi --> b\nend', [err(1, 10, '"api" is a subgraph and a node: rename one', 'subgraph api_group[API]')]],
    ['G8', 'a --> b\nclick zz "src/a.ts"', [err(2, 7, 'click names no node "zz". Nodes: a b', 'click a "src/a.ts#L10-20"')]],
    ['G9', 'a\nclick a', [err(2, 1, 'click a needs a file in quotes', 'click a "src/a.ts#L10-20"')]],
    ['G9 empty', 'a\nclick a ""', [err(2, 1, 'click a needs a file in quotes', 'click a "src/a.ts#L10-20"')]],
    ['G10', 'a\nclick a "https://example.com/x"', [err(2, 1, 'click a links a URL: a node opens a file of this repository', 'click a "src/a.ts"')]],
    ['G11', 'a\nclass q new', [err(2, 7, 'class names no node "q". Nodes: a', 'class a new')]],
    ['G12', 'graph TD\n%% nothing yet', [err(1, 1, 'no nodes', 'a[API] --> b[DB]')]],
    ['several, sorted by line', 'a =>\nb ~> c\nend', [
      err(1, 3, 'expected an arrow (-->, -->|label|, -- label -->, -.->), found "=>"', 'a -->'),
      err(2, 3, 'expected an arrow (-->, -->|label|, -- label -->, -.->), found "~> c"', 'b --> c'),
      err(3, 1, '"end" closes no subgraph', 'subgraph g[Group]'),
    ]],
  ])('%s', (_name, src, errors) => {
    expect(errorsOf(parseGraph(src))).toEqual(errors);
  });

  it('a node list in G8 and G11 stops at 12 ids', () => {
    const src = Array.from({length: 14}, (_, i) => `n${i}`).join(' --> ') + '\nclick zz "a.ts"';
    expect(errorsOf(parseGraph(src))[0]!.message).toBe('click names no node "zz". Nodes: n0 n1 n2 n3 n4 n5 n6 n7 n8 n9 n10 n11');
  });

  it.each([
    ['GF1', 'a:::hot --> b', [{line: 1, message: "':::hot' dropped (status: new changed gone affected)"}], [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}]],
    ['GF1 class', 'a\nclass a hot', [{line: 2, message: "':::hot' dropped (status: new changed gone affected)"}], [{id: 'a', label: 'a'}]],
    ['GF2', 'a\nstyle a fill:#f00\nclassDef hot fill:#f00\nlinkStyle 0 stroke:#f00', [{line: 2, message: '3 style/classDef/linkStyle lines ignored (status: :::new :::changed :::gone)'}], [{id: 'a', label: 'a'}]],
    ['GF3', 'subgraph g\na', [{line: 1, message: 'subgraph g closed at the end'}], [{id: 'a', label: 'a', group: 'g'}]],
    ['GF4', 'a -> b', [{line: 1, message: "'->' read as '-->'"}], [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}]],
    ['GF4 free text', 'Read config -> Parse it', [{line: 1, message: "'->' read as '-->'"}], [{id: 'Read_config', label: 'Read config'}, {id: 'Parse_it', label: 'Parse it'}]],
    ['GF5', 'graph XY\na', [{line: 1, message: "direction 'XY' ignored (TD TB BT LR RL)"}], [{id: 'a', label: 'a'}]],
    ['GF6', 'a\nclick a callback', [{line: 2, message: 'click a callback ignored: give a file, click a "path"'}], [{id: 'a', label: 'a'}]],
    ['GF6 call', 'a\nclick a call doIt()', [{line: 2, message: 'click a call ignored: give a file, click a "path"'}], [{id: 'a', label: 'a'}]],
    ['aggregated', 'a -> b\nb -> c\nc -> d', [{line: 1, message: "'->' read as '-->' (+2 more lines)"}], ['a', 'b', 'c', 'd'].map(id => ({id, label: id}))],
    ['one per kind, by line', 'graph XY\na:::hot -> b:::cold', [
      {line: 1, message: "direction 'XY' ignored (TD TB BT LR RL)"}, {line: 2, message: "'->' read as '-->'"}, {line: 2, message: "':::hot' dropped (status: new changed gone affected)"},
    ], [{id: 'a', label: 'a'}, {id: 'b', label: 'b'}]],
  ])('%s', (_name, src, fixes, nodes) => {
    const result = parseGraph(src);
    expect(fixesOf(result)).toEqual(fixes);
    expect(ok(result).nodes).toEqual(nodes);
  });

  it('a single-dash arrow with a label is repaired too; Flowchart keeps reporting it', () => {
    expect(ok(parseGraph('a ->|x| b')).edges).toEqual([{from: 'a', to: 'b', label: 'x'}]);
  });

  it('a long fix is clipped to 80 characters', () => {
    const fixes = fixesOf(parseGraph(`a:::${'x'.repeat(30)}`)) as Array<{message: string}>;
    expect(fixes[0]!.message.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------- erDiagram
describe('parseEr', () => {
  it.each([
    ['erDiagram\nusers ||--o{ orders : places', {
      tables: [{name: 'users', columns: []}, {name: 'orders', columns: []}], relations: [{from: 'users', to: 'orders', card: '1-n', label: 'places'}],
    }],
    ['users {\nuuid id PK\ntext email UK "login"\n}', {tables: [{name: 'users', columns: [{name: 'id', type: 'uuid', pk: true}, {name: 'email', type: 'text'}]}]}],
    ['orders {\nuuid user_id FK\ndecimal(10,2) total\n}', {tables: [{name: 'orders', columns: [{name: 'user_id', type: 'uuid', fk: true}, {name: 'total', type: 'decimal(10,2)'}]}]}],
    ['a }o--o{ b : "tags"', {tables: [{name: 'a', columns: []}, {name: 'b', columns: []}], relations: [{from: 'a', to: 'b', card: 'n-n', label: 'tags'}]}],
    ['a |o..|| b', {tables: [{name: 'a', columns: []}, {name: 'b', columns: []}], relations: [{from: 'a', to: 'b', card: '1-1'}]}],
    ['users {\nuuid id PK\n}\nclick users "db/schema.sql#L10-40"', {tables: [{name: 'users', file: 'db/schema.sql#L10-40', columns: [{name: 'id', type: 'uuid', pk: true}]}]}],
    ['users { uuid id PK }', {tables: [{name: 'users', columns: [{name: 'id', type: 'uuid', pk: true}]}]}],
    ['users {}', {tables: [{name: 'users', columns: []}]}],
    ['users {\nint id PK,FK\nint b PK, FK\nstring[] tags\n}', {tables: [{name: 'users', columns: [
      {name: 'id', type: 'int', pk: true, fk: true}, {name: 'b', type: 'int', pk: true, fk: true}, {name: 'tags', type: 'string[]'},
    ]}]}],
    ['"order item" {\nint id PK\n}\n"order item" }o--|| users : in', {
      tables: [{name: 'order item', columns: [{name: 'id', type: 'int', pk: true}]}, {name: 'users', columns: []}],
      relations: [{from: 'order item', to: 'users', card: 'n-1', label: 'in'}],
    }],
    ['a {\nint x\n}\nb ||--|| a : has\na {\nint y\n}', {
      tables: [{name: 'a', columns: [{name: 'x', type: 'int'}, {name: 'y', type: 'int'}]}, {name: 'b', columns: []}], relations: [{from: 'b', to: 'a', card: '1-1', label: 'has'}],
    }],
    ['erDiagram\ntitle Orders\n%% comment\naccTitle: x\nusers ||--o{ orders: places', {
      tables: [{name: 'users', columns: []}, {name: 'orders', columns: []}], relations: [{from: 'users', to: 'orders', card: '1-n', label: 'places'}],
    }],
  ])('%j', (src, data) => {
    const result = parseEr(src);
    expect(ok(result)).toEqual(data);
    expect(fixesOf(result)).toEqual([]);
  });

  const LEFT = [['|o', '1'], ['||', '1'], ['}o', 'n'], ['}|', 'n']] as const;
  const RIGHT = [['o|', '1'], ['||', '1'], ['o{', 'n'], ['|{', 'n']] as const;
  it.each(LEFT.flatMap(([l, from]) => RIGHT.flatMap(([r, to]) => ['--', '..'].map(link => [`${l}${link}${r}`, `${from}-${to}`] as const))))('cardinality %s is %s', (card, expected) => {
    expect(ok(parseEr(`a ${card} b`)).relations).toEqual([{from: 'a', to: 'b', card: expected}]);
  });

  it('direction sets dir', () => {
    const result = parseEr('erDiagram\ndirection LR\na ||--|| b');
    expect(result.ok && result.dir).toBe('LR');
    expect(parseEr('a ||--|| b')).not.toHaveProperty('dir');
  });

  it.each([
    ['E1', 'foo bar', [err(1, 1, 'expected an entity "NAME {", a relationship "A ||--o{ B : label" or "}", found "foo bar"', 'users ||--o{ orders : places')]],
    ['E2', 'users |-o{ orders : places', [err(1, 7, 'unknown cardinality "|-o{": left |o || }o }|, right o| || o{ |{', 'users ||--o{ orders : places')]],
    ['E2 written backwards', 'a o{--|| b', [err(1, 3, 'unknown cardinality "o{--||": left |o || }o }|, right o| || o{ |{', 'a ||--o{ b')]],
    ['a brace after a name opens a block', 'a {o--|| b', [err(1, 1, 'expected a column "type name [PK|FK|UK]", found "o--|| b"', 'uuid id PK')]],
    ['E2 arrow', 'a ||-->o{ b', [err(1, 3, 'unknown cardinality "||-->o{": left |o || }o }|, right o| || o{ |{', 'a ||--o{ b')]],
    ['E3', 'users {\norders {\n}', [err(2, 1, 'expected a column "type name [PK|FK|UK]", found "orders {"', 'uuid id PK')]],
    ['E4', 'a ||--|| b\n}', [err(2, 1, '"}" closes no entity', 'users {')]],
    ['E5', 'erDiagram', [err(1, 1, 'no entities', 'users ||--o{ orders : places')]],
    ['E6', 'users {\nint id\n}\nclick nope "a.sql"', [err(4, 7, 'click names no entity "nope". Entities: users', 'click users "db/schema.sql"')]],
    ['click with a URL', 'users {}\nclick users "https://x.test/a"', [err(2, 1, 'click users links a URL: a node opens a file of this repository', 'click users "src/a.ts"')]],
  ])('%s', (_name, src, errors) => {
    expect(errorsOf(parseEr(src))).toEqual(errors);
  });

  it.each([
    ['EF1', 'users {\nuuid id', [{line: 1, message: 'users { closed at the end'}], [{name: 'users', columns: [{name: 'id', type: 'uuid'}]}]],
    ['EF2', 'users {\nid PK\nname\n}', [{line: 2, message: "'id PK' read as column id with no type (+1 more lines)"}], [{name: 'users', columns: [{name: 'id', pk: true}, {name: 'name'}]}]],
    ['EF3', 'users {\nint x NOT NULL\n}', [{line: 2, message: "'NOT NULL' dropped (keys: PK FK UK)"}], [{name: 'users', columns: [{name: 'x', type: 'int'}]}]],
    ['EF3 after keys', 'users {\nint x PK unique "c"\n}', [{line: 2, message: "'unique' dropped (keys: PK FK UK)"}], [{name: 'users', columns: [{name: 'x', type: 'int', pk: true}]}]],
  ])('%s', (_name, src, fixes, tables) => {
    const result = parseEr(src);
    expect(fixesOf(result)).toEqual(fixes);
    expect(ok(result).tables).toEqual(tables);
  });
});

// ---------------------------------------------------------------- Markdown table
describe('parseMdTable', () => {
  it.each([
    ['| path | loc |\n|---|---|\n| src/a.ts | 120 |', [{path: 'src/a.ts', loc: 120}]],
    ['path | loc\n--- | ---\nsrc/a.ts | 120', [{path: 'src/a.ts', loc: 120}]],
    ['| v |\n|---|\n| 1.10 |\n| 2 |', [{v: '1.10'}, {v: '2'}]],
    ['| n |\n|---|\n| 1,866 |\n| +12 |', [{n: 1866}, {n: 12}]],
    ['| a | b |\n|---|---|\n| x | |', [{a: 'x'}]],
    ['| a |\n|---|\n| p \\| q |', [{a: 'p | q'}]],
    ['| a | b | c |\n|:--|:-:|--:|\n| 1 |', [{a: 1}]],
    ['| a | b |\n|---|---|\n\n| x | 1 |\n\n| y | 2 |\n', [{a: 'x', b: 1}, {a: 'y', b: 2}]],
    ['| **Last change** | `owner` |\n|---|---|\n| **today** | `Mira` |', [{'Last change': 'today', owner: 'Mira'}]],
    ['| note |\n|---|\n| one<br>two |', [{note: 'one two'}]],
    ['| a | b |\n|---|---|', []],
    ['  | a |\r\n  |---|\r\n  | 7 |', [{a: 7}]],
  ])('%j', (src, rows) => {
    const result = parseMdTable(src);
    expect(ok(result)).toEqual(rows);
    expect(fixesOf(result)).toEqual([]);
  });

  it('a column holds numbers only when every non-empty cell is one; empty cells do not count', () => {
    expect(ok(parseMdTable('| a | b |\n|---|---|\n| 1 | 1 |\n| 2 | two |\n|  | 3 |'))).toEqual([{a: 1, b: '1'}, {a: 2, b: 'two'}, {b: '3'}]);
  });

  it.each(['12', '-3', '0.5', '1,866', '+12', '−4', '0', '1,000,000.25'])('%s is a number', cell => {
    expect(typeof ok(parseMdTable(`| n |\n|---|\n| ${cell} |`))[0]!.n).toBe('number');
  });
  it.each(['007', '1.10', '2.0', '1.50', '1e3', '12%', '1,23', '12345678901234567890', '-0.0', '.5', '$5', 'v2'])('%s stays text', cell => {
    expect(ok(parseMdTable(`| n |\n|---|\n| ${cell} |`))[0]!.n).toBe(cell);
  });

  it('List: headers equal to its item keys take their spelling', () => {
    expect(ok(parseMdTable('| **Title** | Value |\n|--|--|\n| redis | 14 |', {keys: ['title', 'sub', 'value', 'file', 'path', 'tone']}))).toEqual([{title: 'redis', value: 14}]);
    expect(ok(parseMdTable('| TITLE | Sub | File | Owner |\n|-|-|-|-|\n| a | b | c.ts | d |', {keys: ['title', 'sub', 'value', 'file', 'path', 'tone']}))).toEqual([{title: 'a', sub: 'b', file: 'c.ts', Owner: 'd'}]);
  });

  it('builds rows with own properties on a plain object', () => {
    const rows = ok(parseMdTable('| a | b |\n|---|---|\n| 1 | x |'));
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
    expect(Object.keys(rows[0]!)).toEqual(['a', 'b']);
  });

  it.each([
    ['T1', '| a | b |\n|---|---|\n| x | y | z |', [err(3, 10, 'row has 3 cells, the header 2: write \\| for a | inside a cell', '| x | y \\| z |')]],
    ['T2', '| a | b |\n|---|---|\nnope', [err(3, 1, 'expected a table row "| a | b |", found "nope"', '| nope |')]],
    ['T3', '| __proto__ |\n|---|\n| 1 |', [err(1, 3, 'header "__proto__" is a reserved name: rename the column', '| __proto___ |')]],
    ['T3 constructor', '| a | constructor |\n|---|---|', [err(1, 7, 'header "constructor" is a reserved name: rename the column', '| constructor_ |')]],
    ['T3 prototype', 'prototype | b\n--- | ---', [err(1, 1, 'header "prototype" is a reserved name: rename the column', '| prototype_ |')]],
  ])('%s', (_name, src, errors) => {
    expect(errorsOf(parseMdTable(src))).toEqual(errors);
  });

  it.each([
    ['TF1', '| a | b |\n| x | 1 |', [{line: 1, message: 'no |---| row under the header: line 1 read as the header'}], [{a: 'x', b: 1}]],
    ['TF2', '| a | |\n|-|-|\n| 1 | 2 |', [{line: 1, message: 'empty header 2 named col2'}], [{a: 1, col2: 2}]],
    ['TF3', '| a | a | a |\n|-|-|-|\n| 1 | 2 | 3 |', [{line: 1, message: "header 'a' twice: the second is 'a 2'"}], [{a: 1, 'a 2': 2, 'a 3': 3}]],
  ])('%s', (_name, src, fixes, rows) => {
    const result = parseMdTable(src);
    expect(fixesOf(result)).toEqual(fixes);
    expect(ok(result)).toEqual(rows);
  });
});

// ---------------------------------------------------------------- task list
describe('parseTaskList', () => {
  it.each([
    ['- [x] Add the middleware', {title: 'Add the middleware', status: 'done'}],
    ['- [~] Wire the router — behind a flag [[src/api/routes.ts#L12]]', {title: 'Wire the router', note: 'behind a flag', status: 'doing', file: 'src/api/routes.ts#L12'}],
    ['* [ ] Tests', {title: 'Tests', status: 'todo'}],
    ['1. [ ] Tests', {title: 'Tests', status: 'todo'}],
    ['2) [ ] Tests', {title: 'Tests', status: 'todo'}],
    ['+ [ ] Tests', {title: 'Tests', status: 'todo'}],
    ['[ ] Tests', {title: 'Tests', status: 'todo'}],
    ['- [] Tests', {title: 'Tests', status: 'todo'}],
    ['- [!] Deploy -- waiting on infra', {title: 'Deploy', note: 'waiting on infra', status: 'blocked'}],
    ['- Rate limiter — static first', {title: 'Rate limiter', note: 'static first'}],
    ['- Phase 1 - setup', {title: 'Phase 1 - setup'}],
    ['- Ship – en dash note', {title: 'Ship', note: 'en dash note'}],
    ['- [x] **Bold** title', {title: '**Bold** title', status: 'done'}],
    ['- [x] **Ship it**', {title: 'Ship it', status: 'done'}],
    ['- [x] Fix [[src/a.ts#L3]] the loop — note', {title: 'Fix the loop', note: 'note', status: 'done', file: 'src/a.ts#L3'}],
    ['- [ ] Read [[https://example.com/doc]]', {title: 'Read [[https://example.com/doc]]', status: 'todo'}],
    ['- [x] a — b — c', {title: 'a', note: 'b — c', status: 'done'}],
  ])('%s', (src, step) => {
    const result = parseTaskList(src);
    expect(ok(result)).toEqual([step]);
    expect(fixesOf(result)).toEqual([]);
  });

  it.each([
    ['x', 'done'], ['X', 'done'], ['✓', 'done'], ['✔', 'done'], ['~', 'doing'], ['/', 'doing'], ['>', 'doing'],
    [' ', 'todo'], ['', 'todo'], ['!', 'blocked'], ['-', 'skipped'],
  ])('mark [%s] is %s', (mark, status) => {
    expect(ok(parseTaskList(`- [${mark}] a`))).toEqual([{title: 'a', status}]);
  });

  it('lines indented under a step continue its note (and may give its file)', () => {
    expect(ok(parseTaskList('- [x] Ship\n  behind the flag\n\n  and dark launched [[src/flags.ts]]\n- [ ] Next'))).toEqual([
      {title: 'Ship', note: 'behind the flag and dark launched', status: 'done', file: 'src/flags.ts'},
      {title: 'Next', status: 'todo'},
    ]);
    expect(ok(parseTaskList('- [x] Ship — first\n    second'))).toEqual([{title: 'Ship', note: 'first second', status: 'done'}]);
  });

  it('the first item sets the base indentation', () => {
    expect(ok(parseTaskList('  - [x] a\n  - [ ] b'))).toEqual([{title: 'a', status: 'done'}, {title: 'b', status: 'todo'}]);
  });

  it.each([
    ['S1', '- [x] a\nTests later', [err(2, 1, 'expected a step "- [ ] title", found "Tests later"', '- [ ] Tests later')]],
    ['S2', '- [x] a\n- [x]', [err(2, 1, 'step has no title', '- [x] Ship the map')]],
    ['S2 note only', '- [x]  — note', [err(1, 1, 'step has no title', '- [x] Ship the map')]],
  ])('%s', (_name, src, errors) => {
    expect(errorsOf(parseTaskList(src))).toEqual(errors);
  });

  it.each([
    ['SF1', '- [o] a\n- [?] b\n- [x] c', [{line: 1, message: "'[o]' read as '[ ]' (marks: x ~ space ! -) (+1 more lines)"}], [{title: 'a', status: 'todo'}, {title: 'b', status: 'todo'}, {title: 'c', status: 'done'}]],
    ['SF2', '- [x] a\n  - [ ] a.1\n  - [ ] a.2\n- [ ] b', [{line: 2, message: 'nested step flattened (+1 more lines)'}], [
      {title: 'a', status: 'done'}, {title: 'a.1', status: 'todo'}, {title: 'a.2', status: 'todo'}, {title: 'b', status: 'todo'},
    ]],
    // Measurement: the small model wrote '- [x] Measure request mix per route — done' in each of its plans, and the
    // page showed a 'done' note under a done step. A note that only names a status is the box's to say.
    ['SF4', '- [x] Measure request mix — done\n- [~] Add limiter — in progress.\n- [ ] Docs — not started', [{line: 1, message: "note 'done' dropped: the box [x] gives the status (+2 more lines)"}], [
      {title: 'Measure request mix', status: 'done'}, {title: 'Add limiter', status: 'doing'}, {title: 'Docs', status: 'todo'},
    ]],
    ['SF3', '- Ship the map — Done\n- Tests — blocked', [{line: 1, message: "'— Done' read as the box [x] (+1 more lines)"}], [
      {title: 'Ship the map', status: 'done'}, {title: 'Tests', status: 'blocked'},
    ]],
    ['a note that says more is kept', '- [x] Ship — done behind a flag', [], [{title: 'Ship', note: 'done behind a flag', status: 'done'}]],
  ])('%s', (_name, src, fixes, steps) => {
    const result = parseTaskList(src);
    expect(fixesOf(result)).toEqual(fixes);
    expect(ok(result)).toEqual(steps);
  });
});

// ---------------------------------------------------------------- Key: value, stats, layers
describe('parseKeyValue', () => {
  it('keeps the order and the type of each value', () => {
    expect(ok(parseKeyValue('Language: TypeScript\nTests: true\nFiles: 412\nPrivate: false\nEmpty:\nVersion: 1.10'))).toEqual([
      {label: 'Language', value: 'TypeScript'}, {label: 'Tests', value: true}, {label: 'Files', value: 412}, {label: 'Private', value: false},
      {label: 'Empty', value: ''}, {label: 'Version', value: '1.10'},
    ]);
  });

  it.each([
    ['- **Entry**: src/main.ts', {label: 'Entry', value: 'src/main.ts'}],
    ['* **Entry:** src/main.ts', {label: 'Entry', value: 'src/main.ts'}],
    ['`Entry`: src/main.ts', {label: 'Entry', value: 'src/main.ts'}],
    ['Time: 10:30', {label: 'Time', value: '10:30'}],
    ['Docs: https://example.com/a', {label: 'Docs', value: 'https://example.com/a'}],
    ['Main owner: Mira', {label: 'Main owner', value: 'Mira'}],
    ['Rule: one; two', {label: 'Rule', value: 'one; two'}],
    ['Owners: Mira, Jon', {label: 'Owners', value: 'Mira, Jon'}],
    ['Loc: 1,866', {label: 'Loc', value: 1866}],
  ])('%s', (src, pair) => {
    expect(ok(parseKeyValue(src))).toEqual([pair]);
  });

  it('an indented line without a key of its own continues the value', () => {
    expect(ok(parseKeyValue('Auth: tokens are cached for 15 minutes;\n  the cache is per process\nTTL: 40'))).toEqual([
      {label: 'Auth', value: 'tokens are cached for 15 minutes; the cache is per process'}, {label: 'TTL', value: 40},
    ]);
    expect(ok(parseKeyValue('A: x\n  B: y'))).toEqual([{label: 'A', value: 'x'}, {label: 'B', value: 'y'}]);
  });

  it.each([
    ['P1', 'Language: TypeScript\nno colon here', [err(2, 1, 'expected "Key: value", found "no colon here"', 'Key: no colon here')]],
    ['P2', ': value', [err(1, 1, 'empty key before ":"', 'Key: value')]],
    ['P2 after a bullet', '  - : x', [err(1, 3, 'empty key before ":"', 'Key: x')]],
  ])('%s', (_name, src, errors) => {
    expect(errorsOf(parseKeyValue(src))).toEqual(errors);
  });

  it('PF1: a colon without a space', () => {
    const result = parseKeyValue('Tests:true\nOwner:Mira');
    expect(fixesOf(result)).toEqual([{line: 1, message: "'Tests:true' read as 'Tests: true' (+1 more lines)"}]);
    expect(ok(result)).toEqual([{label: 'Tests', value: true}, {label: 'Owner', value: 'Mira'}]);
  });
});

describe('parseStats', () => {
  it.each([
    ['Files: 412', {label: 'Files', value: 412}],
    ['Coverage: 87% (+2)', {label: 'Coverage', value: 87, unit: '%', delta: 2}],
    ['Coverage: 87 % (-2%)', {label: 'Coverage', value: 87, unit: '%', delta: -2}],
    ['Tests: 1,866 tests (−3)', {label: 'Tests', value: 1866, unit: 'tests', delta: -3}],
    ['Size: 3.1k LOC', {label: 'Size', value: 3100, unit: 'LOC'}],
    ['Size: 1.15k', {label: 'Size', value: 1150}],
    ['Users: 2M', {label: 'Users', value: 2000000}],
    ['Rows: 1.2B', {label: 'Rows', value: 1200000000}],
    ['Heap: 3G', {label: 'Heap', value: 3000000000}],
    ['Memory: 512MB', {label: 'Memory', value: 512, unit: 'MB'}],
    ['p95: 412ms (+12)', {label: 'p95', value: 412, unit: 'ms', delta: 12}],
    ['Delta: -4 (+0.5)', {label: 'Delta', value: -4, delta: 0.5}],
    ['Stack: TypeScript', {label: 'Stack', value: 'TypeScript'}],
    ['p95: 412 (2 new)', {label: 'p95', value: '412 (2 new)'}],
    ['Zip: 007', {label: 'Zip', value: '007'}],
    ['Ratio: 12 of 40', {label: 'Ratio', value: '12 of 40'}],
    ['Empty:', {label: 'Empty', value: ''}],
  ])('%s', (src, item) => {
    expect(ok(parseStats(src))).toEqual([item]);
  });

  it('shares the line grammar, errors and repair of KeyValue', () => {
    expect(errorsOf(parseStats('Files: 1\nnope'))).toEqual([err(2, 1, 'expected "Key: value", found "nope"', 'Key: nope')]);
    expect(fixesOf(parseStats('Files:412'))).toEqual([{line: 1, message: "'Files:412' read as 'Files: 412'"}]);
    expect(ok(parseStats('- **Files**: 412\n  files'))).toEqual([{label: 'Files', value: 412, unit: 'files'}]);
  });
});

describe('parseLayers', () => {
  it.each([
    ['API: routes, middleware', [{name: 'API', items: ['routes', 'middleware']}]],
    ['Domain: ledger, payouts [[src/payouts.ts]] — no I/O', [{name: 'Domain', items: ['ledger', {label: 'payouts', file: 'src/payouts.ts'}], note: 'no I/O'}]],
    ['API:', [{name: 'API', items: []}]],
    ['API: — only a note', [{name: 'API', items: [], note: 'only a note'}]],
    ['- **API**: a, , b,', [{name: 'API', items: ['a', 'b']}]],
    ['Storage: [[db/schema.sql]]', [{name: 'Storage', items: [{label: 'db/schema.sql', file: 'db/schema.sql'}]}]],
    ['Web: a [[src/a,b.ts]], c', [{name: 'Web', items: [{label: 'a', file: 'src/a,b.ts'}, 'c']}]],
    ['Ext: docs [[https://example.com]]', [{name: 'Ext', items: ['docs [[https://example.com]]']}]],
    ['API: routes,\n  middleware — thin\nDomain: ledger', [{name: 'API', items: ['routes', 'middleware'], note: 'thin'}, {name: 'Domain', items: ['ledger']}]],
  ])('%j', (src, layers) => {
    expect(ok(parseLayers(src))).toEqual(layers);
  });

  // Measurement: 'Index: .glimpse/cache/index.json with size, created and last-read times' became the chips
  // '.glimpse/cache/index.json with size' and 'created and last-read times'. A sentence is the tier's note.
  it('reads a line of prose as the tier note, and says so', () => {
    const src = [
      'Key: source name, args, repo HEAD, analyzer version — hashed to a cache key',
      'Store: .cache/<key>.json on disk, one file per result',
      'Index: .cache/index.json with size, created and last-read times',
      'Serve: server reads cache before running an analyzer, falls back to recompute',
      'Limiter: RateLimiter, TokenBucket, LRU of buckets',
    ].join('\n');
    const result = parseLayers(src);
    expect(ok(result)).toEqual([
      {name: 'Key', items: ['source name', 'args', 'repo HEAD', 'analyzer version'], note: 'hashed to a cache key'},
      {name: 'Store', items: [], note: '.cache/<key>.json on disk, one file per result'},
      {name: 'Index', items: [], note: '.cache/index.json with size, created and last-read times'},
      {name: 'Serve', items: [], note: 'server reads cache before running an analyzer, falls back to recompute'},
      {name: 'Limiter', items: ['RateLimiter', 'TokenBucket', 'LRU of buckets']},
    ]);
    expect(fixesOf(result)).toEqual([{line: 2, message: "prose read as the tier's note (items are names) (+2 more lines)"}]);
    // names stay names, also long ones and many of them
    expect(fixesOf(parseLayers('Transport: HTTP /api, WebSocket /ws, MCP stdio\nHandlers: show, query, events, catalog, export, import'))).toEqual([]);
  });

  it.each([
    ['L1', 'API: routes\nno colon', [err(2, 1, 'expected "Layer: item, item — note", found "no colon"', 'Layer: no colon')]],
    ['L2', ': routes', [err(1, 1, 'empty layer name before ":"', 'Layer: routes')]],
  ])('%s', (_name, src, errors) => {
    expect(errorsOf(parseLayers(src))).toEqual(errors);
  });
});

// ---------------------------------------------------------------- classifier and dispatch
const REFS = ['git.churn src/auth top=20', 'git.chrun src', 'fake.rows', 'files.list', 'deps.modules src/auth', 'diff.impact', 'repo.kpis'];

describe('looksLikeNotation', () => {
  const cases: Record<NotationKind, {yes: string[]; no: string[]}> = {
    graph: {
      yes: ['graph LR\na --> b', 'flowchart TD', 'graph; a', '%% c\ngraph LR', 'a --> b', 'a --- b', 'a -.- b', 'a ==> b', 'x\nsubgraph g\nend', 'GRAPH LR'],
      no: ['graphs are nice', 'a -> b', 'hello world', 'a[API]'],
    },
    er: {
      yes: ['erDiagram\na ||--|| b', 'users {\nint id\n}', 'users{', '"order item" {', 'users ||--o{ orders : places', 'a }o..|{ b', '%% c\nerDiagram'],
      no: ['users', 'a -- b', 'erDiagrams', 'users ->> orders'],
    },
    table: {
      yes: ['| a | b |', '  | a |', 'a | b\n--- | ---', 'a | b\n\n|:-|-:|'],
      no: ['a | b\nc | d', 'a\n---', 'path loc', '- [x] a'],
    },
    tasks: {
      yes: ['- [x] a', '* a', '+ a', '1. a', '12) a', '[ ] a', '  [x] a', '- a'],
      no: ['-a', '1.5 a', 'a - b', '[[src/a.ts]] a', 'Tests: 1'],
    },
    keyValue: {
      yes: ['Language: TypeScript', 'config.json: 2', '- **Entry**: x', '**Entry:** x', 'Empty:', 'Time: 10:30'],
      no: ['no colon', 'Time:10:30', 'https://x', ': value'],
    },
    stats: {yes: ['Files: 412'], no: ['412']},
    layers: {yes: ['API: routes, auth', 'API:'], no: ['API routes']},
  };
  it.each(Object.entries(cases).flatMap(([kind, {yes, no}]) => [
    ...yes.map(text => [kind, text, true] as const), ...no.map(text => [kind, text, false] as const),
  ]))('%s %j -> %s', (kind, text, expected) => {
    expect(looksLikeNotation(kind as NotationKind, text)).toBe(expected);
  });

  it.each(Object.keys(cases).flatMap(kind => [...REFS, '', '   ', '\n\n', 'plain words', 'node.js'].map(text => [kind, text] as const)))('%s: %j is not a notation', (kind, text) => {
    expect(looksLikeNotation(kind as NotationKind, text)).toBe(false);
  });
});

/** The design's per-prop table, exhaustively: every other data prop takes no notation. */
const TAKES: Readonly<Record<string, NotationKind>> = {
  'Graph.data': 'graph', 'ERDiagram.data': 'er',
  'DataTable.data': 'table', 'SegmentedBar.data': 'table', 'BarChart.data': 'table', 'LineChart.data': 'table', 'ScatterPlot.data': 'table',
  'Heatmap.data': 'table', 'CalendarHeatmap.data': 'table', 'Histogram.data': 'table', 'List.data': 'table',
  'Steps.data': 'tasks', 'KeyValue.data': 'keyValue', 'Stats.data': 'stats', 'Layers.data': 'layers',
};

describe('notationKind and notationFor', () => {
  it('notationKind is the per-prop table', () => {
    const found: Record<string, NotationKind> = {};
    for (const def of COMPONENTS) {
      for (const key of Object.keys(def.props)) {
        const kind = notationKind(def.name, key);
        if (kind) found[`${def.name}.${key}`] = kind;
      }
    }
    expect(found).toEqual(TAKES);
    for (const [name, key] of [['Nope', 'data'], ['Graph', 'nope'], ['Graph', 'dir'], ['Flowchart', 'src'], ['Graph', '__proto__'], ['Graph', 'constructor']]) {
      expect(notationKind(name!, key!), `${name}.${key}`).toBeUndefined();
    }
  });

  it.each([
    ['Graph', 'graph LR\na --> b', 'graph'], ['ERDiagram', 'a ||--o{ b', 'er'], ['DataTable', '| a |\n|-|\n| 1 |', 'table'], ['BarChart', '| a |\n|-|\n| 1 |', 'table'],
    ['Steps', '- [x] a', 'tasks'], ['KeyValue', 'A: 1', 'keyValue'], ['Stats', 'A: 1', 'stats'], ['Layers', 'A: b', 'layers'],
  ])('%s(%j) is read as %s', (component, text, kind) => {
    const match = notationFor(component, 'data', text);
    expect(match?.kind).toBe(kind);
    expect(match?.result.ok).toBe(true);
  });

  it('List reads a Markdown table with its item keys', () => {
    expect(notationFor('List', 'data', '| Title | Value |\n|-|-|\n| redis | 14 |')).toEqual({kind: 'table', result: {ok: true, ast: [{title: 'redis', value: 14}]}});
    expect(notationFor('DataTable', 'data', '| Title |\n|-|\n| redis |')?.result).toEqual({ok: true, ast: [{Title: 'redis'}]});
  });

  it('a parse error comes back as the result, not undefined', () => {
    expect(notationFor('Steps', 'data', '- [x] a\nnot a step')?.result.ok).toBe(false);
  });

  const TEXTS = [...REFS, '', 'hello world', 'node.js', 'config.json: 2', '| a |', '- [x] a', 'a --> b', 'users {', '\u0000', '|'.repeat(5000), '- '.repeat(3000), '[['.repeat(1000)];
  it.each(Object.keys(TAKES).map(k => k.split('.') as [string, string]))('%s.%s: undefined for refs and plain text, never throws', (component, prop) => {
    for (const ref of [...REFS, '', 'hello world', 'node.js']) expect(notationFor(component, prop, ref), ref).toBeUndefined();
    for (const text of TEXTS) expect(() => notationFor(component, prop, text), text.slice(0, 20)).not.toThrow();
  });

  it('props that take no notation answer undefined for any text', () => {
    for (const def of COMPONENTS) {
      for (const key of Object.keys(def.props)) {
        if (`${def.name}.${key}` in TAKES) continue;
        for (const text of TEXTS) expect(notationFor(def.name, key, text), `${def.name}.${key}`).toBeUndefined();
      }
    }
  });
});

describe('NOTATIONS', () => {
  const PARSE: Record<NotationKind, (text: string) => ParseResult<unknown>> = {
    graph: parseGraph, er: parseEr, table: t => parseMdTable(t), tasks: parseTaskList, keyValue: parseKeyValue, stats: parseStats, layers: parseLayers,
  };
  it.each(Object.entries(NOTATIONS))('%s: the example and the short form, read as Express, parse with no fixes', (kind, notation) => {
    for (const literal of [notation.example, notation.short]) {
      expect(literal).not.toContain('\n');
      expect(literal.startsWith("'") && literal.endsWith("'")).toBe(true);
      const text = JSON.parse(normalizeSpec(literal)) as string;
      expect(text).toContain(kind === 'keyValue' || kind === 'stats' || kind === 'layers' ? ':' : '');
      expect(looksLikeNotation(kind as NotationKind, text), literal).toBe(true);
      const result = PARSE[kind as NotationKind](text);
      expect(result.ok, literal).toBe(true);
      expect(fixesOf(result), literal).toEqual([]);
    }
    expect(notation.sig.length).toBeLessThanOrEqual(130);
    expect(notation.example.length).toBeLessThanOrEqual(130);
    expect(notation.name).not.toBe('');
  });

  it('the examples give the data the docs describe', () => {
    const text = (kind: NotationKind) => JSON.parse(normalizeSpec(NOTATIONS[kind].example)) as string;
    expect(ok(parseGraph(text('graph')))).toEqual({
      nodes: [{id: 'r', label: 'routes', sub: 'express', group: 'api', status: 'modified'}, {id: 's', label: 'service', group: 'api', file: 'src/s.ts#L12'}],
      edges: [{from: 'r', to: 's', label: 'calls'}], groups: [{id: 'api', label: 'API'}],
    });
    expect(ok(parseEr(text('er')))).toEqual({
      tables: [{name: 'users', columns: [{name: 'id', type: 'uuid', pk: true}, {name: 'email', type: 'text'}]}, {name: 'orders', columns: [{name: 'user_id', type: 'uuid', fk: true}]}],
      relations: [{from: 'users', to: 'orders', card: '1-n', label: 'places'}],
    });
    expect(ok(parseMdTable(text('table')))).toEqual([{path: 'src/a.ts', loc: 120}, {path: 'src/b.ts', loc: 80}]);
    expect(ok(parseTaskList(text('tasks')))).toEqual([
      {title: 'Add the middleware', status: 'done'}, {title: 'Wire the router', note: 'behind a flag', status: 'doing', file: 'src/api/routes.ts#L12'}, {title: 'Tests', status: 'todo'},
    ]);
    expect(ok(parseKeyValue(text('keyValue')))).toEqual([{label: 'Language', value: 'TypeScript'}, {label: 'Entry', value: 'src/main.ts'}, {label: 'Tests', value: true}]);
    expect(ok(parseStats(text('stats')))).toEqual([{label: 'Files', value: 412}, {label: 'Coverage', value: 87, unit: '%', delta: 2}, {label: 'Tests', value: 1866}]);
    expect(ok(parseLayers(text('layers')))).toEqual([{name: 'API', items: ['routes', 'middleware']}, {name: 'Domain', items: ['ledger', {label: 'payouts', file: 'src/payouts.ts'}], note: 'no I/O'}]);
  });
});

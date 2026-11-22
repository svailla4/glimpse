// What a node-link diagram opens on, and what dragging does, after the review of the ELK + React Flow swap (decisions
// diagram-engine-in-worker, content-sized-plates): labelled graphs open whole when they read, long flows wrap into rows, a part view always has a minimap,
// charts and schemas without a direction take the one that reads larger, a dragged node's edges go round what is in
// the way, a drill opens unselected, names are not cut while there is room, and sequence heads never touch.
// Every fixture is invented and inline.
import {cleanSequence} from '@glimpse/catalog';
import {screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {fitKeepingTail, tailsOf} from '../../src/components/diagrams/Graph.tsx';
import {planSequence} from '../../src/components/diagrams/SequenceDiagram.tsx';
import {CONTROLS, UI_12, configurePositionStorage, textWidth} from '../../src/components/diagrams/flowkit/index.ts';
import {datasetFixture, renderExpress} from '../harness.tsx';
import {click, crosses, drag, drawn, elk, fakeStorage, lineOf, nodeIds, nodeOf, onStage, pointsOf, positionOf, sizeOf, stageHeight, stageOf, viewOf} from './util.tsx';

type View = ReturnType<typeof renderExpress>;

beforeEach(() => configurePositionStorage(fakeStorage()));
afterEach(() => configurePositionStorage(undefined));

const open = async (spec: string, options: Parameters<typeof renderExpress>[1], id: string, role: RegExp) => {
  const view = renderExpress(spec, options);
  await screen.findAllByRole('img', {name: role});
  await drawn(view, id);
  return view;
};
/** Every node of a cell inside its stage. */
const allInside = (view: View, id: string, width: number) => {
  const stage = stageOf(view, id);
  const canvas = stageHeight(stage) - CONTROLS;
  return nodeIds(view, id).every(nodeId => {
    const at = onStage(stage, nodeOf(view, id, nodeId));
    return at.left >= -0.5 && at.top >= -0.5 && at.right <= width + 0.5 && at.bottom <= canvas + 0.5;
  });
};
/** A node is shown whole or not at all: never cut by an edge of the stage. */
const noneCut = (view: View, id: string, width: number) => {
  const stage = stageOf(view, id);
  const canvas = stageHeight(stage) - CONTROLS;
  return nodeIds(view, id).filter(nodeId => {
    const at = onStage(stage, nodeOf(view, id, nodeId));
    const whole = at.left >= -0.5 && at.top >= -0.5 && at.right <= width + 0.5 && at.bottom <= canvas + 0.5;
    const out = at.right <= 0.5 || at.left >= width - 0.5 || at.bottom <= 0.5 || at.top >= canvas - 0.5;
    return !whole && !out;
  });
};
/** Corner points of an edge's drawn line, as {x, y}. */
const routeOf = (view: View, id: string, edgeKey: string) => {
  const edge = view.cell(id).querySelector(`[data-edge-key="${edgeKey}"]`)!;
  return pointsOf(lineOf(edge)).map(([x, y]) => ({x, y}));
};
const boxOf = (view: View, id: string, nodeId: string) => ({...positionOf(nodeOf(view, id, nodeId)), ...sizeOf(nodeOf(view, id, nodeId))});

// Graph#nest of the review: 13 nodes in 5 groups, two edge labels. It opened at 95% with 9 of 13 in view and the minimap,
// although at 72% all of it was legible: the two labels did not grow when zoomed out, so they held the zoom at 91%.
const NEST = {
  groups: [{id: 'be', label: 'backend'}, {id: 'svc', label: 'services', parent: 'be'}, {id: 'data', label: 'data', parent: 'be'}, {id: 'fe', label: 'frontend'}, {id: 'ops', label: 'ops'}],
  nodes: [
    {id: 'ui', label: 'ui shell', group: 'fe'}, {id: 'pages', label: 'pages', group: 'fe'}, {id: 'client', label: 'api client', group: 'fe'},
    {id: 'gw', label: 'gateway', group: 'be'}, {id: 'auth', label: 'auth', group: 'svc', cycle: true}, {id: 'orders', label: 'orders', group: 'svc', cycle: true},
    {id: 'pay', label: 'payments', group: 'svc'}, {id: 'pg', label: 'postgres', group: 'data'}, {id: 'redis', label: 'redis', group: 'data'},
    {id: 's3', label: 'blob store', group: 'data'}, {id: 'mon', label: 'monitoring', group: 'ops'}, {id: 'ci', label: 'ci', group: 'ops'}, {id: 'ext', label: 'stripe', kind: 'external'},
  ],
  edges: [
    {from: 'ui', to: 'pages'}, {from: 'pages', to: 'client'}, {from: 'client', to: 'gw', label: 'https'}, {from: 'gw', to: 'auth'}, {from: 'gw', to: 'orders'},
    {from: 'orders', to: 'pay'}, {from: 'auth', to: 'orders', cycle: true}, {from: 'orders', to: 'auth', cycle: true}, {from: 'auth', to: 'redis'}, {from: 'orders', to: 'pg'},
    {from: 'pay', to: 'pg'}, {from: 'pay', to: 'ext', label: 'charges'}, {from: 'pages', to: 's3', kind: 'dashed'}, {from: 'mon', to: 'gw', kind: 'dashed'},
    {from: 'mon', to: 'pg', kind: 'dashed'}, {from: 'ci', to: 'ui', kind: 'dashed'},
  ],
};

describe('opening views after the swap review', () => {
  it('opens a 13-node grouped graph with two edge labels whole in a 1254 x 608 stage, every label 10 px or more on screen', async () => {
    const view = await open(`root=Page('T',[g])\ng=Graph($/g,title='Nest')`, {data: {'/g': NEST}, size: {width: 1254, height: 608}}, 'g', /^Graph/);
    const stage = stageOf(view, 'g');
    expect(stage.parentElement!.getAttribute('data-mode')).toBe('fit');
    expect(allInside(view, 'g', 1254)).toBe(true);
    const {k} = viewOf(stage);
    const labels = [...view.cell('g').querySelectorAll<HTMLElement>('[data-edge-label]')];
    expect(labels.map(label => label.textContent).sort()).toEqual(['charges', 'https']);
    for (const label of labels) expect((Number.parseFloat(label.style.fontSize) || 11) * k, label.textContent!).toBeGreaterThanOrEqual(10);
    // a grown label stays centred on its edge
    for (const label of labels) {
      const plate = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(label.style.transform)!;
      const centre = {x: Number(plate[1]) + Number.parseFloat(label.style.width) / 2, y: Number(plate[2]) + Number.parseFloat(label.style.height) / 2};
      const key = label.getAttribute('data-edge-label')!;
      expect(crosses(routeOf(view, 'g', key), {x: centre.x - 2, y: centre.y - 2, w: 4, h: 4}, 0)).toBe(true);
    }
    expect(view.cell('g').querySelector('[data-in-view]')).toBeNull();
  });

  // An 11-step start-up chart, left to right in a span=6 plate, opened at 88% in a 132 px canvas,
  // 7 of 11 in view, with no minimap. It is wrapped into rows instead.
  it('opens an 11-step left-to-right chart in a 616 px plate whole, wrapped into rows, at a readable zoom', async () => {
    const steps = ['load config', 'open store', 'start server', 'mount routes', 'warm cache', 'connect queue', 'start workers', 'register jobs', 'open socket', 'serve ui', 'ready'];
    const data = `{nodes:{${steps.map((label, i) => `S${i}:'${label}'`).join(',')}},edges:[${steps.slice(1).map((_, i) => `['S${i}','S${i + 1}']`).join(',')}]}`;
    const view = await open(`root=Page('T',[f])\nf=Flowchart(${data},dir='LR',title='Boot')`, {size: {width: 616, height: 600}}, 'f', /^Flowchart/);
    const stage = stageOf(view, 'f');
    expect(stage.parentElement!.getAttribute('data-mode')).toBe('fit');
    expect(allInside(view, 'f', 616)).toBe(true);
    expect(viewOf(stage).k).toBeGreaterThanOrEqual(0.84);
    expect(stage.getAttribute('data-dir')).toBe('LR');
    // it was wrapped: some step sits below the first one
    const ys = new Set(nodeIds(view, 'f').map(id => Math.round(positionOf(nodeOf(view, 'f', id)).y)));
    expect(ys.size).toBeGreaterThan(1);
    expect(elk.requests.some(request => request.graph.layoutOptions?.['elk.layered.wrapping.strategy'] !== undefined)).toBe(true);
  });

  // Charts opened in part on a canvas under 240 px got no minimap, and under 520 px wide no count.
  it('gives every diagram it opens in part a minimap (in a free corner or a strip in the controls bar) and a count', async () => {
    const states = "{nodes:{Start:{label:'start',shape:'circle'}},edges:[['Start','Created','show with root='],['Created','Patched','show without root='],['Patched','Patched','show without root='],['Created','Replaced','show with root='],['Patched','Replaced','show with root='],['Replaced','Patched','show without root='],['Created','Deleted','removed'],['Patched','Deleted','removed'],['Replaced','Deleted','removed']]}";
    for (const width of [400, 510, 724]) {
      const view = await open(`root=Page('T',[f])\nf=Flowchart(${states},dir='LR',title='States')`, {size: {width, height: 600}}, 'f', /^Flowchart/);
      const stage = stageOf(view, 'f');
      if (stage.parentElement!.getAttribute('data-mode') === 'readable') {
        expect(view.cell('f').querySelector('.react-flow__minimap'), `minimap at ${width}`).not.toBeNull();
        expect(view.cell('f').querySelector('[data-in-view]')!.textContent).toMatch(/^\d+( of |\/)5/);
      }
      expect(noneCut(view, 'f', width), `cut at ${width}`).toEqual([]);
      view.unmount();
    }
  });

  // A flowchart without dir= was always top to bottom: a 14-step chart in a full-width plate opened at 91% with 7 of
  // 13 in view and two thirds of the plate empty.
  it('lays a flowchart with no dir= out both ways and draws it the way that reads larger', async () => {
    const data = "{nodes:{Req:'Incoming request',Auth:{label:'Signed in?',shape:'diamond'},Login:{label:'Redirect to login',shape:'pill'},Rate:{label:'Over limit?',shape:'diamond'},E429:{label:'429 Too Many',shape:'pill'},Cache:{label:'Cached?',shape:'diamond'},Send:'Send cached body',Handler:'Run handler',DB:{label:'Postgres',shape:'store'},Q:{label:'Queue',shape:'store'},Render:'Render',Store:'Write cache',Done:{label:'done',shape:'circle'}},edges:[['Req','Auth'],['Auth','Login','no'],['Auth','Rate','yes'],['Rate','E429','yes'],['Rate','Cache','no'],['Cache','Send','hit'],['Cache','Handler','miss'],['Handler','DB'],{from:'Handler',to:'Q',dashed:true},['Handler','Render'],['Render','Store'],['Store','Send'],['Send','Done'],['Login','Done'],['E429','Done']]}";
    const view = await open(`root=Page('T',[f])\nf=Flowchart(${data},title='Request path')`, {size: {width: 1254, height: 700}}, 'f', /^Flowchart/);
    expect(new Set(elk.requests.map(request => request.graph.layoutOptions!['elk.direction']))).toEqual(new Set(['RIGHT', 'DOWN']));
    expect(stageOf(view, 'f').getAttribute('data-dir')).toBe('LR');
    expect(stageOf(view, 'f').parentElement!.getAttribute('data-mode')).toBe('fit');
    view.unmount();
    // dir= still decides
    const headed = await open(`root=Page('T',[f])\nf=Flowchart(${data},dir='TB',title='Request path')`, {size: {width: 1254, height: 700}}, 'f', /^Flowchart/);
    expect(stageOf(headed, 'f').getAttribute('data-dir')).toBe('TB');
  });

  it('lays a schema with no dir= out both ways', async () => {
    const tables = [
      {name: 'widgets', columns: [{name: 'id', type: 'text', pk: true}, {name: 'board_id', type: 'text', fk: 'boards.id'}]},
      {name: 'boards', columns: [{name: 'id', type: 'text', pk: true}, {name: 'theme_id', type: 'text', fk: 'themes.id'}]},
      {name: 'themes', columns: [{name: 'id', type: 'text', pk: true}, {name: 'version', type: 'text'}]},
    ];
    const view = await open(`root=Page('T',[e])\ne=ERDiagram($/t,title='Schema')`, {data: {'/t': tables}, size: {width: 510, height: 600}}, 'e', /^Entity-relationship/);
    const dirs = new Set(elk.requests.map(request => request.graph.layoutOptions!['elk.direction'] ?? request.graph.children?.find(child => child.layoutOptions?.['elk.direction'])?.layoutOptions?.['elk.direction']));
    expect(dirs).toEqual(new Set(['RIGHT', 'DOWN']));
    expect(noneCut(view, 'e', 510)).toEqual([]);
  });
});

describe('dragging after the swap review', () => {
  // After 'payments' was dragged across another node's column its edge dropped through 'auth', the dragged box sat on
  // 'blob store', and the damage came back after a reload.
  const FAN = {
    nodes: [{id: 'src', label: 'source'}, {id: 'm1', label: 'first'}, {id: 'm2', label: 'second'}, {id: 'm3', label: 'third'}, {id: 'dst', label: 'sink'}],
    edges: [{from: 'src', to: 'm1'}, {from: 'src', to: 'm2'}, {from: 'src', to: 'm3'}, {from: 'm1', to: 'dst'}, {from: 'm2', to: 'dst'}, {from: 'm3', to: 'dst'}],
  };
  const spec = `root=Page('T',[g])\ng=Graph($/g,'LR',title='Fan')`;

  it('routes the edges of a node dragged across another column round every node that is not one of their ends', async () => {
    const view = await open(spec, {data: {'/g': FAN}, size: {width: 960, height: 600}}, 'g', /^Graph/);
    const {k} = viewOf(stageOf(view, 'g'));
    const sink = boxOf(view, 'g', 'dst');
    const source = boxOf(view, 'g', 'src');
    // to the far side of the source, past the middle column
    await drag(nodeOf(view, 'g', 'dst'), (source.x - sink.x - 220) * k, 0);
    const moved = boxOf(view, 'g', 'dst');
    expect(moved.x + moved.w).toBeLessThan(source.x);
    for (const key of ['3', '4', '5']) {
      const route = routeOf(view, 'g', key);
      const from = ['m1', 'm2', 'm3'][Number(key) - 3]!;
      for (const other of ['src', 'm1', 'm2', 'm3'].filter(id => id !== from)) {
        expect(crosses(route, boxOf(view, 'g', other)), `${from} -> dst through ${other}`).toBe(false);
      }
    }
  });

  it('moves a node dropped on another to the nearest free place beside it', async () => {
    const view = await open(spec, {data: {'/g': FAN}, size: {width: 960, height: 600}}, 'g', /^Graph/);
    const {k} = viewOf(stageOf(view, 'g'));
    const a = boxOf(view, 'g', 'm1');
    const b = boxOf(view, 'g', 'm3');
    await drag(nodeOf(view, 'g', 'm1'), (b.x - a.x + 10) * k, (b.y - a.y + 4) * k);
    const dropped = boxOf(view, 'g', 'm1');
    for (const other of ['src', 'm2', 'm3', 'dst']) {
      const o = boxOf(view, 'g', other);
      const apart = dropped.x + dropped.w <= o.x || o.x + o.w <= dropped.x || dropped.y + dropped.h <= o.y || o.y + o.h <= dropped.y;
      expect(apart, `m1 on ${other}`).toBe(true);
    }
  });
});

describe('drilling after the swap review', () => {
  // A double-click drill kept the first click's selection: most of the drilled view opened dimmed.
  it('opens the drilled view with nothing selected', async () => {
    const graph = {level: 'module', nodes: [
      {id: 'typescript/renderers', label: 'renderers', kind: 'cluster', file: 'typescript/renderers/index.ts'},
      {id: 'typescript/core', label: 'core', kind: 'cluster'},
    ], edges: [{from: 'typescript/renderers', to: 'typescript/core'}]};
    const view = renderExpress(`root=Page('T',[g])\ng=Graph(title='Deps',size='l')`, {datasets: 'ready'});
    await screen.findAllByRole('img', {name: /^Graph/});
    view.setData('/ds/deps_modules', {...datasetFixture('deps.modules'), data: graph});
    await drawn(view, 'g', 2);
    click(nodeOf(view, 'g', 'typescript/renderers'));
    expect(view.getData('/ui/sel')).toMatchObject({id: 'typescript/renderers'});
    click(nodeOf(view, 'g', 'typescript/renderers'));
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_drill'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });
});

describe('names after the swap review', () => {
  it('draws a long name whole when the plate has room (nodes are wider, up to 240 px), and leaves out a second line that repeats the frame', async () => {
    const graph = {
      groups: [{id: 'scope', label: 'agents/skills/compliance'}],
      nodes: [
        {id: 'agents/skills/compliance/test_create_compliance_report.py', label: 'test_create_compliance_report.py', sub: 'agents/skills/compliance', kind: 'file', group: 'scope'},
        {id: 'agents/skills/compliance/report.py', label: 'report.py', sub: 'agents/skills/compliance', kind: 'file', group: 'scope'},
        {id: 'agents/shared/io.py', label: 'io.py', sub: 'agents/shared', kind: 'file'},
      ],
      edges: [{from: 'agents/skills/compliance/test_create_compliance_report.py', to: 'agents/skills/compliance/report.py'}, {from: 'agents/skills/compliance/report.py', to: 'agents/shared/io.py'}],
    };
    const view = await open(`root=Page('T',[g])\ng=Graph($/g,title='Files')`, {data: {'/g': graph}, size: {width: 960, height: 600}}, 'g', /^Graph/);
    const texts = (id: string) => [...nodeOf(view, 'g', id).querySelectorAll('text')].map(text => text.textContent);
    expect(texts('agents/skills/compliance/test_create_compliance_report.py')).toEqual(['test_create_compliance_report.py']);
    expect(texts('agents/skills/compliance/report.py')).toEqual(['report.py']);
    // the node outside the frame keeps its second line
    expect(texts('agents/shared/io.py')).toEqual(['io.py', 'agents/shared']);
  });

  // The blast radius of a widely imported file cut every name to about 12 characters with 60% of the plate empty.
  it('shows every name of a fan-in of 12 importers whole in a 722 px plate', async () => {
    const names = ['message-dispatcher.test.ts', 'schema-serializer.ts', 'agent-functions.ts', 'surface-renderer.ts', 'component-registry.ts', 'surface-group-model.ts', 'surface-group-model.test.ts', 'data-context.ts', 'ValidatorConformanceTest.ts', 'CatalogDeriveConformance.ts', 'index.ts', 'test-utils.ts'];
    const graph = {
      level: 'file',
      nodes: [{id: 'core/message-dispatcher.ts', label: 'message-dispatcher.ts', kind: 'file', status: 'modified'}, ...names.map((label, i) => ({id: `dir${i}/${label}`, label, kind: 'file', status: 'affected'}))],
      edges: names.map((label, i) => ({from: `dir${i}/${label}`, to: 'core/message-dispatcher.ts'})),
    };
    const view = await open(`root=Page('T',[g])\ng=Graph($/g,'LR',title='Impact')`, {data: {'/g': graph}, size: {width: 722, height: 700}}, 'g', /^Graph/);
    expect(allInside(view, 'g', 722)).toBe(true);
    for (const id of nodeIds(view, 'g')) {
      const name = nodeOf(view, 'g', id).querySelector('text')!.textContent!;
      expect(name.endsWith('…') || name.includes('…'), `${id}: ${name}`).toBe(false);
    }
  });

  // Two nodes both read 'surface-group-model…' in a file graph.
  it('cuts names that start alike so that they still read apart', () => {
    const tails = tailsOf([
      {id: 'a', label: 'surface-group-model.ts'}, {id: 'b', label: 'surface-group-model.test.ts'}, {id: 'c', label: 'index.ts'}, {id: 'd', label: 'src/state'},
    ]);
    expect(tails.has('c')).toBe(false);
    expect(tails.has('d')).toBe(false);
    const cut = (id: string, label: string) => fitKeepingTail(label, 110, UI_12, tails.get(id)!);
    const a = cut('a', 'surface-group-model.ts');
    const b = cut('b', 'surface-group-model.test.ts');
    expect(a).not.toBe(b);
    expect(a.endsWith('.ts') && b.endsWith('.test.ts')).toBe(true);
    for (const text of [a, b]) expect(textWidth(text, UI_12)).toBeLessThanOrEqual(110);
    // a name that fits is left whole
    expect(fitKeepingTail('model.ts', 110, UI_12, 5)).toBe('model.ts');
  });
});

describe('sequence heads after the swap review', () => {
  const heads = (data: unknown, width: number) => {
    const cleaned = cleanSequence(data);
    if (!cleaned.ok) throw new Error(cleaned.error);
    const plan = planSequence(cleaned.ast, width);
    return plan.actors.map(actor => ({left: actor.x - actor.w / 2, right: actor.x + actor.w / 2, text: actor.text}));
  };

  // Two neighbouring heads shared a border at span 6 (the longer name cut too), and two overlapped by 15 px at 760.
  it('keeps neighbouring participant boxes 16 px apart or more, and their names whole while the plate can hold them', () => {
    const src = {
      actors: {U: 'User', C: 'Desk', R: 'HttpCartRepository', S: 'event channel', D: 'audit journal'},
      steps: [['U', 'C', 'send'], ['C', 'R', 'post message'], ['R', 'S', 'open'], ['S', 'R', 'events', 'reply'], ['R', 'D', 'save'], ['S', 'C', 'tokens', 'reply'], ['C', 'U', 'render', 'reply']],
    };
    for (const width of [616, 694, 1254]) {
      const boxes = heads(src, width);
      for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.left - boxes[i - 1]!.right, `${boxes[i - 1]!.text} | ${boxes[i]!.text} at ${width}`).toBeGreaterThanOrEqual(16);
      expect(boxes.map(box => box.text), `names at ${width}`).toEqual(['User', 'Desk', 'HttpCartRepository', 'event channel', 'audit journal']);
    }
  });
});


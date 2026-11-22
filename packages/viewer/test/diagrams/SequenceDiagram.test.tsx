import {cleanSequence, type SeqAst} from '@glimpse/catalog';
import {fireEvent, screen, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {UI_12, textWidth} from '../../src/components/diagrams/flowkit/index.ts';
import {MAX_SAID, MAX_STEPS, planSequence, wrapWidth} from '../../src/components/diagrams/SequenceDiagram.tsx';
import {buildPatch, buildSurface, renderExpress, renderSpec} from '../harness.tsx';
import {focus, key} from './util.tsx';

// Express data literals, as a model writes them.
const GALLERY = "{steps:[['User','API','POST /login'],['API','Auth','verify(password)'],['Auth','DB','find user'],['DB','Auth','row','reply'],{note:'constant-time compare',over:['Auth','DB']},['Auth','API','token','reply'],['API','User','200','reply']]}";
const spec = (data: string) => `root=Page('T',[s])\ns=SequenceDiagram(${data},title='Seq')`;
const ready = async (data: string) => {
  const view = renderExpress(spec(data));
  await screen.findByRole('img', {name: /^Sequence diagram/});
  return view;
};
const ast = (data: unknown): SeqAst => {
  const cleaned = cleanSequence(data);
  if (!cleaned.ok) throw new Error(cleaned.error);
  return cleaned.ast;
};
/** A JS value written as an Express literal: unquoted keys, single-quoted strings. */
const express = (value: unknown): string =>
  typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : Array.isArray(value) ? `[${value.map(express).join(',')}]`
    : value !== null && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${key}:${express(item)}`).join(',')}}`
    : String(value);
/** Messages A -> B, B -> C, ... between `count + 1` actors P0..Pn. */
const chain = (count: number, label = 'go') => Array.from({length: count}, (_, i) => [`P${i}`, `P${i + 1}`, label]);

describe('SequenceDiagram', () => {
  it('draws actors, lifelines, numbered messages and notes', async () => {
    const view = await ready(GALLERY);
    const cell = view.cell('s');
    expect([...cell.querySelectorAll('[data-actor]')].map(a => a.textContent)).toEqual(['User', 'API', 'Auth', 'DB']);
    const steps = [...cell.querySelectorAll('[data-step]')];
    expect(steps.map(s => s.getAttribute('data-kind'))).toEqual(['message', 'message', 'message', 'message', 'note', 'message', 'message']);
    expect(steps.map(s => s.getAttribute('data-arrow'))).toEqual(['sync', 'sync', 'sync', 'reply', null, 'reply', 'reply']);
    // sequence numbers count messages, not notes
    const texts = (step: Element) => [...step.querySelectorAll('text')].map(t => t.textContent);
    expect(texts(steps[0]!)).toEqual(['1', 'POST /login']);
    expect(texts(steps[5]!)).toEqual(['5', 'token']);
    expect(texts(steps[4]!)).toEqual(['constant-time compare']);
    // a reply is dashed with an open head; a call is solid with a filled one
    const [line, head] = [...steps[3]!.querySelectorAll('path')];
    expect(line!.hasAttribute('data-dashed')).toBe(true);
    expect(head!.getAttribute('d')!.endsWith('Z')).toBe(false);
    expect(steps[0]!.querySelectorAll('path')[0]!.hasAttribute('data-dashed')).toBe(false);
    expect(steps[0]!.querySelectorAll('path')[1]!.getAttribute('d')!.endsWith('Z')).toBe(true);
    // one lifeline per actor in the body, and the actors in their own sticky strip above it
    const [head0, body] = [...cell.querySelectorAll('svg')];
    expect(body!.querySelectorAll(':scope > line')).toHaveLength(4);
    expect(head0!.querySelectorAll('[data-actor]')).toHaveLength(4);
    expect(screen.getByRole('img', {name: /^Sequence diagram/}).getAttribute('aria-label')).toBe('Sequence diagram, 4 participants, 6 messages: User, API, Auth, DB');
    expect(view.errors).toEqual([]);
  });

  it('draws async messages, self-messages and participant labels', async () => {
    const view = await ready("{actors:{W:'Worker'},steps:[['W','Q','enqueue','async'],['Q','Q','dedupe'],{note:'at most once',over:'Q'}]}");
    const cell = view.cell('s');
    expect([...cell.querySelectorAll('[data-actor]')].map(a => a.textContent)).toEqual(['Worker', 'Q']);
    const steps = [...cell.querySelectorAll('[data-step]')];
    expect(steps[0]!.getAttribute('data-arrow')).toBe('async');
    expect(steps[0]!.querySelectorAll('path')[1]!.getAttribute('d')!.endsWith('Z')).toBe(false);
    // the self-message is a loop: it leaves and re-enters the same lifeline
    const loop = steps[1]!.querySelectorAll('path')[0]!.getAttribute('d')!;
    const xs = (loop.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    expect(xs[0]).toBe(xs.at(-2));
    expect(loop).toMatch(/Q/);
    expect(steps[1]!.textContent).toContain('dedupe');
  });

  it('refuses Mermaid text with a redline that says what to write instead', async () => {
    const view = renderExpress(`root=Page('T',[s])\ns=SequenceDiagram($/s,title='Seq')`, {data: {'/s': 'A->>B: ok'}});
    await waitFor(() => expect(view.cell('s').querySelector('[data-code="E_SHAPE"]')).not.toBeNull());
    const text = view.cell('s').querySelector('[data-code="E_SHAPE"]')!.textContent!;
    expect(text).toContain('SequenceDiagram#s');
    expect(text).toContain('SequenceDiagram takes data, not Mermaid text');
    expect(view.cell('s').querySelector('[data-step]')).toBeNull();
  });

  it('draws what it can and tells the model what it left out (W_DROPPED)', async () => {
    const view = renderExpress(`root=Page('T',[s])\ns=SequenceDiagram($/s,title='Seq')`, {data: {'/s': [['A', 'B', 'ok'], {note: 'floating'}]}});
    await waitFor(() => expect(view.stateOf('s')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toBe("SequenceDiagram#s: not drawn: step 2: a note needs over: 'A' or over: ['A', 'B']");
    expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(1);
    expect(view.cell('s').textContent).toContain("1 not drawn: step 2: a note needs over: 'A' or over: ['A', 'B']");
    view.setData('/s', [['A', 'B', 'ok'], {note: 'over A', over: 'A'}]);
    await waitFor(() => expect(view.stateOf('s')).toBe('OK'));
    // an unknown key leaves nothing out: the model hears of it, the reader sees no 'not drawn'
    view.setData('/s', [['A', 'B', 'ok'], {note: 'over A', over: 'A', colour: 'red'}]);
    await waitFor(() => expect(view.stateOf('s')).toBe('W_DROPPED'));
    expect(view.reports.findLast(report => report.code === 'W_DROPPED')!.message).toBe('SequenceDiagram#s: not drawn: ignored note key colour');
    expect(view.cell('s').textContent).not.toContain('not drawn');
  });

  it('shows the empty state without data and follows the binding', async () => {
    const view = renderExpress(`root=Page('T',[s])\ns=SequenceDiagram($/s,title='Seq')`);
    await waitFor(() => expect(view.cell('s').querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/s', [['A', 'B', 'one']]);
    await waitFor(() => expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(1));
    view.setData('/s', {steps: [['A', 'B', 'one'], ['B', 'A', 'two', 'reply'], ['A', 'C', 'three']]});
    await waitFor(() => expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(3));
    expect(view.cell('s').querySelectorAll('[data-actor]')).toHaveLength(3);
    view.setData('/s', {steps: [{opt: 'nothing', steps: []}]});
    await waitFor(() => expect(view.cell('s').querySelector('[data-gl-state="empty"]')!.textContent).toContain('no steps to draw'));
  });

  it('follows a patch that replaces the data', async () => {
    const base = buildSurface('test', spec("[['A','B','hi']]"));
    const view = renderSpec(base);
    await waitFor(() => expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(1));
    view.send(buildPatch('test', base, `s=SequenceDiagram([['X','Y','a'],['Y','X','b','reply']],title='Seq')`));
    await waitFor(() => expect([...view.cell('s').querySelectorAll('[data-actor]')].map(a => a.textContent)).toEqual(['X', 'Y']));
    expect(view.errors).toEqual([]);
  });

  it('is one tab stop: arrows walk the steps and announce them', async () => {
    const view = await ready(GALLERY);
    const stage = screen.getByRole('img', {name: /^Sequence diagram/});
    expect(view.cell('s').querySelectorAll('[tabindex="0"]:not(header)')).toHaveLength(1);
    focus(stage);
    const active = () => view.cell('s').querySelector('[data-step][data-active]')?.getAttribute('data-step');
    const live = () => view.cell('s').querySelector('[aria-live]')!.textContent;
    expect(active()).toBeUndefined();
    key(stage, 'ArrowDown');
    expect(active()).toBe('0');
    expect(live()).toBe('1. User to API: POST /login');
    key(stage, 'ArrowDown');
    key(stage, 'ArrowDown');
    key(stage, 'ArrowDown');
    expect(live()).toBe('4. DB to Auth, reply: row');
    key(stage, 'ArrowDown');
    expect(live()).toBe('Note over Auth, DB: constant-time compare');
    key(stage, 'End');
    expect(active()).toBe('6');
    key(stage, 'ArrowDown');
    expect(active()).toBe('6');
    key(stage, 'Home');
    expect(active()).toBe('0');
    key(stage, 'ArrowUp');
    expect(active()).toBe('0');
    key(stage, 'Escape');
    expect(active()).toBeUndefined();
    expect(key(stage, 'x')).toBe(true);
  });

  it('cuts a 500-character label and keeps the full text for the announcement', async () => {
    const long = 'y'.repeat(500);
    const view = await ready(`[['A','B','${long}']]`);
    const label = view.cell('s').querySelector('[data-step] text:last-of-type')!.textContent!;
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan(120);
    const stage = screen.getByRole('img', {name: /^Sequence diagram/});
    focus(stage);
    key(stage, 'ArrowDown');
    expect(view.cell('s').querySelector('[aria-live]')!.textContent).toContain(long);
  });
});

// Blind-writer measurement: 'alt tokens left … else bucket empty … end' was drawn as one numbered run, so a
// branch that never runs with the other read as if it did.
describe('SequenceDiagram blocks', () => {
  const RATE = {
    actors: {A: 'Agent', S: 'Server', L: 'Limiter'},
    steps: [
      ['A', 'S', 'show'], ['S', 'L', 'take'],
      {alt: 'tokens left', steps: [['L', 'S', 'ok', 'reply'], ['S', 'A', 'rendered', 'reply']], else: [{label: 'bucket empty', steps: [['L', 'S', 'deny', 'reply'], ['S', 'A', 'retry later', 'reply']]}]},
      ['A', 'S', 'next'],
    ],
  };

  it('draws an alt as a labelled frame with a divider, round the steps of its branches only', async () => {
    const view = await ready(express(RATE));
    const cell = view.cell('s');
    const frame = cell.querySelector('[data-frame="alt"]')!;
    expect(frame).not.toBeNull();
    expect([...frame.querySelectorAll('text')].map(t => t.textContent)).toEqual(['alt', '[tokens left]', '[bucket empty]']);
    expect(frame.querySelectorAll('[data-divider]')).toHaveLength(1);
    // the steps stay numbered and navigable; the frame is not a step
    expect(cell.querySelectorAll('[data-step]')).toHaveLength(7);
    const stage = screen.getByRole('img', {name: /^Sequence diagram/});
    focus(stage);
    for (let i = 0; i < 5; i++) key(stage, 'ArrowDown');
    expect(cell.querySelector('[aria-live]')!.textContent).toBe('5. Limiter to Server, reply: deny (alt bucket empty)');
  });

  it('plans the frame from the first step of the block to the last, the divider between the branches', () => {
    const plan = planSequence(ast(RATE), 700);
    const [frame] = plan.frames;
    const rows = plan.rows.filter(row => row.kind === 'message');
    const inside = rows.slice(2, 6);
    expect(frame!.y).toBeLessThan(inside[0]!.y);
    expect(frame!.y).toBeGreaterThan(rows[1]!.y + rows[1]!.h - 1);
    expect(frame!.y + frame!.h).toBeGreaterThan(inside[3]!.y + inside[3]!.h - 1);
    expect(frame!.y + frame!.h).toBeLessThan(rows[6]!.y);
    expect(frame!.dividers[0]!.y).toBeGreaterThan(inside[1]!.y + inside[1]!.h - 1);
    expect(frame!.dividers[0]!.y).toBeLessThan(inside[2]!.y);
    // it holds the lifelines its steps use, with room to spare, inside the drawing
    const [a, , l] = plan.actors.map(actor => actor.x);
    expect(frame!.x).toBeLessThan(a!);
    expect(frame!.x + frame!.w).toBeGreaterThan(l!);
    expect(frame!.x).toBeGreaterThanOrEqual(0);
    expect(frame!.x + frame!.w).toBeLessThanOrEqual(plan.width);
  });

  it('nests frames inside their parent', () => {
    const plan = planSequence(ast([['A', 'B', 'x'], {loop: 'every 5s', steps: [['A', 'B', 'poll'], {opt: 'changed', steps: [['B', 'A', 'rows', 'reply']]}]}, {alt: 'broken', steps: [['A', 'B', 'y']]}]), 600);
    const [loop, opt, alt] = plan.frames;
    expect([loop!.op, opt!.op, alt!.op]).toEqual(['loop', 'opt', 'alt']);
    expect(opt!.depth).toBe(1);
    expect(opt!.x).toBeGreaterThan(loop!.x);
    expect(opt!.x + opt!.w).toBeLessThan(loop!.x + loop!.w);
    expect(opt!.y + opt!.h).toBeLessThan(loop!.y + loop!.h);
    expect(alt!.h).toBeGreaterThan(30);
    expect(plan.height).toBeGreaterThan(alt!.y + alt!.h);
  });
});

describe('planSequence', () => {
  // Blind-writer measurement: 'auth-flow-2026-11-20.html' was cut to 'auth-flow-202…' between two lifelines of a
  // span=7 plate: a label of one word cannot take a second line, so its gap needs all of it.
  it('keeps a one-word label whole: its gap is as wide as the word', () => {
    const src = {
      actors: {U: 'User', V: 'Viewer tab', S: 'ExportService', B: 'SnapshotBuilder', R: 'Source resolvers'},
      steps: [
        ['U', 'V', 'click Export'], ['V', 'S', 'POST /api/export viewId'], ['S', 'B', 'build(view spec)'], ['B', 'R', 'resolve each data ref'],
        ['R', 'B', 'rows', 'reply'], ['B', 'S', 'spec + data snapshot', 'reply'], ['S', 'S', 'inline runtime.js, css, snapshot'],
        ['S', 'V', 'auth-flow-2026-11-20.html', 'reply'], ['V', 'U', 'download', 'reply'],
      ],
    };
    for (const width of [722, 600]) {
      const plan = planSequence(ast(src), width);
      for (const row of plan.rows) if (row.kind === 'message') expect(row.lines.join(' '), `at ${width}`).toBe(row.full);
    }
    expect(wrapWidth('auth-flow-2026-11-20.html')).toBe(Math.ceil(textWidth('auth-flow-2026-11-20.html', UI_12)));
    expect(wrapWidth('POST /api/export viewId')).toBeGreaterThanOrEqual(Math.ceil(textWidth('POST /api/export', UI_12)));
  });

  it('keeps lifelines at least 140 px apart and widens a gap for the label that crosses it', () => {
    const plan = planSequence(ast([['A', 'B', 'hi'], ['B', 'C', 'a label that is clearly longer than the minimum column']]), 0);
    const [a, b, c] = plan.actors.map(actor => actor.x);
    expect(b! - a!).toBe(140);
    // the label wants more than a lifeline may have: the gap stops at 280 and the label takes a second line (V014)
    expect(c! - b!).toBe(280);
    const row = plan.rows[1]!;
    expect(row.kind === 'message' && row.lines).toEqual(['a label that is clearly longer than the', 'minimum column']);
    expect(row.h).toBeGreaterThan(plan.rows[0]!.h);
    expect(plan.width).toBeGreaterThan(c!);
  });

  it('wraps a label to two lines in a narrow plate instead of cutting it (V014)', () => {
    const five = ast([['Model', 'Server', 'show(spec)'], ['Server', 'Parser', 'parse A2UI Express spec'], ['Parser', 'Server', 'parts and data bindings', 'reply'], ['Server', 'Sources', 'run every bound source'], ['Server', 'Model', 'ok plus one line per dataset', 'reply']]);
    // From a span=7 plate of a 1440 px page (where the review saw 'parse A2UI Ex…') down to a phone: every label whole.
    for (const width of [700, 520, 420, 360]) {
      const plan = planSequence(five, width);
      for (const row of plan.rows) {
        if (row.kind !== 'message') continue;
        expect(row.lines.join(' ')).toBe(row.full);
        expect(row.lines.length).toBeLessThanOrEqual(2);
      }
    }
    const narrow = planSequence(five, 520);
    expect(narrow.rows.find(row => row.kind === 'message' && row.full === 'parse A2UI Express spec')).toMatchObject({lines: ['parse A2UI', 'Express spec']});
  });

  it('stretches a narrow diagram to its container and scrolls a wide one', () => {
    const narrow = planSequence(ast([['A', 'B', 'hi']]), 900);
    expect(narrow.width).toBe(900);
    expect(narrow.actors[1]!.x - narrow.actors[0]!.x).toBe(280);
    // centred
    expect(narrow.actors[0]!.x + narrow.actors[1]!.x).toBeCloseTo(900, -1);
    const wide = planSequence(ast(chain(12)), 600);
    // thirteen lifelines cannot be had in 600 px: the gaps close up to 95 px and the rest scrolls
    expect(wide.actors[1]!.x - wide.actors[0]!.x).toBe(95);
    expect(wide.width * wide.scale).toBeGreaterThan(600);
  });

  it('fits a cell that is a little too narrow: gaps close up first, then the drawing is scaled, never below 10 px text', () => {
    const six = ast([['User', 'Agent', 'ask'], ['Agent', 'Server', 'show'], ['Server', 'Sources', 'run'], ['Sources', 'Server', 'rows', 'reply'], ['Server', 'Viewer', 'frame'], ['Viewer', 'Hub', 'event'], ['Hub', 'User', 'done', 'reply']]);
    const natural = planSequence(six, 0);
    expect(natural.scale).toBe(1);
    expect(natural.actors[1]!.x - natural.actors[0]!.x).toBe(140);
    expect(natural.width).toBe(5 * 140 + 2 * 76);

    // 60 px short: closing the gaps is enough, nothing is scaled and nothing scrolls
    const snug = planSequence(six, natural.width - 60);
    expect(snug.scale).toBe(1);
    expect(snug.width).toBe(natural.width - 60);
    expect(snug.actors[1]!.x - snug.actors[0]!.x).toBeLessThan(140);
    expect(snug.actors[1]!.x - snug.actors[0]!.x).toBeGreaterThanOrEqual(95);

    // span=5 of a 1440 px page: the case from the review, six lifelines in 510 px
    const narrow = planSequence(six, 510);
    expect(narrow.scale).toBeLessThan(1);
    // 11 px step numbers and notes stay 10 px on screen (design rule D18): the rest scrolls
    expect(narrow.scale).toBeGreaterThanOrEqual(10 / 11);

    // far too narrow: the floor, and the rest scrolls
    const tiny = planSequence(six, 300);
    expect(tiny.scale).toBe(0.91);
    expect(tiny.width * tiny.scale).toBeGreaterThan(300);
  });

  it('gives a self-message on the last lifeline room on the right', () => {
    const plan = planSequence(ast([['A', 'B', 'hi'], ['B', 'B', 'think about it for a while']]), 0);
    const self = plan.rows[1]!;
    expect(self.kind === 'message' && self.lines).toEqual(['think about it for a while']);
    expect(plan.width - plan.actors[1]!.x).toBeGreaterThan(150);
  });

  it('wraps long notes and caps the number of steps drawn', () => {
    const plan = planSequence(ast([['A', 'B', 'hi'], {note: 'word '.repeat(60), over: 'A'}]), 0);
    const note = plan.rows[1]!;
    expect(note.kind === 'note' && note.lines.length).toBe(4);
    const many = planSequence(ast(Array.from({length: MAX_STEPS + 25}, () => ['A', 'B', 'tick'])), 0);
    expect(many.rows).toHaveLength(MAX_STEPS);
    expect(many.hidden).toBe(25);
  });

  it('frames a block from the outermost lifeline it holds, an inner block inside its outer one', () => {
    const plan = planSequence(ast([['A', 'B', 'x'], {opt: 'o', steps: [['B', 'C', 'y'], {loop: 'l', steps: [['B', 'C', 'z']]}]}]), 0);
    const [opt, loop] = plan.frames;
    const [, b, c] = plan.actors.map(actor => actor.x);
    expect(opt!.x).toBeLessThan(b!);
    expect(opt!.x + opt!.w).toBeGreaterThan(c!);
    expect(loop!.x).toBeGreaterThan(opt!.x);
    expect(loop!.x + loop!.w).toBeLessThan(opt!.x + opt!.w);
    // the rows of the block sit inside its frame, under its tab
    const inBlock = plan.rows.filter(row => row.kind === 'message' && ['y', 'z'].includes(row.full));
    for (const row of inBlock) {
      expect(row.y).toBeGreaterThan(opt!.y);
      expect(row.y + row.h).toBeLessThan(opt!.y + opt!.h);
    }
  });
});

// Decision D20: a sequence diagram is as tall as its steps, up to the plate's maximum height; past that it scrolls.
describe('SequenceDiagram: content-sized', () => {
  it.each([
    ['no size: the diagram family\'s 640 px', '', 640],
    ['size m: 280 px', ",size='m'", 280],
    ['size s: 160 px', ",size='s'", 160],
  ])('takes %s as its maximum height', async (_name, size, cap) => {
    const view = renderExpress(`root=Page('T',[s])\ns=SequenceDiagram(${GALLERY},title='Seq'${size})`);
    const scroll = await screen.findByRole('img', {name: /^Sequence diagram/});
    expect(scroll.style.maxHeight).toBe(`${cap}px`);
    // no fixed height of its own: as tall as its steps up to that
    expect(scroll.style.height).toBe('');
    expect(view.errors).toEqual([]);
  });
});

// Decision D24: a message is selectable; it stands for the nodes it passes, so the diagrams it crosses light its path.
describe('SequenceDiagram: selection and traces', () => {
  const TRACE = "{actors:{U:'User',G:{label:'Gateway',node:'GW'},I:'Inv'},steps:[['U','G','checkout'],{from:'G',to:'I',label:'hold',via:['Q']},{note:'idempotent',over:'I'},['I','G','ok','reply'],['U','I','direct'],['U','G','retry']]}";
  type View = Awaited<ReturnType<typeof ready>>;
  const rows = (view: View, flag: string) => [...view.cell('s').querySelectorAll(`[data-step][${flag}]`)].map(step => Number(step.getAttribute('data-step')));
  const heads = (view: View) => [...view.cell('s').querySelectorAll('[data-actor][data-selected]')].map(actor => actor.getAttribute('data-actor'));
  const step = (view: View, i: number) => view.cell('s').querySelector(`[data-step="${i}"] rect`)!;

  it('selects a clicked message as the path it takes, and marks only its own row', async () => {
    const view = await ready(TRACE);
    fireEvent.click(step(view, 1));
    expect(view.getData('/ui/sel')).toEqual({type: 'message', id: 's:2', label: '2. Gateway to Inv: hold', nodes: ['GW', 'Q', 'I']});
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 's', context: {ref: {type: 'message', id: 's:2'}}});
    expect(rows(view, 'data-active')).toEqual([1]);
    expect(rows(view, 'data-selected')).toEqual([1]);
    expect(heads(view)).toEqual(['G', 'I']);
    expect(rows(view, 'data-dim')).toEqual([]);
    // messages 1 and 5 take the same path; within its own diagram a selected message marks only its row
    fireEvent.click(step(view, 0));
    expect(view.getData('/ui/sel')).toMatchObject({id: 's:1', nodes: ['U', 'GW']});
    expect(rows(view, 'data-selected')).toEqual([0]);
    // a note moves the keyboard's row, not the selection; empty space changes nothing
    fireEvent.click(step(view, 2));
    expect(rows(view, 'data-active')).toEqual([2]);
    expect(view.getData('/ui/sel')).toMatchObject({id: 's:1'});
    fireEvent.click(view.cell('s').querySelectorAll('svg')[1]!);
    expect(view.getData('/ui/sel')).toMatchObject({id: 's:1'});
  });

  it('selects as the keyboard steps onto a message, keeps it on a note, and clears it with Escape', async () => {
    const view = await ready(TRACE);
    const stage = screen.getByRole('img', {name: /^Sequence diagram/});
    focus(stage);
    key(stage, 'ArrowDown');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'message', id: 's:1', nodes: ['U', 'GW']});
    key(stage, 'ArrowDown');
    expect(view.getData('/ui/sel')).toMatchObject({id: 's:2', nodes: ['GW', 'Q', 'I']});
    key(stage, 'ArrowDown');
    expect(rows(view, 'data-active')).toEqual([2]);
    expect(view.getData('/ui/sel')).toMatchObject({id: 's:2'});
    expect(rows(view, 'data-selected')).toEqual([1]);
    key(stage, 'ArrowDown');
    expect(view.getData('/ui/sel')).toEqual({type: 'message', id: 's:3', label: '3. Inv to Gateway, reply: ok', nodes: ['I', 'GW']});
    expect(view.actions.filter(action => action.name === 'gl_select')).toHaveLength(3);
    key(stage, 'Escape');
    expect(view.getData('/ui/sel') ?? null).toBeNull();
    expect(rows(view, 'data-active')).toEqual([]);
    expect(rows(view, 'data-selected')).toEqual([]);
  });

  it('marks the messages and actors that touch a node selected elsewhere, and dims the rest', async () => {
    const view = await ready(TRACE);
    view.setData('/ui/sel', {type: 'node', id: 'GW', label: 'Gateway'});
    expect(rows(view, 'data-selected')).toEqual([0, 1, 3, 5]);
    expect(rows(view, 'data-dim')).toEqual([2, 4]);
    expect(heads(view)).toEqual(['G']);
    // a message of another diagram lights the messages that pass every node it names
    view.setData('/ui/sel', {type: 'message', id: 'other:1', label: '1. Web to Gateway: go', nodes: ['U', 'GW']});
    expect(rows(view, 'data-selected')).toEqual([0, 5]);
    expect(heads(view)).toEqual(['U', 'G']);
    expect(rows(view, 'data-active')).toEqual([]);
    view.setData('/ui/sel', null);
    expect(rows(view, 'data-selected')).toEqual([]);
    expect(rows(view, 'data-dim')).toEqual([]);
  });

  it('selects an actor\'s node from its head', async () => {
    const view = await ready(TRACE);
    fireEvent.click(view.cell('s').querySelector('[data-actor="G"] rect')!);
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'GW', label: 'Gateway'});
    fireEvent.click(view.cell('s').querySelector('[data-actor="U"] rect')!);
    expect(view.getData('/ui/sel')).toEqual({type: 'node', id: 'U', label: 'User'});
    expect(heads(view)).toEqual(['U']);
  });

  it('moves to a restored selection, and marks no row for one a patch left stale', async () => {
    const view = await ready(TRACE);
    view.setData('/ui/sel', {type: 'message', id: 's:4', label: '4. User to Inv: direct', nodes: ['U', 'I']});
    await waitFor(() => expect(rows(view, 'data-active')).toEqual([4]));
    expect(rows(view, 'data-selected')).toEqual([4]);
    expect(heads(view)).toEqual(['U', 'I']);
    expect(view.cell('s').querySelector('[aria-live]')!.textContent).toBe('4. User to Inv: direct');
    // the messages were renumbered by a patch: number 4 now says something else
    view.setData('/ui/sel', {type: 'message', id: 's:4', label: '4. User to Inv: gone', nodes: ['U', 'I']});
    expect(rows(view, 'data-selected')).toEqual([]);
    expect(rows(view, 'data-dim')).toEqual([]);
    expect(heads(view)).toEqual([]);
  });

  // The server keeps no label over 1,024 characters: the selection names a long message by its first words.
  it('selects a long message by a cut label, and restores it from that label', async () => {
    const long = 'x'.repeat(1100);
    const view = await ready(`{steps:[['A','B','${long}'],['B','A','ok','reply']]}`);
    fireEvent.click(view.cell('s').querySelector('[data-step="0"] rect')!);
    const sel = view.getData('/ui/sel') as {label: string};
    expect(sel.label).toHaveLength(MAX_SAID);
    expect(sel.label).toBe(`1. A to B: ${long}`.slice(0, MAX_SAID - 1) + '…');
    // a reload: the selection comes back from the server with that label
    view.setData('/ui/sel', null);
    view.setData('/ui/sel', {...sel});
    await waitFor(() => expect(rows(view, 'data-active')).toEqual([0]));
    expect(rows(view, 'data-selected')).toEqual([0]);
    expect(heads(view)).toEqual(['A', 'B']);
    // what the row says aloud is still all of it
    expect(view.cell('s').querySelector('[aria-live]')!.textContent).toBe(`1. A to B: ${long}`);
  });
});

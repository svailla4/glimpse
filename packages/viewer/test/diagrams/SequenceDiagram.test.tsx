import {parseSequence, type SeqAst} from '@glimpse/catalog';
import {screen, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {MAX_STEPS, planSequence} from '../../src/components/diagrams/SequenceDiagram.tsx';
import {buildPatch, buildSurface, renderExpress, renderSpec} from '../harness.tsx';
import {focus, key} from './util.tsx';

const GALLERY = 'User->>API: POST /login; API->>Auth: verify(password); Auth->>DB: find user; DB-->>Auth: row; Note over Auth,DB: constant-time compare; Auth-->>API: token; API-->>User: 200';
const spec = (src: string) => `root=Page('T',[s])\ns=SequenceDiagram('${src}',title='Seq')`;
const ready = async (src: string) => {
  const view = renderExpress(spec(src));
  await screen.findByRole('img', {name: /^Sequence diagram/});
  return view;
};
const ast = (src: string): SeqAst => {
  const parsed = parseSequence(src);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.ast;
};

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
    const view = await ready('participant W as Worker\nW-)Q: enqueue\nQ->>Q: dedupe\nNote over Q: at most once');
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

  it('shows a redline with the statement for a parse error', async () => {
    const view = renderExpress(spec('A->>B: ok; B ~~ C; ->>D: no sender'));
    await waitFor(() => expect(view.cell('s').querySelector('[data-code="E_NOTATION"]')).not.toBeNull());
    const text = view.cell('s').querySelector('[data-code="E_NOTATION"]')!.textContent!;
    expect(text).toContain('SequenceDiagram#s');
    expect(text).toMatch(/statement 2: expected "A->>B: text"/);
    expect(text).toMatch(/statement 3: /);
    expect(view.cell('s').querySelector('[data-step]')).toBeNull();
  });

  it('shows the empty state without a source and follows the binding', async () => {
    const view = renderExpress(`root=Page('T',[s])\ns=SequenceDiagram($/src,title='Seq')`);
    await waitFor(() => expect(view.cell('s').querySelector('[data-gl-state="empty"]')!.textContent).toBe('no sequence source'));
    view.setData('/src', 'A->>B: one');
    await waitFor(() => expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(1));
    view.setData('/src', 'A->>B: one\nB-->>A: two\nA->>C: three');
    await waitFor(() => expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(3));
    expect(view.cell('s').querySelectorAll('[data-actor]')).toHaveLength(3);
    view.setData('/src', '');
    await waitFor(() => expect(view.cell('s').querySelector('[data-gl-state="empty"]')).not.toBeNull());
  });

  it('follows a patch that replaces the source', async () => {
    const base = buildSurface('test', spec('A->>B: hi'));
    const view = renderSpec(base);
    await waitFor(() => expect(view.cell('s').querySelectorAll('[data-step]')).toHaveLength(1));
    view.send(buildPatch('test', base, `s=SequenceDiagram('X->>Y: a; Y-->>X: b',title='Seq')`));
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
    const view = await ready(`A->>B: ${long}`);
    const label = view.cell('s').querySelector('[data-step] text:last-of-type')!.textContent!;
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan(120);
    const stage = screen.getByRole('img', {name: /^Sequence diagram/});
    focus(stage);
    key(stage, 'ArrowDown');
    expect(view.cell('s').querySelector('[aria-live]')!.textContent).toContain(long);
  });
});

describe('planSequence', () => {
  it('keeps lifelines at least 140 px apart and widens a gap for the label that crosses it', () => {
    const plan = planSequence(ast('A->>B: hi; B->>C: a label that is clearly longer than the minimum column'), 0);
    const [a, b, c] = plan.actors.map(actor => actor.x);
    expect(b! - a!).toBe(140);
    // the label wants more than a lifeline may have: the gap stops at 280 and the label is cut
    expect(c! - b!).toBe(280);
    const row = plan.rows[1]!;
    expect(row.kind === 'message' && row.text.endsWith('…')).toBe(true);
    expect(plan.width).toBeGreaterThan(c!);
  });

  it('stretches a narrow diagram to its container and scrolls a wide one', () => {
    const narrow = planSequence(ast('A->>B: hi'), 900);
    expect(narrow.width).toBe(900);
    expect(narrow.actors[1]!.x - narrow.actors[0]!.x).toBe(280);
    // centred
    expect(narrow.actors[0]!.x + narrow.actors[1]!.x).toBeCloseTo(900, -1);
    const wide = planSequence(ast(Array.from({length: 12}, (_, i) => `P${i}->>P${i + 1}: go`).join('; ')), 600);
    expect(wide.width).toBeGreaterThan(13 * 140);
  });

  it('gives a self-message on the last lifeline room on the right', () => {
    const plan = planSequence(ast('A->>B: hi; B->>B: think about it for a while'), 0);
    const self = plan.rows[1]!;
    expect(self.kind === 'message' && self.text).toBe('think about it for a while');
    expect(plan.width - plan.actors[1]!.x).toBeGreaterThan(150);
  });

  it('wraps long notes and caps the number of steps drawn', () => {
    const plan = planSequence(ast(`A->>B: hi; Note over A: ${'word '.repeat(60)}`), 0);
    const note = plan.rows[1]!;
    expect(note.kind === 'note' && note.lines.length).toBe(4);
    const many = planSequence(ast(Array.from({length: MAX_STEPS + 25}, () => 'A->>B: tick').join('\n')), 0);
    expect(many.rows).toHaveLength(MAX_STEPS);
    expect(many.hidden).toBe(25);
  });
});

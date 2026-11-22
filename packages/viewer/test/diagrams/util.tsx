// Shared helpers for the diagram tests: ELK in-process instead of the worker, the DOM React Flow needs under jsdom, a
// fake storage, and readers for the drawn diagram (nodes, edges, the viewport).
//
// Importing this file sets every test of the file up: ELK answers in-process through the page's own worker protocol
// (configureElkWorker, decision diagram-engine-in-worker), each test starts with no remembered layouts, and jsdom gets DOMMatrixReadOnly
// (React Flow reads the viewport's zoom through it when it measures a node).
import {act, fireEvent, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach} from 'vitest';
import {clearLayoutCache, configureElkWorker} from '../../src/components/diagrams/flowkit/index.ts';
import type {RenderedSpec} from '../harness.tsx';
import {inProcessElk, type InProcessElk} from './elk.ts';

if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class Matrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; m11 = 1; m12 = 0; m21 = 0; m22 = 1; m41 = 0; m42 = 0;
    constructor(transform?: string) {
      const scale = /scale\((-?[\d.]+)/.exec(transform ?? '');
      if (scale) this.a = this.d = this.m11 = this.m22 = Number(scale[1]);
    }
  }
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {configurable: true, writable: true, value: Matrix});
}

/** The in-process ELK of the running test: its `requests` are what the page asked the worker for. */
export let elk: InProcessElk;
beforeEach(() => {
  clearLayoutCache();
  elk = inProcessElk();
  configureElkWorker(() => elk);
});
afterEach(() => configureElkWorker(undefined));

export interface FakeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** What is stored right now. */
  readonly items: Map<string, string>;
}
export function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const items = new Map(Object.entries(initial));
  return {items, getItem: key => items.get(key) ?? null, setItem: (key, value) => void items.set(key, String(value))};
}

/** The stage of a node-link diagram: its focusable role="img" element, one tab stop. */
export function stageOf(view: RenderedSpec, componentId: string): HTMLElement {
  const stage = view.cell(componentId).querySelector<HTMLElement>('[role="img"][tabindex="0"]');
  if (!stage) throw new Error(`no diagram stage in "${componentId}"`);
  return stage;
}

/** Testing Library queries inside an SVG element (its types only know HTML elements). */
export const inside = (element: Element) => within(element as unknown as HTMLElement);

/** The drawing of a node: the <g data-node> in the node's own SVG. */
export function nodeOf(view: RenderedSpec, componentId: string, nodeId: string): SVGGElement {
  const node = [...view.cell(componentId).querySelectorAll<SVGGElement>('[data-node]')].find(el => el.getAttribute('data-node') === nodeId);
  if (!node) throw new Error(`no node "${nodeId}" in "${componentId}"`);
  return node;
}
export const nodeIds = (view: RenderedSpec, componentId: string): string[] =>
  [...view.cell(componentId).querySelectorAll('[data-node]')].map(el => el.getAttribute('data-node')!);
/** React Flow's wrapper of a node: what takes clicks and drags. */
export const wrapperOf = (node: Element): HTMLElement => node.closest<HTMLElement>('.react-flow__node')!;

export function edgeOf(view: RenderedSpec, componentId: string, edge: string): SVGGElement {
  const found = [...view.cell(componentId).querySelectorAll<SVGGElement>('[data-edge]')].find(el => el.getAttribute('data-edge') === edge);
  if (!found) throw new Error(`no edge "${edge}" in "${componentId}"`);
  return found;
}
/** The `d` of the visible line of an edge (the second path; the first is the hover target). */
export const lineOf = (edge: Element): string => edge.querySelectorAll('path')[1]?.getAttribute('d') ?? '';
/** Corner and end points of a path made of M, L and Q commands (control points included). */
export const pointsOf = (d: string): Array<[number, number]> => {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) out.push([numbers[i]!, numbers[i + 1]!]);
  return out;
};

/** Top-left corner of a node in diagram coordinates, from its React Flow wrapper. */
export function positionOf(node: Element): {x: number; y: number} {
  const wrapper = wrapperOf(node);
  // jsdom writes translate(x, 0) as translate(x)
  const m = /translate\((-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\)/.exec(wrapper?.style.transform ?? '');
  if (!m) throw new Error(`the node has no translate(): "${wrapper?.style.transform}"`);
  return {x: Number(m[1]), y: Number(m[2] ?? 0)};
}

/** Width and height of a node: its SVG's size. */
export function sizeOf(node: Element): {w: number; h: number} {
  const svg = node.closest('svg');
  if (!svg) throw new Error('the node draws no svg');
  return {w: Number(svg.getAttribute('width')), h: Number(svg.getAttribute('height'))};
}

/** Pan and zoom of a stage, from React Flow's viewport transform. */
export function viewOf(stage: Element): {x: number; y: number; k: number} {
  const viewport = stage.querySelector<HTMLElement>('.react-flow__viewport');
  const m = /translate\((-?[\d.e-]+)px(?:,\s*(-?[\d.e-]+)px)?\)\s*scale\((-?[\d.e-]+)\)/.exec(viewport?.style.transform ?? '');
  if (!m) throw new Error(`no viewport transform: "${viewport?.style.transform}"`);
  return {x: Number(m[1]), y: Number(m[2] ?? 0), k: Number(m[3])};
}

/** Height of the drawing area (decision content-sized-plates): the stage's sized parent. */
export function stageHeight(stage: Element): number {
  return Number.parseFloat((stage.parentElement as HTMLElement).style.height);
}

/** Where a node is on the stage, in stage pixels: its box under the current pan and zoom. */
export function onStage(stage: Element, node: Element): {left: number; top: number; right: number; bottom: number} {
  const view = viewOf(stage);
  const at = positionOf(node);
  const {w, h} = sizeOf(node);
  return {left: at.x * view.k + view.x, top: at.y * view.k + view.y, right: (at.x + w) * view.k + view.x, bottom: (at.y + h) * view.k + view.y};
}

/** True when the point lies on the outline of the node (within a pixel). */
export function onOutline(point: readonly [number, number] | undefined, node: Element, slack = 1): boolean {
  if (!point) return false;
  const at = positionOf(node);
  const {w, h} = sizeOf(node);
  const [x, y] = point;
  const inBox = x >= at.x - slack && x <= at.x + w + slack && y >= at.y - slack && y <= at.y + h + slack;
  const edge = Math.min(Math.abs(x - at.x), Math.abs(x - at.x - w), Math.abs(y - at.y), Math.abs(y - at.y - h));
  return inBox && edge <= slack;
}

/** A mouse event whose `view` is the window: d3-drag listens for the rest of a drag on `event.view`. */
function mouse(type: string, target: EventTarget, init: MouseEventInit): void {
  const event = new MouseEvent(type, {bubbles: true, cancelable: true, ...init});
  Object.defineProperty(event, 'view', {value: window});
  act(() => {
    target.dispatchEvent(event);
  });
}

/**
 * Drags a node's wrapper by (dx, dy) screen px the way React Flow sees a mouse drag (d3-drag on the window). React Flow
 * starts the drag once the pointer has moved past its threshold and moves the node from there: the first step is that
 * start, the node then moves by (dx, dy). The pointer starts in the middle of the 960 x 600 stage, away from the edges
 * where React Flow pans the stage along with a dragged node.
 */
export async function drag(node: Element, dx: number, dy: number, from = {x: 480, y: 300}): Promise<void> {
  const target = wrapperOf(node);
  mouse('mousedown', target, {button: 0, buttons: 1, clientX: from.x, clientY: from.y});
  const start = {x: from.x + 6, y: from.y};
  // Moves and the release bubble from the node to the window, where d3-drag listens once the drag started.
  mouse('mousemove', target, {buttons: 1, clientX: start.x, clientY: start.y});
  for (const t of [0.25, 0.5, 0.75, 1]) mouse('mousemove', target, {buttons: 1, clientX: start.x + dx * t, clientY: start.y + dy * t});
  mouse('mouseup', target, {button: 0, clientX: start.x + dx, clientY: start.y + dy});
  // The click a browser sends after a press and release on the same element; the drag swallows it, until the next task.
  mouse('click', target, {button: 0, clientX: start.x + dx, clientY: start.y + dy});
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

/** A click on a node (or anything inside it), as the browser delivers one. */
export function click(target: Element, init: {metaKey?: boolean; ctrlKey?: boolean} = {}): void {
  fireEvent.click(target, {button: 0, ...init});
}

export function focus(element: Element): void {
  act(() => (element as HTMLElement).focus());
}
export const key = (element: Element, k: string, init: {shiftKey?: boolean; altKey?: boolean} = {}): boolean => fireEvent.keyDown(element, {key: k, ...init});

/** Waits until the diagram of `componentId` is drawn with `count` nodes. */
export async function drawn(view: RenderedSpec, componentId: string, count?: number): Promise<void> {
  await waitFor(() => {
    const ids = nodeIds(view, componentId);
    if (count === undefined ? ids.length === 0 : ids.length !== count) throw new Error(`${ids.length} nodes drawn`);
  }, {timeout: 20_000});
}

/**
 * A module graph the way a repository gives one: `layers` ranks of `perLayer` modules, every module importing two
 * of the next rank and one two ranks on. Acyclic, so its depth is `layers`.
 */
export function layeredGraph(layers: number, perLayer: number): {nodes: Array<{id: string; label: string; sub: string; kind: string}>; edges: Array<{from: string; to: string; weight: number}>} {
  const id = (layer: number, i: number) => `pkg/l${layer}/m${i}`;
  const nodes = Array.from({length: layers * perLayer}, (_, n) => ({id: id(Math.floor(n / perLayer), n % perLayer), label: `l${Math.floor(n / perLayer)}/m${n % perLayer}`, sub: `${n + 3} files`, kind: 'cluster'}));
  const edges: Array<{from: string; to: string; weight: number}> = [];
  for (let layer = 0; layer + 1 < layers; layer++) {
    for (let i = 0; i < perLayer; i++) {
      edges.push({from: id(layer, i), to: id(layer + 1, i), weight: 5}, {from: id(layer, i), to: id(layer + 1, (i + 1) % perLayer), weight: 2});
      if (layer + 2 < layers) edges.push({from: id(layer, i), to: id(layer + 2, (i + 2) % perLayer), weight: 1});
    }
  }
  return {nodes, edges};
}

/** A deterministic graph of `nodes` nodes and about `edges` distinct edges. */
export function bigGraph(nodes: number, edges: number): {nodes: Array<{id: string; label: string; sub: string; kind?: string; group?: string}>; edges: Array<{from: string; to: string; weight: number}>} {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out = {nodes: Array.from({length: nodes}, (_, i) => ({id: `n${i}`, label: `module ${i}`, sub: `${i} files`})), edges: [] as Array<{from: string; to: string; weight: number}>};
  const seen = new Set<string>();
  while (out.edges.length < edges) {
    const a = Math.floor(random() * nodes);
    const b = Math.floor(random() * nodes);
    if (a === b || seen.has(`${a}-${b}`)) continue;
    seen.add(`${a}-${b}`);
    out.edges.push({from: `n${a}`, to: `n${b}`, weight: 1 + Math.floor(random() * 9)});
  }
  return out;
}

/** True when an orthogonal route enters the inside of `box` (more than `slack` px past its border). */
export function crosses(points: ReadonlyArray<{x: number; y: number}>, box: {x: number; y: number; w: number; h: number}, slack = 1): boolean {
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    if (Math.max(p.x, q.x) > box.x + slack && Math.min(p.x, q.x) < box.x + box.w - slack && Math.max(p.y, q.y) > box.y + slack && Math.min(p.y, q.y) < box.y + box.h - slack) return true;
  }
  return false;
}

/** True when two routes share a stretch of line: collinear segments overlapping by more than 2 px. */
export function runsAlong(a: ReadonlyArray<{x: number; y: number}>, b: ReadonlyArray<{x: number; y: number}>): boolean {
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, t] = [a[i - 1]!, a[i]!, b[j - 1]!, b[j]!];
      const vertical = Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - t.x) < 0.5 && Math.abs(p.x - r.x) < 2;
      const horizontal = Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - t.y) < 0.5 && Math.abs(p.y - r.y) < 2;
      const span = (u: number, v: number, w: number, z: number) => Math.min(Math.max(u, v), Math.max(w, z)) - Math.max(Math.min(u, v), Math.min(w, z));
      if (vertical && span(p.y, q.y, r.y, t.y) > 2) return true;
      if (horizontal && span(p.x, q.x, r.x, t.x) > 2) return true;
    }
  }
  return false;
}

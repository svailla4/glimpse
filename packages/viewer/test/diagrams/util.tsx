// Shared helpers for the diagram tests: pointer gestures on the fake layout, a fake storage, DOM readers.
import {act, fireEvent, within} from '@testing-library/react';
import type {RenderedSpec} from '../harness.tsx';

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

/** The stage of a node-link diagram: its focusable <svg role="img">. */
export function stageOf(view: RenderedSpec, componentId: string): SVGSVGElement {
  const svg = view.cell(componentId).querySelector<SVGSVGElement>('svg[role="img"]');
  if (!svg) throw new Error(`no diagram stage in "${componentId}"`);
  return svg;
}

/** Testing Library queries inside an SVG element (its types only know HTML elements). */
export const inside = (element: Element) => within(element as unknown as HTMLElement);

export function nodeOf(view: RenderedSpec, componentId: string, nodeId: string): SVGGElement {
  const node = [...view.cell(componentId).querySelectorAll<SVGGElement>('[data-node]')].find(el => el.getAttribute('data-node') === nodeId);
  if (!node) throw new Error(`no node "${nodeId}" in "${componentId}"`);
  return node;
}
export const nodeIds = (view: RenderedSpec, componentId: string): string[] =>
  [...view.cell(componentId).querySelectorAll('[data-node]')].map(el => el.getAttribute('data-node')!);

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

/** A touch as the stage sees it. */
export function touch(type: 'pointerDown' | 'pointerMove' | 'pointerUp', target: Element, pointerId: number, x: number, y: number): void {
  fireEvent[type](target, {pointerType: 'touch', pointerId, button: 0, buttons: type === 'pointerUp' ? 0 : 1, clientX: x, clientY: y});
};

export function positionOf(node: Element): {x: number; y: number} {
  const m = /translate\((-?[\d.]+)[ ,]+(-?[\d.]+)\)/.exec(node.getAttribute('transform') ?? '');
  if (!m) throw new Error('the node has no translate()');
  return {x: Number(m[1]), y: Number(m[2])};
}

/** Width and height of a node: its outline is the first rect it draws. */
export function sizeOf(node: Element): {w: number; h: number} {
  const rect = node.querySelector('rect');
  if (!rect) throw new Error('the node draws no rect');
  return {w: Number(rect.getAttribute('width')), h: Number(rect.getAttribute('height'))};
}

/** Where a node is on the stage, in stage pixels: its box under the current pan and zoom. */
export function onStage(svg: SVGSVGElement, node: Element): {left: number; top: number; right: number; bottom: number} {
  const view = viewOf(svg);
  const at = positionOf(node);
  const {w, h} = sizeOf(node);
  return {left: at.x * view.k + view.x, top: at.y * view.k + view.y, right: (at.x + w) * view.k + view.x, bottom: (at.y + h) * view.k + view.y};
}

/** True when the point lies on the outline of the node (within a pixel). */
export function onOutline(point: readonly [number, number] | undefined, node: Element): boolean {
  if (!point) return false;
  const at = positionOf(node);
  const {w, h} = sizeOf(node);
  const [x, y] = point;
  const inside = x >= at.x - 1 && x <= at.x + w + 1 && y >= at.y - 1 && y <= at.y + h + 1;
  const edge = Math.min(Math.abs(x - at.x), Math.abs(x - at.x - w), Math.abs(y - at.y), Math.abs(y - at.y - h));
  return inside && edge <= 1;
}

/** Pan and zoom of a stage, read from the viewport group's CSS transform. */
export function viewOf(svg: SVGSVGElement): {x: number; y: number; k: number} {
  const group = svg.querySelector<SVGGElement>(':scope > g');
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\((-?[\d.]+)\)/.exec(group?.style.transform ?? '');
  if (!m) throw new Error(`no viewport transform: "${group?.style.transform}"`);
  return {x: Number(m[1]), y: Number(m[2]), k: Number(m[3])};
}

/** Press on `target`, move by (dx, dy) in steps, release: all on the stage, the way a captured pointer behaves. */
export function drag(svg: SVGSVGElement, target: Element, dx: number, dy: number, from = {x: 100, y: 100}): void {
  fireEvent.pointerDown(target, {button: 0, pointerId: 1, clientX: from.x, clientY: from.y});
  for (const t of [0.25, 0.5, 0.75, 1]) fireEvent.pointerMove(svg, {pointerId: 1, buttons: 1, clientX: from.x + dx * t, clientY: from.y + dy * t});
  fireEvent.pointerUp(svg, {pointerId: 1, clientX: from.x + dx, clientY: from.y + dy});
}

/** A click as the stage sees it: press and release without movement. */
export function click(target: Element, init: {metaKey?: boolean; ctrlKey?: boolean} = {}): void {
  fireEvent.pointerDown(target, {button: 0, pointerId: 1, clientX: 50, clientY: 50, ...init});
  fireEvent.pointerUp(target, {button: 0, pointerId: 1, clientX: 50, clientY: 50, ...init});
}

export function focus(element: Element): void {
  act(() => (element as HTMLElement).focus());
}
export const key = (element: Element, k: string, init: {shiftKey?: boolean; altKey?: boolean} = {}): boolean => fireEvent.keyDown(element, {key: k, ...init});

/** A deterministic graph of `nodes` nodes and about `edges` distinct edges. */
export function bigGraph(nodes: number, edges: number): {nodes: Array<{id: string; label: string; sub: string; kind?: string}>; edges: Array<{from: string; to: string; weight: number}>} {
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

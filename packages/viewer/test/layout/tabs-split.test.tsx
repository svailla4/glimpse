// packages/viewer/test/layout/tabs-split.test.tsx - Tabs and Split from real wire messages.
import {fireEvent, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {parseRatio} from '../../src/components/layout/Split.tsx';
import {buildPatch, buildSurface, renderExpress} from '../harness.tsx';

const key = (target: Element, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, {key: k, ...init});

describe('Tabs', () => {
  const SPEC = `root=Page('T',[tabs])\ntabs=Tabs(['Map','Table','Notes'],[a,b,c])\na=Text('map body')\nb=Text('table body')\nc=Text('notes body')`;
  const selected = () => screen.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected') === 'true');

  it('shows the first tab, mounts a tab on first activation and keeps it mounted', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Map', 'Table', 'Notes']);
    expect(selected()).toEqual([true, false, false]);
    expect(screen.getByText('map body')).toBeTruthy();
    expect(screen.queryByText('table body')).toBeNull();

    fireEvent.click(screen.getByRole('tab', {name: 'Table'}));
    expect(await screen.findByText('table body')).toBeTruthy();
    expect(selected()).toEqual([false, true, false]);
    // the first tab is hidden, not unmounted
    expect(screen.getByText('map body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByText('table body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
    expect(screen.queryByText('notes body')).toBeNull();
    expect(view.container.querySelectorAll('[role="tabpanel"]')).toHaveLength(3);
  });

  it('wires tabs and panels together for assistive technology', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    const tab = screen.getByRole('tab', {name: 'Map'});
    const panel = view.container.querySelector(`#${CSS.escape(tab.getAttribute('aria-controls')!)}`)!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    expect(screen.getAllByRole('tab').map(el => el.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves with the arrow keys, Home and End, wrapping at the ends', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    const tabs = () => screen.getAllByRole('tab');
    tabs()[0]!.focus();
    key(tabs()[0]!, 'ArrowRight');
    expect(selected()).toEqual([false, true, false]);
    expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1]!, 'End');
    expect(selected()).toEqual([false, false, true]);
    key(tabs()[2]!, 'ArrowRight');
    expect(selected()).toEqual([true, false, false]);
    key(tabs()[0]!, 'ArrowLeft');
    expect(selected()).toEqual([false, false, true]);
    key(tabs()[2]!, 'Home');
    expect(selected()).toEqual([true, false, false]);
    expect(document.activeElement).toBe(tabs()[0]);
    // other keys and modified arrows are not the strip's
    key(tabs()[0]!, 'ArrowRight', {altKey: true});
    key(tabs()[0]!, 'a');
    expect(selected()).toEqual([true, false, false]);
    expect(await screen.findByText('notes body')).toBeTruthy();
  });

  it('labels extra children "Tab n", ignores extra labels, and shows an empty state without children', async () => {
    const view = renderExpress(`root=Page('T',[x,y,z])\nx=Tabs(['Only'],[Text('one'),Text('two')])\ny=Tabs(['A','B','C'],[Text('just one')])\nz=Tabs([],[])`);
    await view.settle();
    const names = (id: string) => [...view.cell(id).querySelectorAll('[role="tab"]')].map(tab => tab.textContent);
    expect(names('x')).toEqual(['Only', 'Tab 2']);
    expect(names('y')).toEqual(['A']);
    expect(view.cell('z').querySelector('[data-gl-state="empty"]')?.textContent).toBe('no tabs');
  });

  it('keeps the open tab open when a patch adds a tab in front of it', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    fireEvent.click(screen.getByRole('tab', {name: 'Table'}));
    view.send(buildPatch('test', buildSurface('test', SPEC), `tabs=Tabs(['New','Map','Table'],[n,a,b])\nn=Text('new body')`));
    await view.settle();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['New', 'Map', 'Table']);
    expect(selected()).toEqual([false, false, true]);
    expect(screen.getByText('table body').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false);
    // the tab that was open is removed: the first one takes over
    view.send(buildPatch('test', buildSurface('test', SPEC), `tabs=Tabs(['New','Map'],[n,a])\nn=Text('new body')`));
    await view.settle();
    expect(selected()).toEqual([true, false]);
    expect(await screen.findByText('new body')).toBeTruthy();
    expect(view.errors).toEqual([]);
  });
});

describe('Split', () => {
  it('parses ratios and falls back to halves', () => {
    expect(parseRatio('1:2')).toBeCloseTo(1 / 3);
    expect(parseRatio('3:1')).toBeCloseTo(0.75);
    expect(parseRatio('1:99')).toBe(0.1);
    for (const bad of [undefined, '', '1', '1:2:3', 'a:b', '0:1', '1:-1']) expect(parseRatio(bad), String(bad)).toBe(0.5);
  });

  const SPEC = `root=Page('T',[s])\ns=Split(Text('left pane'),Text('right pane'),'1:3',size='m')`;
  const split = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-dir]')!;
  const share = (container: HTMLElement) => Number.parseFloat(split(container).style.getPropertyValue('--a'));

  it('renders two panes around a separator at the spec ratio', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    expect(view.cell('s').getAttribute('data-size')).toBe('m');
    const root = split(view.container);
    expect(root.getAttribute('data-dir')).toBe('row');
    expect(root.hasAttribute('data-sized')).toBe(true);
    expect(share(view.container)).toBeCloseTo(0.25);
    expect(root.style.getPropertyValue('--b')).toBe('0.75fr');
    const separator = screen.getByRole('separator', {name: 'Resize panes'});
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuenow')).toBe('25');
    expect(separator.tabIndex).toBe(0);
    expect(screen.getByText('left pane')).toBeTruthy();
    expect(screen.getByText('right pane')).toBeTruthy();
  });

  it('arrow keys move the divider 2%, Home and End go to the limits, Enter and double-click reset', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    const separator = screen.getByRole('separator');
    key(separator, 'ArrowRight');
    expect(share(view.container)).toBeCloseTo(0.27);
    key(separator, 'ArrowDown');
    expect(share(view.container)).toBeCloseTo(0.29);
    key(separator, 'ArrowLeft');
    key(separator, 'ArrowUp');
    expect(share(view.container)).toBeCloseTo(0.25);
    key(separator, 'Home');
    expect(share(view.container)).toBeCloseTo(0.1);
    key(separator, 'ArrowLeft');
    expect(share(view.container)).toBeCloseTo(0.1);
    key(separator, 'End');
    expect(share(view.container)).toBeCloseTo(0.9);
    expect(separator.getAttribute('aria-valuenow')).toBe('90');
    key(separator, 'Enter');
    expect(share(view.container)).toBeCloseTo(0.25);
    key(separator, 'End');
    fireEvent.doubleClick(separator);
    expect(share(view.container)).toBeCloseTo(0.25);
  });

  it('dragging the divider resizes the panes within 10% and 90%', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    const separator = screen.getByRole('separator');
    // the fake layout makes every box 960 x 600 at the origin
    fireEvent.pointerDown(separator, {button: 0, clientX: 240, pointerId: 1});
    expect(split(view.container).hasAttribute('data-dragging')).toBe(true);
    fireEvent.pointerMove(window, {clientX: 480, clientY: 10});
    expect(share(view.container)).toBeCloseTo(0.5);
    fireEvent.pointerMove(window, {clientX: 5000});
    expect(share(view.container)).toBeCloseTo(0.9);
    fireEvent.pointerMove(window, {clientX: -40});
    expect(share(view.container)).toBeCloseTo(0.1);
    fireEvent.pointerUp(window);
    expect(split(view.container).hasAttribute('data-dragging')).toBe(false);
    fireEvent.pointerMove(window, {clientX: 480});
    expect(share(view.container)).toBeCloseTo(0.1);
    // only the primary button drags
    fireEvent.pointerDown(separator, {button: 2, clientX: 240});
    fireEvent.pointerMove(window, {clientX: 700});
    expect(share(view.container)).toBeCloseTo(0.1);
  });

  it('stacks with dir=col, tolerates a malformed ratio and a missing pane, and follows a patch', async () => {
    const spec = `root=Page('T',[s])\ns=Split(Text('top'),Text('bottom'),'oops','col')`;
    const view = renderExpress(spec);
    await view.settle();
    const root = split(view.container);
    expect(root.getAttribute('data-dir')).toBe('col');
    expect(root.hasAttribute('data-sized')).toBe(false);
    expect(share(view.container)).toBeCloseTo(0.5);
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal');
    // the end pane names a component that has not arrived (the viewer accepts dangling references)
    view.send({version: '1.0', updateComponents: {surfaceId: 'test', components: [{id: 's', component: 'Split', start: view.surface.componentsModel.get('s')!.properties.start, end: 'missing', ratio: '2:1', dir: 'row'}]}});
    await view.settle();
    expect(split(view.container).getAttribute('data-dir')).toBe('row');
    expect(share(view.container)).toBeCloseTo(2 / 3);
    expect(screen.getByText('top')).toBeTruthy();
    expect(view.container.querySelector('[data-gl-state="redline"]')).toBeNull();
  });
});

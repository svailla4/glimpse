// Regression tests for decision reports-are-component-state in the code family: what a code view reports is the state of the whole component.
// A part of it (one file of a diff, one stop of a tour) never speaks for the component (V062), and a
// truthful empty or a view waiting for a selection is an I_* state, never a problem told to the agent.
import {fireEvent, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {renderExpress} from '../harness.tsx';

const DIFF = {
  range: 'wt',
  rev: 1,
  totals: {files: 2, add: 1, del: 0},
  files: [
    {path: 'a.ts', status: 'M', add: 1, del: 0, hunks: [{header: '@@ -1 +1 @@', lines: [{t: '+', n: 1, tokens: [['let a = 1', 0]]}]}]},
    {path: 'logo.png', status: 'A', add: 0, del: 0, binary: true},
  ],
};

describe('reports-are-component-state in the code family (V062)', () => {
  it('one binary file of a diff is not the DiffView being empty', async () => {
    const view = renderExpress(`root=Page('T',[d])\nd=DiffView(title='Changes')`, {host: {diff: () => Promise.resolve(DIFF as never)}});
    const cell = view.cell('d');
    await waitFor(() => expect(cell.querySelector('[data-path="logo.png"]')).not.toBeNull());
    fireEvent.click(cell.querySelector('[data-path="logo.png"]')!);
    await waitFor(() => expect(cell.querySelector('[data-gl-state="empty"]')?.textContent).toBe('logo.png is a binary file'));
    await view.settle();
    // the file list is on screen: the component draws, and that is all it says
    expect(cell.querySelector('[data-path="a.ts"]')).not.toBeNull();
    expect(view.reports).toEqual([]);
    expect(view.stateOf('d')).toBe('OK');
  });

  it('a clean working tree is a truthful empty (I_EMPTY), not a problem', async () => {
    const view = renderExpress(`root=Page('T',[d])\nd=DiffView()`, {host: {diff: () => Promise.resolve({range: 'wt', rev: 1, totals: {files: 0, add: 0, del: 0}, files: []} as never)}});
    await waitFor(() => expect(view.cell('d').textContent).toContain('no uncommitted changes'));
    await view.settle();
    expect(view.stateOf('d')).toBe('I_EMPTY');
  });

  it('one stop of a tour whose file is missing is not the tour state; a code view the spec points at a missing file is', async () => {
    const view = renderExpress(`root=Page('T',[t,c])\nt=CodeTour([{file:'src/missing.ts',note:'gone'},{file:'src/auth/service.ts',note:'here'}])\nc=CodeView(file='src/missing.ts')`);
    await waitFor(() => expect(view.cell('t').textContent).toContain('does not exist'));
    await waitFor(() => expect(view.cell('c').textContent).toContain('does not exist'));
    await view.settle();
    expect(view.stateOf('t')).toBe('OK');
    expect(view.stateOf('c')).toBe('W_FILE');
  });

  it('a code view and an outline that follow the selection wait for one (I_WAITING)', async () => {
    const view = renderExpress(`root=Page('T',[c,o])\nc=CodeView()\no=SymbolOutline()`);
    await waitFor(() => expect(view.cell('c').textContent).toContain('no file selected'));
    await waitFor(() => expect(view.cell('o').textContent).toContain('no file selected'));
    await view.settle();
    expect(view.stateOf('c')).toBe('I_WAITING');
    expect(view.stateOf('o')).toBe('I_WAITING');
  });
});

import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {chunks, renderExpress, type RenderedSpec} from '../harness.tsx';

const STOPS = `[{file:'src/auth/service.ts#L8-14',title:'Start here',note:'Login checks the password.'},{file:'src/auth/cache.ts#L5-9',note:'Token cache.'},{file:'src/api/routes.ts#L2',title:'Routes',note:'Where it is wired.'}]`;
const SPEC = `$/tour=${STOPS}\nroot=Page('T',[t])\nt=CodeTour($/tour,title='Tour',size='l')`;
const at = (cell: HTMLElement) => cell.querySelector('[data-gl-tour-at]')?.textContent;
const shown = (cell: HTMLElement) => cell.querySelector('[data-gl-code="view"]')?.getAttribute('aria-label') ?? cell.querySelector('[role="region"]')?.getAttribute('aria-label');
const fileCalls = (view: RenderedSpec) => view.host.calls.filter(call => call.method === 'file').map(call => (call.args[0] as {path: string}).path);
const tour = (cell: HTMLElement) => cell.querySelector<HTMLElement>('[data-gl-code="tour"]')!;

describe('CodeTour', () => {
  it('shows the stops on the left and the first stop in a code view on the right', async () => {
    const view = renderExpress(SPEC);
    const cell = view.cell('t');
    await waitFor(() => expect(cell.querySelector('[data-line="8"]')).not.toBeNull());
    expect(at(cell)).toBe('1 / 3');
    expect(fileCalls(view)).toEqual(['src/auth/service.ts']);
    expect(shown(cell)).toContain('src/auth/service.ts');
    expect(cell.querySelector('[data-line="8"]')?.hasAttribute('data-region')).toBe(true);
    expect(cell.querySelector('[data-line="15"]')?.hasAttribute('data-region')).toBe(false);
    const steps = within(cell).getAllByRole('listitem');
    expect(steps.map(step => step.textContent)).toEqual([
      expect.stringContaining('Start here'), expect.stringContaining('Token cache.'), expect.stringContaining('Routes'),
    ]);
    // a stop without a title is named after its file
    expect(steps[1]!.textContent).toContain('cache.ts');
    expect(steps[0]!.getAttribute('aria-current') ?? steps[0]!.querySelector('[aria-current]')?.getAttribute('aria-current')).toBe('step');
    expect(tour(cell).getAttribute('aria-label')).toBe('Code tour, stop 1 of 3: Start here');
    expect(view.errors).toEqual([]);
  });

  it('moves with the arrow keys, j and k, and the buttons; each move selects the stop', async () => {
    const view = renderExpress(SPEC);
    const cell = view.cell('t');
    await waitFor(() => expect(at(cell)).toBe('1 / 3'));
    expect(within(cell).getByRole<HTMLButtonElement>('button', {name: 'Previous stop'}).disabled).toBe(true);

    fireEvent.keyDown(tour(cell), {key: 'ArrowRight'});
    await waitFor(() => expect(at(cell)).toBe('2 / 3'));
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/auth/cache.ts', path: 'src/auth/cache.ts', line: 5, endLine: 9});
    expect(view.getData('/ui/file')).toBe('src/auth/cache.ts#L5-9');
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 't'});
    await waitFor(() => expect(shown(cell)).toContain('src/auth/cache.ts'));
    await waitFor(() => expect(cell.querySelector('[data-line="5"]')?.hasAttribute('data-selected')).toBe(true));

    fireEvent.keyDown(tour(cell), {key: 'j'});
    await waitFor(() => expect(at(cell)).toBe('3 / 3'));
    fireEvent.keyDown(tour(cell), {key: 'j'});
    expect(at(cell)).toBe('3 / 3');
    expect(within(cell).getByRole<HTMLButtonElement>('button', {name: 'Next stop'}).disabled).toBe(true);
    fireEvent.keyDown(tour(cell), {key: 'k'});
    await waitFor(() => expect(at(cell)).toBe('2 / 3'));
    fireEvent.keyDown(tour(cell), {key: 'ArrowLeft'});
    await waitFor(() => expect(at(cell)).toBe('1 / 3'));
    fireEvent.click(within(cell).getByRole('button', {name: 'Next stop'}));
    await waitFor(() => expect(at(cell)).toBe('2 / 3'));
    expect(fileCalls(view).at(-1)).toBe('src/auth/cache.ts');
  });

  it('goes to a stop when its step is selected, here or anywhere else on the surface', async () => {
    const view = renderExpress(SPEC);
    const cell = view.cell('t');
    await waitFor(() => expect(at(cell)).toBe('1 / 3'));
    // Steps comes from the content chunk when it has one; the local list behaves the same way.
    expect(Boolean(cell.querySelector('[data-gl-steps="local"]'))).toBe(!chunks.content?.views.Steps);
    const third = within(cell).getAllByRole('listitem')[2]!;
    fireEvent.click(third.querySelector('button') ?? third);
    await waitFor(() => expect(at(cell)).toBe('3 / 3'));
    expect(view.getData('/ui/file')).toBe('src/api/routes.ts#L2');

    view.setData('/ui/file', 'src/auth/service.ts#L8-14');
    await waitFor(() => expect(at(cell)).toBe('1 / 3'));
    view.setData('/ui/file', 'unrelated.ts');
    await view.settle();
    expect(at(cell)).toBe('1 / 3');
  });

  it('follows a binding update and clamps the position when stops go away', async () => {
    const view = renderExpress(SPEC);
    const cell = view.cell('t');
    await waitFor(() => expect(at(cell)).toBe('1 / 3'));
    fireEvent.keyDown(tour(cell), {key: 'j'});
    fireEvent.keyDown(tour(cell), {key: 'j'});
    await waitFor(() => expect(at(cell)).toBe('3 / 3'));
    view.setData('/tour', [{file: 'src/ui/App.tsx#L1-4', note: 'Only stop.'}]);
    await waitFor(() => expect(at(cell)).toBe('1 / 1'));
    await waitFor(() => expect(shown(cell)).toContain('src/ui/App.tsx'));
  });

  it('shows pending, empty, error and malformed data as states', async () => {
    const view = renderExpress(`root=Page('T',[t])\nt=CodeTour($/tour)`);
    const cell = view.cell('t');
    await waitFor(() => expect(cell.querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/tour', {$ds: 'x', kind: 'rows', status: 'pending', source: 'x', note: 'collecting stops'});
    await waitFor(() => expect(cell.querySelector('[data-gl-state="drafting"]')?.textContent).toBe('collecting stops'));
    view.setData('/tour', {$ds: 'x', kind: 'rows', status: 'error', source: 'x', error: {code: 'E_TARGET', message: 'no such symbol'}});
    await waitFor(() => expect(cell.querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_TARGET'));
    view.setData('/tour', {file: 'a.ts', note: 'not a list'});
    await waitFor(() => expect(cell.querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_SHAPE'));
    view.setData('/tour', [null, {note: 'no file'}, 7]);
    await waitFor(() => expect(cell.querySelector('[data-gl-state="empty"]')?.textContent).toBe('no stop names a file (3 dropped)'));
    view.setData('/tour', [null, {file: 'src/auth/service.ts', note: 9}, {file: '  '}]);
    await waitFor(() => expect(at(cell)).toBe('1 / 1'));
    expect(cell.querySelector('[data-gl-marginal]')?.textContent).toBe('2 malformed dropped');
    expect(view.errors).toEqual([]);
  });

  it('stacks below 720 px', async () => {
    const view = renderExpress(SPEC, {size: {width: 600, height: 600}});
    await waitFor(() => expect(tour(view.cell('t'))).not.toBeNull());
    await waitFor(() => expect(tour(view.cell('t')).hasAttribute('data-stack')).toBe(true));
    view.unmount();
    const wide = renderExpress(SPEC);
    await waitFor(() => expect(tour(wide.cell('t'))).not.toBeNull());
    expect(tour(wide.cell('t')).hasAttribute('data-stack')).toBe(false);
  });
});

// Slider (decision what-if-as-a2ui-calls): a number the user sets, written through A2UI's own setter, recomputed by A2UI in the tab and
// posted to the server on commit. The ticketing what-if of the design is the fixture: at the seeds the Stats read
// 250 / 1,000 / 500; with seats at 80,000 they read 400 / 1,600 / 800.
import {act, fireEvent, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderExpress, type RenderedSpec} from '../harness.tsx';

const WHAT_IF = [
  `root=Page('Ticketing: on-sale what-if',[inputs,peak])`,
  `$/w={seats:50000,secs:120,conv:0.6}`,
  `inputs=Row([seats,secs])`,
  `seats=Slider('Seats on sale',$/w/seats,1000,200000,step=1000)`,
  `secs=Slider('Sale window',$/w/secs,10,600,step=10,unit='s')`,
  `rps=div(mul($/w/seats,$/w/conv),$/w/secs)`,
  `peak=Stats([{label:'Peak checkout',value:rps,unit:'req/s'},{label:'Redis',value:mul(rps,4),unit:'ops/s'},{label:'Postgres writes',value:mul(rps,2),unit:'/s'}],title='Load at peak')`,
].join('\n');

async function show(spec = WHAT_IF): Promise<RenderedSpec> {
  const view = renderExpress(spec);
  await view.settle();
  return view;
}

/** The numerals of the Stats plate, in order. */
const peaks = (view: RenderedSpec) => [...view.cell('peak').querySelectorAll('[data-gl-stat-value]')].map(el => el.textContent);
const field = (name: string) => screen.getByRole('spinbutton', {name}) as HTMLInputElement;
const sets = (view: RenderedSpec) => view.actions.filter(action => action.name === 'gl_set');

afterEach(() => {
  vi.useRealTimers();
});

describe('Slider', () => {
  it('writes its bound path through the setter, and the calls reading it recompute in the tab', async () => {
    const view = await show();
    expect(peaks(view)).toEqual(['250', '1,000', '500']);
    expect(field('Seats on sale').value).toBe('50000');
    fireEvent.change(field('Seats on sale'), {target: {value: '80000'}});
    expect(view.getData('/w/seats')).toBe(80000);
    expect(peaks(view)).toEqual(['400', '1,600', '800']);
    // The calls are computed with the tab's permissive schemas: nothing reaches the error channel.
    expect(view.errors).toEqual([]);
    expect(view.reports).toEqual([]);
  });

  it('posts one gl_set with the number on blur, not one per keystroke', async () => {
    const view = await show();
    const input = field('Seats on sale');
    for (const text of ['8', '80', '800', '8000', '80000']) fireEvent.change(input, {target: {value: text}});
    expect(sets(view)).toEqual([]);
    fireEvent.blur(input);
    expect(sets(view)).toEqual([expect.objectContaining({name: 'gl_set', sourceComponentId: 'seats', context: {value: 80000}})]);
    // Nothing new to commit: a second blur posts nothing.
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(sets(view)).toHaveLength(1);
    expect(field('Seats on sale').value).toBe('80000');
  });

  it('commits on Enter, and 600 ms after the last write', async () => {
    const view = await show();
    const input = field('Seats on sale');
    fireEvent.change(input, {target: {value: '60000'}});
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(sets(view).map(action => action.context)).toEqual([{value: 60000}]);

    vi.useFakeTimers();
    fireEvent.change(input, {target: {value: '70000'}});
    act(() => void vi.advanceTimersByTime(599));
    expect(sets(view)).toHaveLength(1);
    fireEvent.change(input, {target: {value: '80000'}});
    act(() => void vi.advanceTimersByTime(599));
    expect(sets(view)).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(sets(view).map(action => action.context)).toEqual([{value: 60000}, {value: 80000}]);
  });

  it('commits what is pending when it unmounts', async () => {
    const view = await show();
    fireEvent.change(field('Seats on sale'), {target: {value: '90000'}});
    expect(sets(view)).toEqual([]);
    view.unmount();
    expect(sets(view).map(action => action.context)).toEqual([{value: 90000}]);
  });

  it('writes nothing outside min and max while typing; on blur it holds what was typed to them', async () => {
    const view = await show();
    const input = field('Seats on sale');
    fireEvent.change(input, {target: {value: '5'}});
    expect(view.getData('/w/seats')).toBe(50000);
    expect(input.value).toBe('5');
    fireEvent.blur(input);
    expect(view.getData('/w/seats')).toBe(1000);
    expect(input.value).toBe('1000');
    expect(sets(view).map(action => action.context)).toEqual([{value: 1000}]);

    fireEvent.change(input, {target: {value: '900000'}});
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(view.getData('/w/seats')).toBe(200000);
    // Text that is not a number is dropped on commit: nothing is written and the field shows the number again.
    fireEvent.change(input, {target: {value: ''}});
    fireEvent.blur(input);
    expect(view.getData('/w/seats')).toBe(200000);
    expect(input.value).toBe('200000');
    expect(sets(view).map(action => action.context)).toEqual([{value: 1000}, {value: 200000}]);
  });

  it('draws a range only when min is below max; the range writes on change and commits on pointer-up', async () => {
    const view = await show(
      [
        `root=Page('T',[a,b,c])`,
        `$/w={a:5,b:5,c:5}`,
        `a=Slider('Ranged',$/w/a,0,10,unit='s')`,
        `b=Slider('Upside down',$/w/b,10,5)`,
        `c=Slider('Open',$/w/c)`,
      ].join('\n'),
    );
    const ranges = screen.getAllByRole('slider') as HTMLInputElement[];
    expect(ranges.map(range => range.getAttribute('aria-labelledby') && document.getElementById(range.getAttribute('aria-labelledby')!)?.textContent)).toEqual(['Ranged']);
    const range = ranges[0]!;
    expect([range.min, range.max, range.step, range.value]).toEqual(['0', '10', '0.1', '5']);
    expect(range.getAttribute('aria-valuetext')).toBe('5 s');
    expect(field('Open').step).toBe('any');
    fireEvent.change(range, {target: {value: '7'}});
    expect(view.getData('/w/a')).toBe(7);
    expect(field('Ranged').value).toBe('7');
    expect(sets(view)).toEqual([]);
    fireEvent.pointerUp(range);
    expect(sets(view)).toEqual([expect.objectContaining({sourceComponentId: 'a', context: {value: 7}})]);
    fireEvent.keyUp(range, {key: 'Tab'});
    expect(sets(view)).toHaveLength(1);
  });

  it('reports W_VALUE when the bound value is not a number, and says so under the field', async () => {
    const view = await show(`root=Page('T',[s])\n$/w={seats:'50k'}\ns=Slider('Seats',$/w/seats,1000,200000)`);
    expect(view.reports).toEqual([expect.objectContaining({code: 'W_VALUE', componentId: 's', message: 'Slider#s: value is "50k", not a number'})]);
    expect(field('Seats').value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('value is "50k", not a number');
    // A number typed over it puts it right.
    fireEvent.change(field('Seats'), {target: {value: '5000'}});
    await view.settle();
    expect(view.stateOf('s')).toBe('OK');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('says under the field why the values reading it have none at this number, without reporting it', async () => {
    const view = await show(
      [
        `root=Page('T',[secs,peak])`,
        `$/w={seats:50000,secs:120}`,
        `secs=Slider('Sale window',$/w/secs)`,
        `peak=Stat(div($/w/seats,$/w/secs),'checkout req/s')`,
      ].join('\n'),
    );
    const note = screen.getByRole('status');
    expect(note.textContent).toBe('');
    fireEvent.change(field('Sale window'), {target: {value: '0'}});
    expect(view.getData('/w/secs')).toBe(0);
    expect(note.textContent).toBe('Not computed at this value: division by zero');
    expect(view.cell('peak').textContent).toContain('—');
    fireEvent.change(field('Sale window'), {target: {value: '100'}});
    expect(note.textContent).toBe('');
    expect(view.cell('peak').textContent).toContain('500');
    await view.settle();
    // The user's own input is not the spec's problem: no report, and A2UI raised no EXPRESSION_ERROR.
    expect(view.reports).toEqual([]);
    expect(view.errors).toEqual([]);
  });
});

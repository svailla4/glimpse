// Button and Ask: A2UI actions as the server receives them, and the "queued for the agent" affordance (design 2.7).
import {ActionMessageSchema} from '@a2ui/web_core/v1_0';
import {act, fireEvent, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderExpress} from '../harness.tsx';

const queued = (cell: HTMLElement) => cell.querySelector('[role="status"]') as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
});

describe('Button', () => {
  it('dispatches its event with the context resolved at click time, as a valid v1.0 action', async () => {
    const view = renderExpress(`root=Page('T',[go])\ngo=Button('Explain',Event('explain',{file:$/ui/file,plan:1}),'primary')`, {ui: {file: 'src/a.ts#L3'}});
    const button = within(view.cell('go')).getByRole('button', {name: 'Explain'});
    expect(button.getAttribute('data-tone')).toBe('primary');
    expect(queued(view.cell('go')).textContent).toBe('');
    view.setData('/ui/file', 'src/b.ts');
    fireEvent.click(button);
    await waitFor(() => expect(view.actions).toHaveLength(1));
    expect(view.actions[0]).toMatchObject({name: 'explain', surfaceId: 'test', sourceComponentId: 'go', context: {file: 'src/b.ts', plan: 1}});
    expect(() => ActionMessageSchema.parse({version: '1.0', action: view.actions[0]})).not.toThrow();
    expect(queued(view.cell('go')).textContent).toBe('queued for the agent');
    expect(queued(view.cell('go')).getAttribute('aria-live')).toBe('polite');
  });

  it('shows "queued for the agent" for two seconds after each press', async () => {
    vi.useFakeTimers();
    const view = renderExpress(`root=Page('T',[go])\ngo=Button('Queue',Event('demo'))`);
    const button = within(view.cell('go')).getByRole('button', {name: 'Queue'});
    expect(button.getAttribute('data-tone')).toBe('default');
    fireEvent.click(button);
    // "queued" is said once the action has been handed over, not before
    expect(queued(view.cell('go')).textContent).toBe('');
    await act(async () => {});
    expect(queued(view.cell('go')).textContent).toBe('queued for the agent');
    act(() => void vi.advanceTimersByTime(1500));
    // a second press queues a second event and restarts the note
    fireEvent.click(button);
    await act(async () => {});
    act(() => void vi.advanceTimersByTime(1500));
    expect(queued(view.cell('go')).textContent).toBe('queued for the agent');
    act(() => void vi.advanceTimersByTime(600));
    expect(queued(view.cell('go')).textContent).toBe('');
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(view.actions.map(action => action.name)).toEqual(['demo', 'demo']);
  });

  it('works from the keyboard, follows a label binding, and leaves no timer behind when it unmounts', async () => {
    const view = renderExpress(`$/label='First'\nroot=Page('T',[go])\ngo=Button($/label,Event('pressed'),'quiet')`);
    const button = within(view.cell('go')).getByRole('button');
    expect(button.textContent).toBe('First');
    expect(button.getAttribute('data-tone')).toBe('quiet');
    expect(button.getAttribute('type')).toBe('button');
    view.setData('/label', 'Second');
    await waitFor(() => expect(button.textContent).toBe('Second'));
    view.setData('/label', '');
    await waitFor(() => expect(button.textContent).toBe('Send'));
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(view.actions.map(action => action.name)).toEqual(['pressed']));
    view.unmount();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});

describe('Ask', () => {
  it('dispatches the named event with the choice, marks the pick and says it is queued', async () => {
    const view = renderExpress(`root=Page('T',[q])\nq=Ask('Which store backs the \`limiter\`?',['Redis','In-memory'],'store')`);
    const cell = view.cell('q');
    expect(cell.querySelector('p code')?.textContent).toBe('limiter');
    const options = within(cell).getAllByRole('button');
    expect(options.map(option => option.textContent)).toEqual(['Redis', 'In-memory']);
    expect(options.map(option => option.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(queued(cell).textContent).toBe('');

    fireEvent.click(options[0]!);
    await waitFor(() => expect(view.actions).toHaveLength(1));
    expect(view.actions[0]).toMatchObject({name: 'store', sourceComponentId: 'q', context: {choice: 'Redis'}});
    expect(() => ActionMessageSchema.parse({version: '1.0', action: view.actions[0]})).not.toThrow();
    expect(options.map(option => option.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(options[0]!.hasAttribute('data-chosen')).toBe(true);
    expect(queued(cell).textContent).toBe('queued for the agent · Redis');
    // the note stays for as long as the pick stands, and a change of mind is a new event
    fireEvent.click(options[1]!);
    await waitFor(() => expect(view.actions).toHaveLength(2));
    expect(view.actions[1]!.context).toEqual({choice: 'In-memory'});
    expect(options.map(option => option.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(queued(cell).textContent).toBe('queued for the agent · In-memory');
  });

  it('defaults the event name to "answer" and is one tab stop with roving focus', async () => {
    const view = renderExpress(`root=Page('T',[q])\nq=Ask('Proceed?',['Yes','No','Later'])`);
    const options = within(view.cell('q')).getAllByRole('button');
    expect(options.map(option => option.tabIndex)).toEqual([0, -1, -1]);
    options[0]!.focus();
    fireEvent.keyDown(options[0]!, {key: 'ArrowRight'});
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, {key: 'End'});
    expect(document.activeElement).toBe(options[2]);
    expect(options.map(option => option.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(options[2]!, {key: 'Home'});
    expect(document.activeElement).toBe(options[0]);
    fireEvent.click(options[2]!);
    await waitFor(() => expect(view.actions[0]).toMatchObject({name: 'answer', context: {choice: 'Later'}}));
  });

  it('follows a prompt binding and a patch of its options; a pick that no longer exists is forgotten', async () => {
    const view = renderExpress(`$/q='First question?'\nroot=Page('T',[q])\nq=Ask($/q,['A','B'],'pick')`);
    const cell = view.cell('q');
    fireEvent.click(within(cell).getByRole('button', {name: 'B'}));
    expect(queued(cell).textContent).toBe('queued for the agent · B');
    view.setData('/q', 'Second question?');
    await waitFor(() => expect(cell.querySelector('p')?.textContent).toBe('Second question?'));
    view.send({version: '1.0', updateComponents: {surfaceId: 'test', components: [{id: 'q', component: 'Ask', prompt: {'@path': '/q'}, options: ['A', 'C', 'C', ''], name: 'pick'}]}});
    await waitFor(() => expect(within(cell).getAllByRole('button').map(option => option.textContent)).toEqual(['A', 'C']));
    expect(queued(cell).textContent).toBe('');
    expect(cell.querySelector('[data-chosen]')).toBeNull();
    expect(view.errors).toEqual([]);
  });

  it('says so when there is nothing to choose from', async () => {
    const view = renderExpress(`root=Page('T',[q])\nq=Ask('Anything?',[])`);
    expect(within(view.cell('q')).queryAllByRole('button')).toHaveLength(0);
    expect(view.cell('q').textContent).toContain('no options to choose from');
    expect(view.actions).toEqual([]);
  });
});

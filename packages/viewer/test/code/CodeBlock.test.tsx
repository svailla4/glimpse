import {fireEvent, screen, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {renderExpress} from '../harness.tsx';

const SNIPPET = "export async function take(ip: string) {\\n  const n = await redis.incr(key);\\n  return n <= 100;\\n}";
const lineTexts = (root: HTMLElement) => [...root.querySelectorAll('[data-line]')].map(line => line.lastElementChild?.textContent);

describe('CodeBlock', () => {
  it('shows plain text at once and token classes when the host answers', async () => {
    let answer: (() => void) | undefined;
    const view = renderExpress(`root=Page('T',[c])\nc=CodeBlock('${SNIPPET}','ts',title='Limiter')`, {
      host: {
        highlight: (code, lang) =>
          new Promise(resolve => {
            answer = () => resolve({lang: lang ?? 'text', lines: code.split('\n').map(text => [[text.slice(0, 6), 1], [text.slice(6), 0]])});
          }),
      },
    });
    const cell = view.cell('c');
    await waitFor(() => expect(lineTexts(cell)).toHaveLength(4));
    expect(lineTexts(cell)[1]).toBe('  const n = await redis.incr(key);');
    expect(cell.querySelector('[class^="gl-tok-"]')).toBeNull();
    expect(view.host.calls.filter(call => call.method === 'highlight')).toHaveLength(1);
    expect(view.host.calls[0]!.args.slice(0, 2)).toEqual([SNIPPET.replace(/\\n/g, '\n'), 'ts']);

    answer!();
    await waitFor(() => expect(cell.querySelector('.gl-tok-kw')?.textContent).toBe('export'));
    expect(lineTexts(cell)[1]).toBe('  const n = await redis.incr(key);');
    expect(screen.getByText('Limiter')).toBeTruthy();
    expect(cell.querySelector('[data-gl-lang]')?.textContent).toBe('ts');
    expect(view.errors).toEqual([]);
  });

  it('keeps plain text when highlighting fails or returns other text', async () => {
    const failing = renderExpress(`root=Page('T',[c])\nc=CodeBlock('a = 1','py')`, {host: {highlight: () => Promise.reject(new Error('down'))}});
    await failing.settle();
    expect(lineTexts(failing.cell('c'))).toEqual(['a = 1']);
    expect(failing.cell('c').querySelector('[data-gl-state]')).toBeNull();
    failing.unmount();

    const garbled = renderExpress(`root=Page('T',[c])\nc=CodeBlock('a = 1\\nb = 2','py')`, {
      host: {highlight: () => Promise.resolve({lang: 'py', lines: [[['zzz', 1]], 'not a line' as never]})},
    });
    await garbled.settle();
    expect(lineTexts(garbled.cell('c'))).toEqual(['a = 1', 'b = 2']);
    expect(garbled.cell('c').querySelector('.gl-tok-kw')).toBeNull();
  });

  it('does not ask the host when no language is given', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeBlock('plain text')`);
    await view.settle();
    expect(lineTexts(view.cell('c'))).toEqual(['plain text']);
    expect(view.host.calls).toEqual([]);
  });

  it('numbers lines above five and marks the lines named in mark', async () => {
    const short = renderExpress(`root=Page('T',[c])\nc=CodeBlock('a\\nb\\nc','sh',mark='2')`);
    const cell = short.cell('c');
    await waitFor(() => expect(lineTexts(cell)).toHaveLength(3));
    expect(cell.querySelector('[data-line="1"]')?.childElementCount).toBe(2);
    expect([...cell.querySelectorAll('[data-hl]')].map(line => line.getAttribute('data-line'))).toEqual(['2']);
    short.unmount();

    const long = renderExpress(`root=Page('T',[c])\nc=CodeBlock('1\\n2\\n3\\n4\\n5\\n6\\n7','sh',mark='1,6-9,x')`);
    const longCell = long.cell('c');
    await waitFor(() => expect(lineTexts(longCell)).toHaveLength(7));
    expect(longCell.querySelector('[data-line="6"]')?.firstElementChild?.textContent).toBe('6');
    expect([...longCell.querySelectorAll('[data-hl]')].map(line => line.getAttribute('data-line'))).toEqual(['1', '6', '7']);
  });

  it('follows a binding update', async () => {
    const view = renderExpress(`$/snippet='first()'\nroot=Page('T',[c])\nc=CodeBlock($/snippet,'ts')`);
    await waitFor(() => expect(lineTexts(view.cell('c'))).toEqual(['first()']));
    view.setData('/snippet', 'second()\nthird()');
    await waitFor(() => expect(lineTexts(view.cell('c'))).toEqual(['second()', 'third()']));
    expect(view.host.calls.filter(call => call.method === 'highlight')).toHaveLength(2);
  });

  it('shows the empty state for no code and a redline for a wrong type', async () => {
    const view = renderExpress(`$/snippet=''\nroot=Page('T',[c])\nc=CodeBlock($/snippet)`);
    await waitFor(() => expect(view.cell('c').querySelector('[data-gl-state="empty"]')).not.toBeNull());
    view.setData('/snippet', {not: 'text'});
    await waitFor(() => expect(view.cell('c').querySelector('[data-gl-state="redline"]')?.getAttribute('data-code')).toBe('E_SHAPE'));
    view.setData('/snippet', 42);
    await waitFor(() => expect(lineTexts(view.cell('c'))).toEqual(['42']));
  });

  it('renders only the lines near the viewport of a very long snippet and cuts very long lines', async () => {
    const code = Array.from({length: 20_000}, (_, i) => `line ${i + 1}`).join('\n');
    const view = renderExpress(`$/snippet=''\nroot=Page('T',[c])\nc=CodeBlock($/snippet)`, {data: {'/snippet': code}});
    const cell = view.cell('c');
    await waitFor(() => expect(cell.querySelector('[data-line="1"]')).not.toBeNull());
    expect(cell.querySelectorAll('[data-line]').length).toBeLessThan(80);
    const scroller = cell.querySelector<HTMLElement>('[role="region"]')!;
    scroller.scrollTop = 10_000 * 20;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(cell.querySelector('[data-line="10005"]')).not.toBeNull());
    expect(cell.querySelector('[data-line="1"]')).toBeNull();

    view.setData('/snippet', 'x'.repeat(50_000));
    await waitFor(() => expect(cell.querySelector('[data-gl-cut]')?.textContent).toContain('+48,000 chars'));
    expect(cell.querySelector('[data-line="1"]')!.textContent!.length).toBeLessThan(2100);
  });

  it('copies the code with the button and with c on the focused block', async () => {
    const view = renderExpress(`root=Page('T',[c])\nc=CodeBlock('a\\nb','sh')`);
    const cell = view.cell('c');
    await waitFor(() => expect(lineTexts(cell)).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', {name: 'Copy code'}));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Copied'})).toBeTruthy());
    fireEvent.keyDown(cell.querySelector('[role="region"]')!, {key: 'c'});
    await waitFor(() => expect(view.clipboard).toEqual(['a\nb', 'a\nb']));
    expect(cell.querySelector('[role="status"]')?.textContent).toBe('Copied');
  });
});

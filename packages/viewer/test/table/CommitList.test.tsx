import type {Dataset, RowsPage, RowsQuery} from '@glimpse/catalog';
import {act, fireEvent, waitFor} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {datasetFixture, errorDataset, renderExpress, type RenderedSpec} from '../harness.tsx';

const page = (list: string, data = '') => `${data}\nroot=Page('T',[t])\nt=${list}`;
const rowsOf = (view: RenderedSpec) => [...view.cell('t').querySelectorAll<HTMLElement>('[role="option"]')];
const rowAt = (view: RenderedSpec, index: number) => view.cell('t').querySelector<HTMLElement>(`[data-index="${index}"]`)!;
const key = (name: string) => fireEvent.keyDown(document.activeElement!, {key: name});

async function ready(view: RenderedSpec): Promise<HTMLElement> {
  const list = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>('[role="listbox"]');
    if (!found) throw new Error('no list yet');
    return found;
  });
  await view.settle();
  return list;
}

/** The git.log fixture as the whole log (nothing more in the server). */
const complete = (): Record<string, unknown> => ({'/ds/git_log': {...datasetFixture('git.log'), total: 6, truncated: undefined}});

describe('CommitList', () => {
  it('renders sha, subject, refs, author initials, age and change counts', async () => {
    const view = renderExpress(page("CommitList(title='Log')"), {datasets: 'ready', data: complete()});
    const list = await ready(view);
    expect(list.getAttribute('aria-label')).toBe('Log');
    expect(rowsOf(view)).toHaveLength(6);
    const first = rowAt(view, 0);
    expect(first.getAttribute('data-sha')).toBe('4f2a91c0d1');
    expect(first.textContent).toContain('4f2a91c');
    expect(first.textContent).not.toContain('4f2a91c0');
    expect(first.textContent).toContain('Add sliding-window limiter');
    expect(first.textContent).toContain('HEAD');
    expect(first.textContent).toContain('main');
    expect(first.querySelector('[title="Ade"]')!.textContent).toBe('ADAde');
    expect(first.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-17T10:12:00Z');
    expect(first.textContent).toContain('+400 −0');
    expect(rowAt(view, 3).textContent).toContain('+210 −180');
    expect(first.getAttribute('aria-setsize')).toBe('6');
    expect(view.cell('t').querySelector('[data-gl-marginal]')).toBeNull();
    expect(view.errors).toEqual([]);
  });

  it('shows drafting, redline and empty states, and follows a dataset update', async () => {
    const view = renderExpress(page('CommitList()'));
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="drafting"]')).not.toBeNull();
    view.setData('/ds/git_log', errorDataset('git.log', 'E_NO_GIT', 'not a git repository'));
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="redline"]')!.getAttribute('data-code')).toBe('E_NO_GIT');
    view.setData('/ds/git_log', {...datasetFixture('git.log'), data: [], total: 0, truncated: undefined});
    await view.settle();
    expect(view.cell('t').querySelector('[data-gl-state="empty"]')).not.toBeNull();
    view.setData('/ds/git_log', complete()['/ds/git_log']);
    await ready(view);
    expect(rowsOf(view)).toHaveLength(6);
    view.setData('/ds/git_log', {...datasetFixture('git.log'), data: datasetFixture<unknown[]>('git.log').data!.slice(0, 2), total: 2, truncated: undefined});
    await view.settle();
    expect(rowsOf(view)).toHaveLength(2);
  });

  it('redlines a wrong shape and survives malformed rows', async () => {
    const wrong = renderExpress(page('CommitList($/c)', "$/c={sha:'abc'}"));
    await wrong.settle();
    expect(wrong.cell('t').querySelector('[data-gl-state="redline"]')!.getAttribute('data-code')).toBe('E_SHAPE');
    wrong.unmount();

    const view = renderExpress(page('CommitList($/c)'), {
      data: {'/c': [
        {sha: 'abcdef123456', subject: 'Good', author: 'Mira Okafor', date: '2026-11-01T00:00:00Z', add: '12', del: null, refs: ['a', 2, 'b', 'c', 'd']},
        {subject: 'No sha, bad date', date: 'yesterday', author: 42},
        {nothing: true},
        null,
        {sha: 77, add: Number.NaN},
      ]},
    });
    await ready(view);
    expect(rowsOf(view)).toHaveLength(4);
    expect(rowAt(view, 0).textContent).toContain('+12 −0');
    expect(rowAt(view, 0).querySelector('[title="Mira Okafor"]')!.textContent).toContain('MO');
    expect(rowAt(view, 0).querySelector('[title="d"]')!.textContent).toBe('+1');
    expect(rowAt(view, 1).textContent).toContain('No sha, bad date');
    expect(rowAt(view, 2).hasAttribute('data-malformed')).toBe(true);
    expect(rowAt(view, 3).textContent).toContain('77');
    expect(view.cell('t').querySelector('[data-gl-commits-note]')!.textContent).toBe('2 malformed rows');
    expect(view.errors).toEqual([]);
  });

  it('selects a commit entity on click and from the keyboard, and copies the sha', async () => {
    const view = renderExpress(page('CommitList()'), {datasets: 'ready', data: complete()});
    const list = await ready(view);
    fireEvent.click(rowAt(view, 1));
    expect(view.getData('/ui/sel')).toEqual({type: 'commit', id: '9be01d2a77', label: 'Cache tokens with TTL'});
    expect(view.getData('/ui/file') ?? null).toBeNull();
    expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 't', context: {ref: {type: 'commit', id: '9be01d2a77'}}});
    expect(rowAt(view, 1).getAttribute('aria-selected')).toBe('true');
    expect(rowAt(view, 1).getAttribute('data-selected')).toBe('exact');

    act(() => rowAt(view, 1).focus());
    expect([...list.querySelectorAll('[tabindex="0"]')]).toEqual([rowAt(view, 1)]);
    key('ArrowDown');
    expect(document.activeElement).toBe(rowAt(view, 2));
    key('Enter');
    expect(view.getData('/ui/sel')).toMatchObject({type: 'commit', id: '77c0a3e145'});
    expect(list.querySelectorAll('[data-selected]')).toHaveLength(1);
    key('c');
    expect(view.clipboard).toEqual(['77c0a3e145']);
    key('End');
    expect(document.activeElement).toBe(rowAt(view, 5));
    key('Home');
    expect(document.activeElement).toBe(rowAt(view, 0));
    key('Escape');
    expect(view.getData('/ui/sel') ?? null).toBeNull();

    view.setData('/ui/sel', {type: 'commit', id: '0d94e7b216'});
    expect(rowAt(view, 4).getAttribute('data-selected')).toBe('exact');
  });

  it('pages a long log through the host with only the visible rows mounted', async () => {
    const TOTAL = 5000;
    const queries: RowsQuery[] = [];
    const rows = (q: RowsQuery): Promise<RowsPage> => {
      queries.push(q);
      const offset = q.offset ?? 0;
      const length = Math.max(0, Math.min(q.limit ?? 200, TOTAL - offset));
      return Promise.resolve({total: TOTAL, offset, rows: Array.from({length}, (_, i) => ({sha: `${(offset + i).toString(16).padStart(7, '0')}abc`, subject: `Commit number ${offset + i}`, author: 'Jon', date: '2026-10-01T00:00:00Z', add: 3, del: 1}))});
    };
    const ds: Dataset = {...datasetFixture('git.log'), total: TOTAL, truncated: {total: TOTAL, returned: 6, strategy: 'topN', by: 'date'}};
    const view = renderExpress(page("CommitList(title='Log',size='l')"), {datasets: 'ready', host: {rows}, data: {'/ds/git_log': ds}});
    const list = await ready(view);
    expect(queries[0]).toMatchObject({key: 'git_log', offset: 0, limit: 200});
    await waitFor(() => expect(rowAt(view, 0).textContent).toContain('Commit number 0'));
    expect(rowsOf(view).length).toBeLessThan(60);
    expect(rowAt(view, 0).getAttribute('aria-setsize')).toBe('5000');
    expect(view.cell('t').querySelector('[data-gl-commits-note]')!.textContent).toBe('5,000 commits');
    expect(view.cell('t').querySelector('[data-gl-marginal]')).toBeNull();

    list.scrollTop = 28 * 3210;
    fireEvent.scroll(list);
    await waitFor(() => expect(view.cell('t').textContent).toContain('Commit number 3210'));
    expect(queries.some(q => q.offset === 3200)).toBe(true);
    expect(rowsOf(view).length).toBeLessThan(60);
  });
});

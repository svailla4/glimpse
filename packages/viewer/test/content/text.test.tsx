// Text, FileRef and Callout: inline micro-markup, file refs as entities, tones and kinds.
import {fireEvent, screen, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {renderExpress} from '../harness.tsx';

describe('Text', () => {
  it('renders each tone and the inline micro-markup, and nothing else as markup', async () => {
    const view = renderExpress(
      `root=Page('T',[a,b,c,d,e])
a=Text('Plain **strong *nested* text** and *em* with \`code()\` <b>not html</b> 2 * 3 * 4')
b=Text('Lead','lead')
c=Text('Dim','dim')
d=Text('Caption','caption')
e=Text('mono  text','mono')`,
    );
    const a = view.cell('a');
    expect(a.getAttribute('data-gl')).toBe('Text');
    expect(a.querySelector('p')?.getAttribute('data-tone')).toBe('body');
    expect(a.querySelector('strong')?.textContent).toBe('strong nested text');
    expect(a.querySelector('strong em')?.textContent).toBe('nested');
    expect([...a.querySelectorAll('em')].map(em => em.textContent)).toEqual(['nested', 'em']);
    expect(a.querySelector('code')?.textContent).toBe('code()');
    // raw HTML is text, and a lone asterisk between spaces is not emphasis
    expect(a.querySelector('b')).toBeNull();
    expect(a.textContent).toContain('<b>not html</b> 2 * 3 * 4');
    for (const [id, tone] of [['b', 'lead'], ['c', 'dim'], ['d', 'caption'], ['e', 'mono']] as const) {
      expect(view.cell(id).querySelector('p')?.getAttribute('data-tone')).toBe(tone);
    }
    expect(view.errors).toEqual([]);
  });

  it('turns [[path#L10-20]] into a file entity: click selects, Cmd-click and `o` open, `c` copies, Escape clears', async () => {
    const view = renderExpress(`root=Page('T',[a])\na=Text('Entry point is [[src/main.ts#L12-20]] today.')`);
    const link = within(view.cell('a')).getByRole('button');
    expect(link.getAttribute('data-entity-type')).toBe('file');
    expect(link.getAttribute('data-entity-id')).toBe('src/main.ts');
    expect(link.textContent).toContain('main.ts');
    expect(view.cell('a').textContent).not.toContain('[[');

    fireEvent.click(link);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/main.ts', path: 'src/main.ts', line: 12, endLine: 20});
    expect(view.getData('/ui/file')).toBe('src/main.ts#L12-20');
    await waitFor(() => expect(view.actions.map(action => action.name)).toEqual(['gl_select']));
    expect(link.getAttribute('data-selected')).toBe('true');

    fireEvent.click(link, {metaKey: true});
    fireEvent.keyDown(link, {key: 'o'});
    await waitFor(() => expect(view.actions.filter(action => action.name === 'gl_open')).toHaveLength(2));
    expect(view.actions.at(-1)).toMatchObject({sourceComponentId: 'a', context: {file: 'src/main.ts#L12-20'}});

    fireEvent.keyDown(link, {key: 'c'});
    expect(view.clipboard).toEqual(['src/main.ts:12']);
    fireEvent.keyDown(link, {key: 'Escape'});
    expect(view.getData('/ui/sel') ?? null).toBeNull();
  });

  it('follows a binding, coerces non-strings and renders nothing for an empty string', async () => {
    const view = renderExpress(`$/msg='first'\nroot=Page('T',[a,b])\na=Text($/msg)\nb=Text('')`);
    expect(view.cell('a').textContent).toBe('first');
    expect(view.cell('b').querySelector('p')).toBeNull();
    view.setData('/msg', 'second with `code`');
    await waitFor(() => expect(view.cell('a').querySelector('code')?.textContent).toBe('code'));
    view.setData('/msg', 42);
    await waitFor(() => expect(view.cell('a').textContent).toBe('42'));
    view.setData('/msg', '');
    await waitFor(() => expect(view.cell('a').querySelector('p')).toBeNull());
    view.setData('/msg', null);
    await view.settle();
    expect(view.cell('a').querySelector('p')).toBeNull();
    expect(view.container.querySelector('[data-gl-state="redline"]')).toBeNull();
  });

  it('stays linear on a long text full of unmatched markers', () => {
    const hostile = '**a [[c *d ~ '.repeat(5000);
    const started = performance.now();
    const view = renderExpress(`$/msg=''\nroot=Page('T',[a])\na=Text($/msg)`, {data: {'/msg': hostile}});
    expect(view.cell('a').textContent).toBe(hostile);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('FileRef', () => {
  it('renders the path as an entity link with its line range, or the label when given', async () => {
    const view = renderExpress(`root=Page('T',[a,b])\na=FileRef('src/auth/cache.ts#L5-30')\nb=FileRef('src/auth/service.ts','the service')`);
    const a = within(view.cell('a')).getByRole('button');
    expect(a.querySelector('.gl-path-dir')?.textContent).toBe('src/auth/');
    expect(a.querySelector('.gl-path-base')?.textContent).toBe('cache.ts');
    expect(a.querySelector('.gl-path-line')?.textContent).toBe(':5-30');
    const b = within(view.cell('b')).getByRole('button');
    expect(b.querySelector('.gl-path-base')?.textContent).toBe('the service');
    fireEvent.click(b);
    expect(view.getData('/ui/file')).toBe('src/auth/service.ts');
    expect(b.getAttribute('data-selected')).toBe('true');
    expect(a.hasAttribute('data-selected')).toBe(false);
  });

  it('strikes through a file the host reports missing, and asks once per path', async () => {
    const view = renderExpress(`root=Page('T',[a,b,c])\na=FileRef('src/missing.ts#L3')\nb=FileRef('src/missing.ts')\nc=FileRef('src/auth/service.ts')`);
    await waitFor(() => expect(view.cell('a').querySelector('[data-missing]')).not.toBeNull());
    expect(view.cell('b').querySelector('[data-missing]')).not.toBeNull();
    expect(view.cell('c').querySelector('[data-missing]')).toBeNull();
    const probes = view.host.calls.filter(call => call.method === 'file').map(call => (call.args[0] as {path: string}).path);
    expect(probes.sort()).toEqual(['src/auth/service.ts', 'src/missing.ts']);
    // the working tree changed: the file may exist now, so it is asked again
    view.setData('/meta/rev', 2);
    await waitFor(() => expect(view.host.calls.filter(call => call.method === 'file')).toHaveLength(4));
  });

  it('marks a file inside the selected directory, treats a trailing slash as a directory, and survives a failing host', async () => {
    const view = renderExpress(`$/f='src/auth/cache.ts'\nroot=Page('T',[a,b,c])\na=FileRef($/f)\nb=FileRef('src/auth/')\nc=FileRef('')`, {
      host: {file: () => Promise.reject(new Error('offline'))},
    });
    expect(view.cell('c').querySelector('button')).toBeNull();
    const dir = within(view.cell('b')).getByRole('button');
    expect(dir.getAttribute('data-entity-type')).toBe('dir');
    fireEvent.click(dir);
    expect(view.getData('/ui/sel')).toMatchObject({type: 'dir', id: 'src/auth', path: 'src/auth'});
    await waitFor(() => expect(view.cell('a').querySelector('[data-within]')).not.toBeNull());
    // binding update: the link follows, and is no longer inside the selection
    view.setData('/f', 'src/api/routes.ts');
    await waitFor(() => expect(within(view.cell('a')).getByRole('button').getAttribute('data-entity-id')).toBe('src/api/routes.ts'));
    expect(view.cell('a').querySelector('[data-within]')).toBeNull();
    await view.settle();
    expect(view.container.querySelector('[data-missing]')).toBeNull();
    expect(view.container.querySelector('[data-gl-state="redline"]')).toBeNull();
  });
});

describe('Callout', () => {
  it('names its kind in a tag, leads with the title and anchors the file on the last line', async () => {
    const view = renderExpress(
      `root=Page('T',[a,b,c])
a=Callout('Reads the balance *before* taking the row lock.','risk',title='Race',file='src/ledger/post.ts#L42')
b=Callout('Tokens are cached for 15 minutes.')
c=Callout('Per-IP or per-user limits?','question')`,
    );
    const a = view.cell('a');
    const aside = a.querySelector('aside')!;
    expect(aside.getAttribute('data-kind')).toBe('risk');
    expect(aside.style.getPropertyValue('--callout-ink')).toBe('var(--gl-critical)');
    expect(aside.firstElementChild?.textContent).toBe('Risk');
    expect(a.querySelector('strong')?.textContent).toBe('Race. ');
    expect(a.querySelector('em')?.textContent).toBe('before');
    const file = within(a).getByRole('button');
    expect(file.getAttribute('data-entity-id')).toBe('src/ledger/post.ts');
    expect(aside.lastElementChild?.contains(file)).toBe(true);
    fireEvent.click(file);
    expect(view.getData('/ui/file')).toBe('src/ledger/post.ts#L42');
    // default kind is note; every kind has its own word, so colour is never the only channel
    expect(view.cell('b').querySelector('aside')?.getAttribute('data-kind')).toBe('note');
    expect(view.cell('b').querySelector('aside')?.firstElementChild?.textContent).toBe('Note');
    expect(view.cell('c').querySelector('aside')?.firstElementChild?.textContent).toBe('Question');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('follows bindings and renders nothing when there is nothing to say', async () => {
    const view = renderExpress(`$/note=''\nroot=Page('T',[a])\na=Callout($/note,'tip')`);
    expect(view.cell('a').querySelector('aside')).toBeNull();
    view.setData('/note', 'Use the cache.');
    await waitFor(() => expect(view.cell('a').querySelector('aside')?.textContent).toBe('TipUse the cache.'));
    view.setData('/note', {not: 'a string'});
    await waitFor(() => expect(view.cell('a').querySelector('aside')).toBeNull());
  });
});

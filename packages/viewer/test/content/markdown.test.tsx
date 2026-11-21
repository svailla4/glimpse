// Markdown: prose rendering and the security rules of design 2.8 (no raw HTML, http(s) links only, no remote images).
import {fileRefs, parseFileLoc} from '@glimpse/catalog';
import {fireEvent, waitFor, within} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {renderExpress, type RenderedSpec} from '../harness.tsx';

const SPEC = `$/notes=''\nroot=Page('T',[m,after])\nm=Markdown($/notes)\nafter=Text('after')`;

async function renderNotes(source: string): Promise<{view: RenderedSpec; cell: HTMLElement}> {
  const view = renderExpress(SPEC, {data: {'/notes': source}});
  await waitFor(() => expect(view.cell('m').querySelector('[data-gl-markdown="prose"]')).not.toBeNull());
  return {view, cell: view.cell('m')};
}

describe('Markdown', () => {
  it('renders headings, emphasis, lists, task marks and a hairline table', async () => {
    const {view, cell} = await renderNotes(
      ['# Title', '## Section', '### Detail', 'Prose with **bold**, *em* and `code`.', '', '- one', '- two', '', '1. first', '2. second', '', '- [x] shipped', '- [ ] pending', '', '| File | LOC |', '|---|--:|', '| a.ts | 12 |', '', '> quoted', '', '---'].join('\n'),
    );
    expect(cell.querySelector('h3')?.textContent).toBe('Title');
    expect(cell.querySelector('h4')?.textContent).toBe('Section');
    expect(cell.querySelector('h5')?.textContent).toBe('Detail');
    // heading ids from the parser are dropped: several documents share the page
    expect(cell.querySelectorAll('[id]')).toHaveLength(0);
    expect(cell.querySelector('strong')?.textContent).toBe('bold');
    expect(cell.querySelector('em')?.textContent).toBe('em');
    expect(cell.querySelector('p code')?.textContent).toBe('code');
    expect([...cell.querySelectorAll('ul li')].map(li => li.textContent?.trim())).toEqual(['one', 'two', 'shipped', 'pending']);
    expect([...cell.querySelectorAll('ol li')].map(li => li.textContent)).toEqual(['first', 'second']);
    expect(within(cell).getByRole('img', {name: 'done'})).toBeTruthy();
    expect(within(cell).getByRole('img', {name: 'to do'})).toBeTruthy();
    expect(cell.querySelector('input')).toBeNull();
    expect([...cell.querySelectorAll('th')].map(th => th.textContent)).toEqual(['File', 'LOC']);
    expect([...cell.querySelectorAll('td')].map(td => td.textContent)).toEqual(['a.ts', '12']);
    expect((cell.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');
    expect(cell.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(cell.querySelector('hr')).not.toBeNull();
    expect(view.errors).toEqual([]);
  });

  it('never parses raw HTML: tags stay literal text and nothing executable reaches the DOM', async () => {
    const {cell} = await renderNotes(
      ['<script>window.pwned = 1</script>', '', '<img src="x.png" onerror="window.pwned = 1">', '', '<iframe src="about:blank"></iframe>', '', 'inline <b onclick="window.pwned = 1">bold</b> and <a href="javascript:window.pwned=1">link</a>', '', '<style>body { display: none }</style>'].join('\n'),
    );
    for (const tag of ['script', 'img', 'iframe', 'b', 'a', 'style']) expect(cell.querySelector(tag), tag).toBeNull();
    expect(cell.querySelectorAll('[onclick], [onerror], [href], [src]')).toHaveLength(0);
    expect(cell.textContent).toContain('<script>window.pwned = 1</script>');
    expect(cell.textContent).toContain('<b onclick="window.pwned = 1">bold</b>');
    expect((window as unknown as {pwned?: number}).pwned).toBeUndefined();
  });

  it('links only http(s), opened in a new tab without opener or referrer; every other scheme is plain text', async () => {
    const {cell} = await renderNotes(
      [
        '[site](https://example.com/a?b=1 "Example") and [plain](http://example.org) and https://auto.example/x',
        '[js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [data](data:text/html,<script>alert(1)</script>) [vb](vbscript:msgbox(1))',
        '[mail](mailto:someone@example.com) [file](file:///etc/passwd) [proto](//evil.example/x) [abs](/etc/passwd) [hash](#top)',
        '',
        '[ref]: javascript:alert(2)',
        '',
        '[by reference][ref]',
      ].join('\n'),
    );
    const anchors = [...cell.querySelectorAll('a')];
    expect(anchors.map(a => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1', 'http://example.org', 'https://auto.example/x']);
    for (const a of anchors) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    expect(anchors[0]!.getAttribute('title')).toBe('Example');
    // the labels of refused links are still readable
    for (const label of ['js', 'JS', 'data', 'vb', 'mail', 'file', 'proto', 'abs', 'hash', 'by reference']) expect(cell.textContent).toContain(label);
    expect(cell.innerHTML).not.toMatch(/javascript:|vbscript:|data:text|mailto:|file:\/\//i);
    expect(cell.querySelectorAll('button')).toHaveLength(0);
  });

  it('never fetches an image: it becomes a chip with its alt text', async () => {
    const {cell} = await renderNotes('Before ![architecture diagram](https://example.com/arch.png "Arch") after ![](data:image/png;base64,AAAA)');
    expect(cell.querySelector('img')).toBeNull();
    expect(cell.innerHTML).not.toContain('example.com/arch.png');
    expect(cell.innerHTML).not.toContain('base64');
    expect([...cell.querySelectorAll('[data-gl-image]')].map(chip => chip.textContent)).toEqual(['image: architecture diagram', 'image']);
  });

  it('renders [[path]] refs and relative links as file entities, but leaves refs inside code alone', async () => {
    const {view, cell} = await renderNotes(
      ['See [[src/__tests__/a_b.test.ts#L10-20]] and [the service](src/auth/service.ts#L20) and [[docs/My Notes.md]].', '', 'Inline `[[not/a/ref.ts]]` stays.', '', '```sh', 'if [[ -f a.ts ]]; then echo [[src/x.ts]]; fi', '```'].join('\n'),
    );
    const links = within(cell).getAllByRole('button').filter(button => button.hasAttribute('data-entity-id'));
    expect(links.map(link => link.getAttribute('data-entity-id'))).toEqual(['src/__tests__/a_b.test.ts', 'src/auth/service.ts', 'docs/My Notes.md']);
    expect(links[1]!.querySelector('.gl-path-base')?.textContent).toBe('the service');
    expect(cell.querySelector('p code')?.textContent).toBe('[[not/a/ref.ts]]');
    expect(cell.textContent).toContain('if [[ -f a.ts ]]; then echo [[src/x.ts]]; fi');
    expect(cell.textContent).not.toContain('glref');
    fireEvent.click(links[0]!);
    expect(view.getData('/ui/sel')).toEqual({type: 'file', id: 'src/__tests__/a_b.test.ts', path: 'src/__tests__/a_b.test.ts', line: 10, endLine: 20});
    expect(view.getData('/ui/file')).toBe('src/__tests__/a_b.test.ts#L10-20');
    await waitFor(() => expect(view.actions.at(-1)).toMatchObject({name: 'gl_select', sourceComponentId: 'm'}));
  });

  // The server checks the refs fileRefs finds (spec/expand.ts): exactly the ones drawn here as links.
  it('draws as links exactly the [[path]] refs the catalog extractor finds for the server to check', async () => {
    const source = ['**[[a.ts#L3]]** and ``[[b.ts]]`` and [[c/]]', '```', '[[fenced.ts]]', '````', '- [[d.ts]]', '~~~', '[[tilde.ts]]', '~~~', '> [[e.ts]]'].join('\n');
    const {cell} = await renderNotes(source);
    const drawn = within(cell).getAllByRole('button').filter(button => button.hasAttribute('data-entity-id')).map(link => `${link.getAttribute('data-entity-id')}${link.getAttribute('data-entity-type') === 'dir' ? '/' : ''}`);
    expect(drawn).toEqual(fileRefs(source, true).map(loc => parseFileLoc(loc).path));
    expect(drawn).toEqual(['a.ts', 'c/', 'd.ts', 'e.ts']);
  });

  it('renders fenced code through the code chunk or the plain fallback, never as markup', async () => {
    const {view, cell} = await renderNotes(['```ts', 'const tag = "<img src=x onerror=alert(1)>";', 'export const n = 1;', '```'].join('\n'));
    await view.settle();
    expect(cell.textContent).toContain('const tag = "<img src=x onerror=alert(1)>";');
    expect(cell.textContent).toContain('export const n = 1;');
    expect(cell.querySelector('img')).toBeNull();
    // the borrowed view never takes the prose down with it
    expect(view.cell('m').querySelector('[data-gl-state="redline"]')).toBeNull();
    expect(view.cell('after').textContent).toBe('after');
  });

  it('renders nothing for an empty string and follows the agent patching its slot', async () => {
    const view = renderExpress(SPEC);
    await view.settle();
    expect(view.cell('m').querySelector('.gl-body')?.childElementCount).toBe(0);
    view.send({version: '1.0', updateDataModel: {surfaceId: 'test', path: '/notes', value: 'hello **world**'}});
    await waitFor(() => expect(view.cell('m').querySelector('strong')?.textContent).toBe('world'));
    view.send({version: '1.0', updateDataModel: {surfaceId: 'test', path: '/notes', value: 'second *draft*'}});
    await waitFor(() => expect(view.cell('m').querySelector('em')?.textContent).toBe('draft'));
    expect(view.cell('m').querySelector('strong')).toBeNull();
    view.send({version: '1.0', updateDataModel: {surfaceId: 'test', path: '/notes', value: '   '}});
    await waitFor(() => expect(view.cell('m').querySelector('[data-gl-markdown]')).toBeNull());
    // a binding that resolves to something that is not text renders nothing rather than failing
    view.setData('/notes', {a: 1});
    await view.settle();
    expect(view.cell('m').querySelector('[data-gl-state]')).toBeNull();
    expect(view.errors).toEqual([]);
  });

  it('cuts a huge source at a line break and says so', async () => {
    const line = 'A line of prose that repeats to make the document very long indeed.\n\n';
    const {cell} = await renderNotes(line.repeat(4000));
    expect(cell.textContent).toMatch(/showing the first [\d,]+ of [\d,]+ characters/);
    expect(cell.querySelectorAll('p').length).toBeLessThan(3200);
  });
});

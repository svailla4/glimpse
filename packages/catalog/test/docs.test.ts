import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  COMPONENTS, EXAMPLES, SKILL_DESCRIPTION, SOURCES, VIEWS, componentDoc, componentIndex, exampleCall, examplesDoc, hasFrame, partsOf,
  serverInstructions, signatureOf, skillMarkdown, sourceDoc, sourceIndex, typedSignatureList, viewDoc,
} from '../src/index.ts';
import {buildArtifacts} from '../testing/artifacts.ts';
import {readText} from './support.ts';

describe('server instructions', () => {
  const text = serverInstructions();

  it('fit the always-loaded slot (budget 4,000 characters; the host cuts at 4,096)', () => {
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('name every source, every preset and every component', () => {
    for (const source of SOURCES) expect(text).toContain(source.name);
    for (const view of VIEWS) expect(text).toContain(view.name);
    const index = componentIndex();
    expect(text).toContain(index);
    for (const def of COMPONENTS) expect(index, def.name).toMatch(new RegExp(`(^|[ |])${def.name}[|(]`, 'm'));
  });

  it('carry no absolute paths and no line longer than the host wraps badly', () => {
    expect(text).not.toMatch(/\/Users\/|\/home\//);
    expect(text.split('\n').length).toBeGreaterThan(15);
  });
});

describe('component docs', () => {
  it('componentIndex has one line per family and merges identical argument lists', () => {
    const lines = componentIndex().split('\n');
    expect(lines.map(l => l.split(':')[0])).toEqual(['Layout', 'Content', 'Data', 'Charts', 'Diagrams', 'Code', 'Input']);
    expect(componentIndex()).toContain('Chips|Stats(data?)');
    expect(componentIndex()).not.toContain('span');
  });

  it('typedSignatureList has one line per component under seven family headers', () => {
    const lines = typedSignatureList().split('\n');
    expect(lines.filter(l => l.startsWith('# '))).toHaveLength(7);
    expect(lines.filter(l => /^[ABC] /.test(l))).toHaveLength(COMPONENTS.length);
    expect(lines).toContain('A DataTable(data*~:Rows, columns:str, sort:str, search:flag, group:str) +frame');
    expect(lines).toContain("A Chips(data~:ChipItem[]='repo.stack')");
  });

  it.each(COMPONENTS.map(def => [def.name, def] as const))('componentDoc(%s) is a compact, complete entry', (name, def) => {
    const doc = componentDoc(name)!;
    expect(doc.length).toBeGreaterThanOrEqual(100);
    expect(doc.length).toBeLessThanOrEqual(1000);
    expect(doc.startsWith(signatureOf(def))).toBe(true);
    expect(doc).toContain(def.doc);
    expect(doc).toContain(`e.g. ${def.example}`);
    for (const key of Object.keys(def.props)) if (key !== 'span') expect(doc, key).toContain(`  ${key}: `);
  });

  it('frame components omit the shared props from their signature', () => {
    const table = COMPONENTS.find(c => c.name === 'DataTable')!;
    expect(hasFrame(table)).toBe(true);
    expect(signatureOf(table)).toBe('DataTable(data, columns?, sort?, search?, group?)');
    expect(hasFrame(COMPONENTS.find(c => c.name === 'Plate')!)).toBe(false);
    expect(componentDoc('Nope')).toBeUndefined();
  });
});

describe('source docs', () => {
  it('sourceIndex lists the 26 sources', () => {
    expect(SOURCES).toHaveLength(26);
    expect(sourceIndex().split(' ')).toEqual(SOURCES.map(s => s.name));
  });

  it.each(SOURCES.map(s => [s.name, s] as const))('sourceDoc(%s) shows the ref grammar, kind, budget and fields', (name, source) => {
    const doc = sourceDoc(name)!;
    expect(doc.startsWith(`'${name}`)).toBe(true);
    expect(doc).toContain(`-> ${source.kind}`);
    expect(doc).toContain(`max ${source.budget}`);
    for (const field of source.fields ?? []) expect(doc).toContain(field.key);
    for (const arg of Object.keys(source.args ?? {})) expect(doc).toContain(`[${arg}=]`);
    if (source.target) expect(doc).toContain(source.targetRequired ? `<${source.target}>` : `[${source.target}]`);
  });

  it('answers undefined for an unknown source', () => {
    expect(sourceDoc('git.nope')).toBeUndefined();
  });
});

describe('view docs', () => {
  it.each(VIEWS.map(v => [v.name, v] as const))('viewDoc(%s) gives the doc, slots, parts and Express source', (name, view) => {
    const doc = viewDoc(name)!;
    expect(viewDoc(`view:${name}`)).toBe(doc);
    expect(doc.startsWith(`view:${name}`)).toBe(true);
    expect(doc).toContain(view.doc);
    for (const slot of Object.keys(view.slots ?? {})) expect(doc).toContain(`slot $${slot}: `);
    const source = view.build(view.targetRequired ? (view.target === 'symbol' ? '<name>' : `<${view.target}>`) : undefined, {});
    expect(doc.endsWith(source)).toBe(true);
    expect(doc).toContain(`  parts: ${partsOf(source).join(' ')}`);
  });

  it('builds the source for a given target', () => {
    expect(viewDoc('view:diff', 'main..HEAD')).toContain("DiffView('main..HEAD'");
    expect(viewDoc('tree', 'src/auth')).toContain("FileTree('files.tree src/auth'");
  });

  it('documents the gallery and rejects unknown names', () => {
    expect(viewDoc('view:gallery')).toContain('parts: layout content data charts diagrams code input');
    expect(viewDoc('view:nope')).toBeUndefined();
  });

  it('partsOf lists named parts in order without root', () => {
    expect(partsOf(`$/notes=''\nroot=Page('T',[a,b])\na=Text('x')\nb = Text('y')\na=Text('z')`)).toEqual(['a', 'b']);
  });
});

describe('examples and the plugin skill', () => {
  it('has the six recipes of the design, each a complete call', () => {
    expect(EXAMPLES.map(e => e.title)).toEqual(['Explain a module', 'Review a branch', 'Plan a feature', 'Trace a request', 'Find hotspots', 'Compare two modules']);
    for (const example of EXAMPLES) {
      expect(example.view ?? example.id, example.title).toBeTruthy();
      expect(exampleCall(example)).toMatch(/^show\{(view|id):/);
      if (!example.view) expect(example.spec).toMatch(/^root=Page\(/);
    }
    expect(examplesDoc().split('\n\n')).toHaveLength(6);
  });

  it('skillMarkdown has the front matter the plugin needs, the instructions and every recipe', () => {
    const skill = skillMarkdown();
    expect(skill.startsWith(`---\nname: glimpse\ndescription: ${SKILL_DESCRIPTION}\n---\n`)).toBe(true);
    expect(skill).toContain(serverInstructions());
    for (const example of EXAMPLES) {
      expect(skill).toContain(`### ${example.title}`);
      if (example.spec) expect(skill).toContain(example.spec);
    }
    expect(skill).not.toMatch(/\/Users\/|\/home\//);
  });
});

describe('generated files are fresh', () => {
  const artifacts = buildArtifacts();

  it('covers catalog.json, instructions, signatures, the gallery, 26 datasets and 4 host answers', () => {
    expect(Object.keys(artifacts)).toHaveLength(3 + 1 + 26 + 4);
  });

  it.each(Object.keys(artifacts).map(path => [path] as const))('%s matches what `npm run generate` writes', path => {
    expect(existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url))), `${path} is missing: run "npm run generate"`).toBe(true);
    expect(readText(`../${path}`) === artifacts[path], `${path} is stale: run "npm run generate"`).toBe(true);
  });

  it('instructions.txt is serverInstructions() and signatures.txt is typedSignatureList()', () => {
    expect(readText('../generated/instructions.txt')).toBe(serverInstructions() + '\n');
    expect(readText('../generated/signatures.txt')).toBe(typedSignatureList() + '\n');
  });
});

// Decision views-are-blueprints: models copy a worked example more faithfully than a rule, so every recipe the skill
// and catalog{names:['examples']} teach is shown here the way a model would send it, and must draw as written: no
// `fixed` line (the example would teach a variant the server has to correct) and no `warn` line except for the
// example paths, which the fixture repository does not have.
import {EXAMPLES, VIEW_BY_NAME, parseViewRef} from '@glimpse/catalog';
import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {tempRoot, testSession, type TestSession} from './fakes.ts';

let dir: Awaited<ReturnType<typeof tempRoot>>;
beforeAll(async () => {
  dir = await tempRoot();
});
afterAll(() => dir.cleanup());

const live: TestSession[] = [];
afterEach(() => {
  for (const t of live.splice(0)) t.session.dispose();
});

/** A missing example path, or an example range the fixture cannot resolve: the only lines an example may give. */
const EXAMPLE_PATH = /\b(src|test)\/[\w/.-]+|main\.\.HEAD/;

describe('the recipes draw as written', () => {
  it.each(EXAMPLES.map(e => [e.title, e] as const))('%s', async (_title, example) => {
    const t = testSession(dir.root);
    live.push(t);
    const ref = example.view ? parseViewRef(example.view) : undefined;
    const outcome = ref
      ? await t.session.show({id: ref.view, view: ref.view, sources: [VIEW_BY_NAME.get(ref.view)!.build(ref.target, ref.args), example.spec ?? ''], fresh: true})
      : await t.session.show({id: example.id!, sources: [example.spec!], fresh: false});
    await outcome.checks;
    expect(outcome.fixes).toEqual([]);
    expect(outcome.warnings.filter(line => !EXAMPLE_PATH.test(line))).toEqual([]);
  });
});

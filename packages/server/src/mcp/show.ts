// The `show` tool (design 6.1; steps 0, 1 and 10 of 2.2): arguments to Express sources, then the session's
// pipeline, then a bounded wait for the datasets the call asked for.
import {GALLERY_SPEC, parseViewRef, VIEW_BY_NAME, VIEW_INDEX} from '@glimpse/catalog';
import {nearest, problem, SpecError} from '../spec/errors.ts';
import {isSafeRange} from '../session/paths.ts';
import type {Session, ShowRequest} from '../session/session.ts';
import {repoLine, showFailure, showText, text, type RepoFacts, type ToolResult} from './result.ts';

export const SHOW_DESCRIPTION =
  'Render a view of this codebase in the user\'s browser tab. view: a preset such as "overview", "file src/a.ts" or "diff main..HEAD". spec: A2UI Express for a custom view, or a patch when id exists. Data stays local: name sources, never paste data.';

export const SHOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    view: {type: 'string', description: "Preset and target, e.g. 'overview', 'tree src', 'diff main..HEAD'."},
    spec: {type: 'string', description: 'Express statements: root=Page(...) for a new view, or name=Comp(...) / $/path=value to patch.'},
    id: {type: 'string', description: "Surface slug. Default: the preset name, or 'main'."},
  },
} as const;

export interface ShowArgs { view?: string; spec?: string; id?: string }

const ID = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** Far above any real spec (the gallery, inline fixture data included, is about 12,000 characters). */
export const MAX_SPEC_CHARS = 200_000;
const GALLERY = 'gallery';
export const DEFAULT_SETTLE_MS = 1500;

/** A preset call ("diff main..HEAD") as its name and Express source. */
function buildView(call: string): {name: string; source: string} {
  const {view: name, target, args} = parseViewRef(call);
  if (name === GALLERY) return {name, source: GALLERY_SPEC};
  const view = VIEW_BY_NAME.get(name);
  if (!view) {
    throw new SpecError([problem('E_VIEW', `unknown view "${name.slice(0, 40)}". Nearest: ${nearest(name, [...VIEW_BY_NAME.keys(), GALLERY], 2).join(' ')}. Views: ${VIEW_INDEX}`)]);
  }
  if (view.targetRequired && !target) {
    const what = view.target === 'symbol' ? 'name' : view.target;
    throw new SpecError([problem('E_VIEW', `view "${name}" needs a ${what}: show{view:"${name} <${what}>"}`)]);
  }
  if (view.target === 'range' && target !== undefined && !isSafeRange(target)) {
    throw new SpecError([problem('E_VIEW', `"${target.slice(0, 60)}" is not a range. Use wt, staged, a ref such as main, or a range such as main..HEAD.`)]);
  }
  return {name, source: view.build(view.target ? target : undefined, args)};
}

/** Step 0 and 1: validates the arguments and produces what the pipeline compiles. Throws SpecError. */
export function showRequest(args: ShowArgs): ShowRequest {
  const call = typeof args.view === 'string' ? args.view.trim() : '';
  const spec = typeof args.spec === 'string' ? args.spec : '';
  if (!call && !spec.trim()) throw new SpecError([problem('E_VIEW', `show needs view or spec. Views: ${VIEW_INDEX}`)]);
  if (spec.length > MAX_SPEC_CHARS) {
    throw new SpecError([problem('E_SPEC', `the spec is ${spec.length.toLocaleString('en-US')} characters; the limit is ${MAX_SPEC_CHARS.toLocaleString('en-US')}. Name a source ('files.list src') instead of pasting data.`)]);
  }
  const preset = call ? buildView(call) : undefined;
  const id = args.id?.trim() || preset?.name || 'main';
  if (!ID.test(id)) {
    throw new SpecError([problem('E_ID', `id "${id.slice(0, 40)}" is not a slug: use letters, digits and _ (at most 32, not starting with a digit), e.g. "auth_flow".`)]);
  }
  return {
    id,
    sources: [...(preset ? [preset.source] : []), ...(spec.trim() ? [spec] : [])],
    fresh: preset !== undefined,
    ...(call ? {view: call} : {}),
  };
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    void work.catch(() => {}).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Runs `show` and formats its result. Never throws: every failure is an error result. */
export async function showTool(session: Session, args: ShowArgs, settleMs = DEFAULT_SETTLE_MS, now: () => number = Date.now): Promise<ToolResult> {
  const started = now();
  try {
    const request = showRequest(args);
    const outcome = await session.show(request);

    // The repo line needs the language mix; it rides on the same bounded wait as the view's own datasets.
    let langs: RepoFacts['langs'];
    const wantRepo = request.fresh || outcome.first;
    const repoRun = wantRepo
      ? session.runRef('files.langs').then(({outcome: result}) => {
          if (result.ok && Array.isArray(result.result.data)) langs = result.result.data as RepoFacts['langs'];
        })
      : Promise.resolve();
    await withTimeout(Promise.all([repoRun, ...outcome.datasets.map(dataset => dataset.settled)]), settleMs);

    const {repo} = session.meta();
    return text(showText({
      outcome,
      elapsedMs: now() - started,
      ...(wantRepo ? {repo: repoLine({name: repo.name, ...(repo.branch ? {branch: repo.branch} : {}), ...(repo.head ? {head: repo.head} : {}), dirty: repo.dirty, ...(langs ? {langs} : {})})} : {}),
      datasets: outcome.datasets.map(dataset => ({ref: dataset.ref, state: session.datasetState(outcome.id, dataset.key)})),
      events: session.events.drain(),
    }));
  } catch (error) {
    return showFailure(error);
  }
}

// The `show` tool (design 6.1; steps 0, 1 and 10 of 2.2): arguments to Express sources, then the session's
// pipeline, then a bounded wait for the datasets the call asked for and for what the tab says it drew.
import {GALLERY_SPEC, gallerySpec, parseViewRef, VIEW_BY_NAME, VIEW_INDEX} from '@glimpse/catalog';
import {nearest, oneLine, problem, SpecError} from '../spec/errors.ts';
import {UNSAFE_KEYS} from '../spec/guard.ts';
import {isSafeRange} from '../session/paths.ts';
import type {Session, ShowOutcome, ShowRequest} from '../session/session.ts';
import {okLine, repoLine, shield, showFailure, showText, type RepoFacts, type ToolResult} from './result.ts';

export const SHOW_DESCRIPTION =
  'Render a view of this codebase in the user\'s browser tab. view: a preset such as "overview", "file src/a.ts" or "diff main..HEAD". spec: A2UI Express for a custom view, or a patch when id exists. Data stays local: name sources, never paste data.';

export const SHOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    view: {type: 'string', description: "Preset and target, e.g. 'overview', 'tree src', 'diff main..HEAD'."},
    spec: {type: 'string', description: 'Express statements: root=Page(...) for a new view, or name=Comp(...) / $/path=value to patch.'},
    id: {type: 'string', description: "Surface slug. Default: the preset name, or 'main'."},
    path: {type: 'string', description: 'Preset target, if not in view.'},
  },
} as const;

export interface ShowArgs { view?: string; spec?: string; id?: string; path?: string }

/** Decision D2: letters, digits, `_` and `-`, at most 48, not starting with a hyphen. */
export const SURFACE_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,47}$/;
/** Far above any real spec (the gallery, inline fixture data included, is about 12,000 characters). */
export const MAX_SPEC_CHARS = 200_000;
const GALLERY = 'gallery';
export const DEFAULT_SETTLE_MS = 1500;
/** Decision D3: how long a `show` goes on listening to a live tab after its datasets have settled. */
export const REPORT_GRACE_MS = 300;
/** Keyword spellings of a preset's one positional target (`hotspots path=src`), by what the preset takes. */
const TARGET_KEYS = ['path', 'target', 'dir', 'file', 'range', 'name', 'symbol'];

/** A preset call ("diff main..HEAD") as its name and Express source, plus what was adjusted on the way. */
function buildView(call: string, fixes: string[]): {name: string; source: string; call: string} {
  const parsed = parseViewRef(call);
  const {view: name} = parsed;
  // `gallery src/main.ts` shows that file in the Code section; plain `gallery` gets one picked by showTool().
  if (name === GALLERY) return parsed.target ? {name, source: gallerySpec({file: parsed.target}), call: `${name} ${parsed.target}`} : {name, source: GALLERY_SPEC, call: name};
  const view = VIEW_BY_NAME.get(name);
  if (!view) {
    throw new SpecError([problem('E_VIEW', `unknown view "${name.slice(0, 40)}". Nearest: ${nearest(name, [...VIEW_BY_NAME.keys(), GALLERY], 2).join(' ')}. Views: ${VIEW_INDEX}`)]);
  }
  // The target is positional ("hotspots src"); written as a keyword it would be passed on as a source argument
  // no source knows, or silently dropped.
  let target = parsed.target;
  const args = {...parsed.args};
  const keyword = view.target && target === undefined ? TARGET_KEYS.find(key => Object.hasOwn(args, key) && args[key] !== '') : undefined;
  if (keyword !== undefined) {
    target = args[keyword]!;
    delete args[keyword];
    fixes.push(`view "${name} ${keyword}=${target.slice(0, 60)}" -> "${name} ${target.slice(0, 60)}"`);
  }
  if (view.targetRequired && !target) {
    const what = view.target === 'symbol' ? 'name' : view.target;
    throw new SpecError([problem('E_VIEW', `view "${name}" needs a ${what}: show{view:"${name} <${what}>"}`)]);
  }
  if (view.target === 'range' && target !== undefined && !isSafeRange(target)) {
    throw new SpecError([problem('E_VIEW', `"${target.slice(0, 60)}" is not a range. Use wt, staged, a ref such as main, or a range such as main..HEAD.`)]);
  }
  const text = [name, ...(view.target && target ? [target] : []), ...Object.entries(args).map(([key, value]) => `${key}=${value}`)].join(' ');
  return {name, source: view.build(view.target ? target : undefined, args), call: text};
}

/**
 * The id as given when it is a slug; else the slug it plainly meant (`My view.v2` -> `My-view-v2`), reported as a
 * fix. Throws E_ID when nothing usable is left or it is too long to shorten without guessing.
 */
function surfaceId(given: string, fixes: string[]): string {
  const slug = SURFACE_ID.test(given) ? given : given.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!SURFACE_ID.test(slug)) {
    throw new SpecError([problem('E_ID', `id "${given.slice(0, 40)}" is not a slug: use letters, digits, - and _ (at most 48), e.g. "auth-flow".`)]);
  }
  // Decision D10: an id is a key in the viewer and in the server's maps; these three would name a prototype instead.
  if (UNSAFE_KEYS.has(slug)) throw new SpecError([problem('E_ID', `id "${slug}" is reserved: __proto__, constructor and prototype cannot name a view.`)]);
  if (slug !== given) fixes.push(`id "${given.slice(0, 48)}" -> ${slug}`);
  return slug;
}

/** Step 0 and 1: validates the arguments and produces what the pipeline compiles. Throws SpecError. */
export function showRequest(args: ShowArgs, fixes: string[] = []): ShowRequest {
  let call = typeof args.view === 'string' ? args.view.trim() : '';
  const spec = typeof args.spec === 'string' ? args.spec : '';
  const path = typeof args.path === 'string' ? args.path.trim() : '';
  if (!call && !spec.trim()) throw new SpecError([problem('E_VIEW', `show needs view or spec. Views: ${VIEW_INDEX}`)]);
  if (spec.length > MAX_SPEC_CHARS) {
    throw new SpecError([problem('E_SPEC', `the spec is ${spec.length.toLocaleString('en-US')} characters; the limit is ${MAX_SPEC_CHARS.toLocaleString('en-US')}. Name a source ('files.list src') instead of pasting data.`)]);
  }
  if (path) {
    if (!call) throw new SpecError([problem('E_VIEW', `path belongs to a preset: show{view:"tree ${path.slice(0, 60)}"}. In a spec, put it in the source ref: 'files.list ${path.slice(0, 60)}'.`)]);
    // A separate path argument is the target, unless the view string already carries one.
    if (parseViewRef(call).target === undefined) call = `${call.split(/\s+/)[0]} ${path} ${call.split(/\s+/).slice(1).join(' ')}`.trim();
  }
  const preset = call ? buildView(call, fixes) : undefined;
  const id = surfaceId(args.id?.trim() || preset?.name || 'main', fixes);
  return {
    id,
    sources: [...(preset ? [preset.source] : []), ...(spec.trim() ? [spec] : [])],
    fresh: preset !== undefined,
    ...(preset ? {view: preset.call} : {}),
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The text of a `show` that has committed. Whatever goes wrong while it is put together, the answer stays `ok`:
 * the view is on screen, and saying otherwise would make the model redo work that succeeded.
 */
async function report(session: Session, request: ShowRequest, outcome: ShowOutcome, patching: boolean, settleMs: number, started: number, now: () => number): Promise<string> {
  // The repo line needs the language mix; it rides on the same bounded wait as the view's own datasets.
  let langs: RepoFacts['langs'];
  let totals: RepoFacts['totals'];
  const wantRepo = request.fresh || outcome.first;
  const repoRun = wantRepo
    ? Promise.all([
        session.runRef('files.langs').then(({outcome: result}) => {
          if (result.ok && Array.isArray(result.result.data)) langs = result.result.data as RepoFacts['langs'];
        }),
        session.inventoryTotals().then(found => { totals = found; }),
      ])
    : Promise.resolve();
  await withTimeout(Promise.all([repoRun, outcome.checks, ...outcome.datasets.map(dataset => dataset.settled)]), settleMs);
  // Decision D3: a connected tab draws within moments and says what it drew instead of a component.
  if (session.tabs() > 0) await sleep(Math.min(REPORT_GRACE_MS, Math.max(0, settleMs)));

  const {repo} = session.meta();
  const datasets = outcome.datasets.map(dataset => {
    const state = session.datasetState(outcome.id, dataset.key);
    // A dataset line the model was given for this view before is not repeated on a patch (it is on a plain preset call).
    const told = state?.status === 'ready' && session.alreadyTold(outcome.id, dataset.ref, state.summary ?? '') && patching;
    return {ref: dataset.ref, state, told};
  });
  return showText({
    outcome,
    elapsedMs: now() - started,
    ...(wantRepo ? {repo: repoLine({name: repo.name, git: session.isGit, ...(repo.branch ? {branch: repo.branch} : {}), ...(repo.head ? {head: repo.head} : {}), dirty: repo.dirty, ...(totals ? {totals} : {}), ...(langs ? {langs} : {})})} : {}),
    datasets,
    late: session.lateWarnings(outcome),
    // Last, when nothing else can fail: a drained event that is not printed would be lost.
    events: [],
  });
}

/**
 * Finding V071: a preset's path target under the inventory's spelling, said as a fix. `file readme.md` then titles,
 * binds and lists README.md, as the data it shows already does; a target spelled as on disk is kept as it is.
 */
async function canonicalView(session: Session, args: ShowArgs, request: ShowRequest, fixes: string[]): Promise<ShowRequest> {
  if (!request.fresh || !request.view) return request;
  const {view, target, args: rest} = parseViewRef(request.view);
  if (!target || VIEW_BY_NAME.get(view)?.target !== 'path') return request;
  const named = await session.canonicalName(target);
  if (named === target) return request;
  fixes.push(`path '${oneLine(target, 80)}' -> '${oneLine(named, 80)}'`);
  const call = [view, named, ...Object.entries(rest).map(([key, value]) => `${key}=${value}`)].join(' ');
  return showRequest({...(args.spec !== undefined ? {spec: args.spec} : {}), ...(args.id !== undefined ? {id: args.id} : {}), view: call});
}

/** Runs `show` and formats its result. Never throws: every failure is an error result. */
export async function showTool(session: Session, args: ShowArgs, settleMs = DEFAULT_SETTLE_MS, now: () => number = Date.now): Promise<ToolResult> {
  const started = now();
  let request: ShowRequest;
  let outcome: ShowOutcome;
  let patching: boolean;
  try {
    const fixes: string[] = [];
    request = showRequest(args, fixes);
    // Decision D8: HEAD, the revision and the file index are looked at before anything is computed.
    await session.revalidate();
    request = await canonicalView(session, args, request, fixes);
    if (request.view === GALLERY) {
      // The Code section reads a file of this repository: one with an outline, so no plate is empty (finding F092).
      const file = await session.galleryFile();
      if (file) request = {...request, sources: [gallerySpec({file}), ...request.sources.slice(1)], view: `${GALLERY} ${file}`};
    } else if (request.fresh && request.view) {
      // Finding F008: a tree or symbol preset opens its code view on a file (a README, the largest file, the
      // definition) instead of "no file selected". Written before the agent's own patch, which may choose another.
      const {view, target} = parseViewRef(request.view);
      const file = await session.presetFile(view, target);
      if (file) request = {...request, sources: [`${request.sources[0]}\n$/ui/file=${JSON.stringify(file)}`, ...request.sources.slice(1)]};
    }
    patching = session.surfaces.has(request.id) && request.sources.length > (request.fresh ? 1 : 0);
    outcome = await session.show(request);
    outcome.fixes.unshift(...fixes);
  } catch (error) {
    return showFailure(error);
  }
  let body: string;
  try {
    body = await report(session, request, outcome, patching, settleMs, started, now);
  } catch (error) {
    body = shield(`${okLine(outcome, now() - started)}\nwarn the view is on screen, but its summary could not be written (${oneLine(error instanceof Error ? error.message : 'internal error', 120)})`);
  }
  const events = session.events.drain();
  return {content: [{type: 'text', text: [body, ...events].join('\n')}]};
}

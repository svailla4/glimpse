// Express -> A2UI v1.0 messages (design 2.2 steps 2 and 3). Stateless: every call compiles against a throw-away twin
// MessageProcessor seeded from the stored snapshot, so a failed call cannot leave compiler state behind.
// This file and errors.ts are the only server code that touches @a2ui/agent.
import {CATALOG_ID, createApiCatalog, normalizeSpec, PROTOCOL_VERSION, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {classifyCompileError, problem, SpecError} from './errors.ts';
import {repair} from './repair.ts';

const MAX_REPAIR_PASSES = 4;

export interface Toolchain {
  /** Compiles `header + text` on a fresh twin state; returns the messages or throws the compiler's error. */
  newTwin(seed: Seed | undefined, surfaceId: string): (text: string) => A2uiMessage[];
  /** The Express grammar rules of the SDK's own prompt (the `grammar` topic of the catalog tool). */
  grammar: string;
}

let toolchain: Promise<Toolchain> | undefined;

/**
 * Loads @a2ui/agent (about 100 ms) and builds the compiler once per process. Called from the first tool call, never
 * at process start.
 */
export function loadToolchain(): Promise<Toolchain> {
  toolchain ??= (async () => {
    const [{A2uiGenerator, CatalogConfig, RendererState}, {MessageProcessor}] = await Promise.all([import('@a2ui/agent'), import('@a2ui/web_core/v1_0')]);
    const catalog = createApiCatalog();
    const processor = new A2uiGenerator([new CatalogConfig(catalog as never)]).createProcessor({[PROTOCOL_VERSION]: {supportedCatalogIds: [CATALOG_ID]}});
    return {
      newTwin(seed, surfaceId) {
        const twin = new MessageProcessor([catalog as never]);
        if (seed) {
          const createSurface = {surfaceId, catalogId: CATALOG_ID, components: structuredClone(seed.components), dataModel: structuredClone(seed.data)};
          twin.processMessages([{version: PROTOCOL_VERSION, createSurface}] as never);
        }
        const state = RendererState.of(twin as never);
        return text => processor.parseResponse(text, {wrapped: false, state}).flatMap(part => ('a2ui' in part ? part.a2ui : [])) as unknown as A2uiMessage[];
      },
      grammar: grammarOf(processor.promptSnippet),
    };
  })();
  return toolchain;
}

function grammarOf(prompt: string): string {
  const start = prompt.indexOf('## Grammar Rules');
  const end = prompt.indexOf('## Positional Component Signatures');
  return start >= 0 && end > start ? prompt.slice(start, end).trim() : prompt.trim();
}

export interface Seed {
  components: WireComponent[];
  /** The agent's own data (no /ds, no /meta): enough for the compiler, cheap to clone. */
  data: Record<string, unknown>;
}

export interface CompileRequest {
  surfaceId: string;
  /** The stored surface the call patches; undefined for a new surface and for a preset that replaces one. */
  seed?: Seed;
  /** Express sources as written, compiled in order on one twin: a spec, or a preset followed by its patch. */
  sources: string[];
  /** Ids of the existing surfaces, quoted in the "nothing to patch" error. */
  surfaces: readonly string[];
}

export interface CompileResult {
  messages: A2uiMessage[];
  /** One entry per auto-repair, e.g. `DataTabel -> DataTable`. */
  fixes: string[];
  /** The normalized, repaired sources that produced `messages`. */
  texts: string[];
}

/**
 * Line of the author's text that holds line `line` of its normalized form. They differ only when a single-quoted
 * string spans lines: the normalizer turns those newlines into \n escapes. The normalizer scans left to right, so
 * normalizing a prefix that ends at a newline yields a prefix of the full result.
 */
export function originalLine(source: string, line: number): number {
  let kept = 0;
  let seen = 0;
  for (let i = source.indexOf('\n'); i >= 0 && kept < line - 1; i = source.indexOf('\n', i + 1)) {
    seen++;
    if (normalizeSpec(source.slice(0, i + 1)).endsWith('\n')) kept++;
  }
  return seen + 1;
}

function checkTargets(messages: A2uiMessage[], surfaceId: string, mayCreate: boolean): void {
  messages.forEach((message, index) => {
    const body = 'createSurface' in message ? message.createSurface : 'updateComponents' in message ? message.updateComponents
      : 'updateDataModel' in message ? message.updateDataModel : undefined;
    const creates = 'createSurface' in message;
    if (!body || body.surfaceId !== surfaceId || (creates && !(mayCreate && index === 0))) {
      throw new SpecError([problem('E_SPEC', 'a spec describes one view: remove surface(...) and deleteSurface(...) statements; the id argument selects the view.')]);
    }
  });
}

/**
 * Compiles the sources, repairing what Glimpse repairs (at most four passes). Synchronous once the toolchain is
 * loaded, so a caller can compile, expand and commit without another call interleaving.
 * Throws SpecError with one precise problem; nothing is kept on failure.
 */
export function compileSpec(tools: Toolchain, request: CompileRequest): CompileResult {
  const texts = request.sources.map(normalizeSpec);
  const fixes: string[] = [];
  for (let pass = 0; ; pass++) {
    const compile = tools.newTwin(request.seed, request.surfaceId);
    const messages: A2uiMessage[] = [];
    let failure: {step: number; error: unknown} | undefined;
    for (let step = 0; step < texts.length && !failure; step++) {
      const exists = request.seed !== undefined || step > 0;
      const header = exists ? `surface("${request.surfaceId}", update=true)` : `surface("${request.surfaceId}")`;
      try {
        messages.push(...compile(`${header}\n${texts[step]}`));
      } catch (error) {
        failure = {step, error};
      }
    }
    if (!failure) {
      checkTargets(messages, request.surfaceId, request.seed === undefined);
      return {messages, fixes, texts};
    }
    const {step, error} = failure;
    const found = classifyCompileError(error, {
      surfaceId: request.surfaceId,
      exists: request.seed !== undefined || step > 0,
      surfaces: request.surfaces,
      lineOf: line => originalLine(request.sources[step]!, line),
    });
    const fix = pass < MAX_REPAIR_PASSES && found.repair ? repair(texts[step]!, found.repair) : undefined;
    if (!fix) throw new SpecError([found]);
    texts[step] = fix.text;
    fixes.push(fix.note);
  }
}

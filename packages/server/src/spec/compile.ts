// Express -> A2UI v1.0 messages (design 2.2 steps 2 and 3). Stateless: every call compiles against a throw-away twin
// MessageProcessor seeded from the stored snapshot, so a failed call cannot leave compiler state behind.
// This file and errors.ts are the only server code that touches @a2ui/agent.
import {CATALOG_ID, COMPONENT_BY_NAME, createApiCatalog, normalizeSpec, PROTOCOL_VERSION, type A2uiMessage, type WireComponent} from '@glimpse/catalog';
import {classifyCompileError, compilerText, oneLine, problem, SpecError, type Problem} from './errors.ts';
import {pathProblem, restoreBuiltins, scanSpec, tokenize, valueProblem, type SpecToken} from './guard.ts';
import {repair} from './repair.ts';

const MAX_REPAIR_PASSES = 6;
/** Parts one patch may have appended to root. */
const MAX_APPENDED = 12;
const ROOT = 'root';

export interface Toolchain {
  /** Compiles `header + text` on a fresh twin state; returns the messages or throws the compiler's error. */
  newTwin(seed: Seed | undefined, surfaceId: string): (text: string) => A2uiMessage[];
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
    };
  })();
  return toolchain;
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
  /** What the author should know although the call succeeded, e.g. text the compiler skipped. */
  warnings: string[];
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

/** Reserved names that got past the text scan (they cannot, as far as is known) are refused on the compiled form too. */
function checkValues(messages: A2uiMessage[]): void {
  for (const message of messages) {
    const found = 'updateDataModel' in message
      ? pathProblem(message.updateDataModel.path ?? '/') ?? valueProblem(message.updateDataModel.value)
      : 'createSurface' in message ? valueProblem(message.createSurface.dataModel) ?? valueProblem(message.createSurface.components)
      : 'updateComponents' in message ? valueProblem(message.updateComponents.components) : undefined;
    if (found) throw new SpecError([found]);
  }
}

// ---------------------------------------------------------------- what the compiler lets through in silence
/**
 * A string the author opened with ' or " that runs to the end of the input: where it starts and what it swallowed.
 * Mirrors the normalizer's rule that a ' closes a string only before , ) ] } : = ; or a line end.
 */
export function unclosedString(source: string): {line: number; col: number; swallowed: string} | undefined {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\n') { line++; lineStart = i + 1; continue; }
    if (c === '#' || (c === '/' && source[i + 1] === '/')) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++;
      continue;
    }
    if (c !== '"' && c !== "'") continue;
    const open = {line, col: i - lineStart + 1, at: i};
    let closed = false;
    for (i++; i < source.length; i++) {
      const d = source[i]!;
      if (d === '\\') { i++; continue; }
      if (d === '\n') { line++; lineStart = i + 1; if (c === '"') continue; }
      if (d !== c) continue;
      if (c === "'") {
        let k = i + 1;
        while (source[k] === ' ' || source[k] === '\t') k++;
        if (source[k] !== undefined && !',)]}:=;\n\r'.includes(source[k]!)) continue; // an apostrophe
      }
      closed = true;
      break;
    }
    if (!closed) return {line: open.line, col: open.col, swallowed: source.slice(open.at + 1)};
  }
  return undefined;
}

const isOpen = (token: SpecToken) => token.kind === 'punct' && '([{'.includes(token.text);
const isClose = (token: SpecToken) => token.kind === 'punct' && ')]}'.includes(token.text);

/**
 * Text at statement level that is not an assignment (`name=...`, `$/path=...`). The Express grammar accepts bare
 * words and strings there and does nothing with them, so prose after a statement would otherwise vanish in silence.
 */
export function strayText(text: string): string[] {
  const {tokens} = tokenize(text);
  const stray: Array<{start: number; end: number; line: number}> = [];
  const skipGroup = (i: number): number => {
    let depth = 0;
    for (; i < tokens.length; i++) {
      if (isOpen(tokens[i]!)) depth++;
      else if (isClose(tokens[i]!) && --depth <= 0) return i + 1;
    }
    return i;
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.text === ';') { i++; continue; }
    if ((token.kind === 'ident' || token.kind === 'path') && tokens[i + 1]?.text === '=' && tokens[i + 2]?.text !== '=') {
      const value = tokens[i + 2];
      if (!value) break;
      i = isOpen(value) ? skipGroup(i + 2) : value.kind === 'ident' && tokens[i + 3]?.text === '(' ? skipGroup(i + 3) : i + 3;
      continue;
    }
    const end = isOpen(token) ? skipGroup(i) : i + 1;
    const last = stray.at(-1);
    const span = {start: token.start, end: tokens[end - 1]!.end, line: token.line};
    if (last && text.slice(last.end, span.start).trim() === '' && !text.slice(last.end, span.start).includes('\n')) last.end = span.end;
    else stray.push(span);
    i = end;
  }
  return stray.slice(0, 3).map(span => `line ${span.line}: ignored text that is not a statement: ${JSON.stringify(oneLine(text.slice(span.start, span.end), 60))}`);
}

// ---------------------------------------------------------------- parts appended to root
const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The surface as it stands after `messages`, in the form a twin is seeded with. */
function stateAfter(seed: Seed | undefined, messages: readonly A2uiMessage[]): Seed {
  const components = new Map((seed?.components ?? []).map(comp => [comp.id, comp]));
  let data = seed?.data ?? {};
  for (const message of messages) {
    if ('createSurface' in message) {
      components.clear();
      for (const comp of message.createSurface.components) components.set(comp.id, comp);
      data = message.createSurface.dataModel ?? {};
    } else if ('updateComponents' in message) {
      for (const comp of message.updateComponents.components) components.set(comp.id, comp);
    }
    // Data patches of earlier steps do not matter to reachability; the twin only needs the components.
  }
  return {components: [...components.values()], data};
}

/** True when the text has a `root=...` statement of its own. */
function definesRoot(text: string): boolean {
  const {tokens} = tokenize(text);
  let depth = 0;
  return tokens.some((token, i) => {
    if (isOpen(token)) depth++;
    else if (isClose(token)) depth--;
    return depth === 0 && token.kind === 'ident' && token.text === ROOT && tokens[i + 1]?.text === '=' && tokens[i + 2]?.text !== '=';
  });
}

const expressString = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

/** A simple prop value as Express: a string, a number, a flag or a `$/path` binding. */
function expressValue(value: unknown): string | undefined {
  if (typeof value === 'string') return expressString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const path = typeof value === 'object' && value !== null ? (value as {'@path'?: unknown})['@path'] : undefined;
  return typeof path === 'string' && /^\/[\w/]*$/.test(path) ? `$${path}` : undefined;
}

/** The exact statement that re-declares the stored root with one more child: what to resend to adopt an orphan. */
export function rootLineOf(root: WireComponent | undefined, extra: string): string | undefined {
  const def = root ? COMPONENT_BY_NAME.get(root.component) : undefined;
  if (!root || !def || !isIdList(root.children)) return undefined;
  const args: string[] = [];
  for (const key of Object.keys(def.props)) {
    const value = root[key];
    if (value === undefined) continue;
    const text = key === 'children' ? `[${[...root.children, extra].join(',')}]` : expressValue(value);
    if (text === undefined) return undefined;
    args.push(`${key}=${text}`);
  }
  return `root=${root.component}(${args.join(',')})`;
}

/**
 * Compiles the sources, repairing what Glimpse repairs (a bounded number of passes). Synchronous once the toolchain
 * is loaded, so a caller can compile, expand and commit without another call interleaving.
 * Throws SpecError with one precise problem; nothing is kept on failure.
 */
export function compileSpec(tools: Toolchain, request: CompileRequest): CompileResult {
  const texts = request.sources.map(normalizeSpec);
  for (const text of texts) {
    const refused = scanSpec(text);
    if (refused) throw new SpecError([refused]);
  }
  const fixes: string[] = [];
  /** Per step: named parts no parent refers to, adopted by root in the order they were found. */
  const adopted = new Map<number, string[]>();
  let adoptions = 0;

  for (let pass = 0; ; pass++) {
    let compile = tools.newTwin(request.seed, request.surfaceId);
    const messages: A2uiMessage[] = [];
    let failure: {step: number; error: unknown; root: WireComponent | undefined} | undefined;
    for (let step = 0; step < texts.length && !failure; step++) {
      const exists = request.seed !== undefined || step > 0;
      const header = exists ? `surface("${request.surfaceId}", update=true)` : `surface("${request.surfaceId}")`;
      const state = exists ? stateAfter(request.seed, messages) : undefined;
      const root = state?.components.find(comp => comp.id === ROOT);
      const extra = adopted.get(step) ?? [];
      if (state && root && extra.length > 0 && isIdList(root.children)) {
        // The twin is told root already lists the new parts, so the patch that defines them is reachable; the same
        // root is then sent ahead of the patch.
        const grown: WireComponent = {...root, children: [...root.children, ...extra.filter(id => !(root.children as string[]).includes(id))]};
        compile = tools.newTwin({components: state.components.map(comp => (comp.id === ROOT ? grown : comp)), data: state.data}, request.surfaceId);
        messages.push({version: PROTOCOL_VERSION, updateComponents: {surfaceId: request.surfaceId, components: [structuredClone(grown)]}});
      }
      try {
        messages.push(...compile(`${header}\n${texts[step]}`));
      } catch (error) {
        failure = {step, error, root};
      } finally {
        const polluted = restoreBuiltins();
        if (polluted.length > 0) failure = {step, error: new SpecError([problem('E_PATH', `the spec reached ${polluted.slice(0, 3).join(', ')}: __proto__, constructor and prototype are reserved names.`)]), root};
      }
    }
    if (!failure) {
      checkTargets(messages, request.surfaceId, request.seed === undefined);
      checkValues(messages);
      return {messages, fixes, warnings: texts.flatMap(strayText), texts};
    }
    const {step, error, root} = failure;
    if (error instanceof SpecError) throw error;
    // A patch that leaves root alone: the stored root can adopt a new part. A text that writes root= itself decides
    // its own children, so an unreferenced part there is the author's to place.
    const patching = (request.seed !== undefined || step > 0) && !definesRoot(texts[step]!);
    const orphanId = patching ? /^Component '([^']+)' is not reachable from 'root'/.exec(compilerText(error))?.[1] : undefined;
    const rootLine = orphanId ? rootLineOf(root, orphanId) : undefined;
    const found: Problem = classifyCompileError(error, {
      surfaceId: request.surfaceId,
      exists: request.seed !== undefined || step > 0,
      surfaces: request.surfaces,
      lineOf: line => originalLine(request.sources[step]!, line),
      ...(rootLine ? {rootLine} : {}),
    });
    const hint = pass < MAX_REPAIR_PASSES + adoptions ? found.repair : undefined;

    if (hint?.kind === 'orphan') {
      const already = adopted.get(step) ?? [];
      if (patching && root && isIdList(root.children) && adoptions < MAX_APPENDED && !already.includes(hint.id)) {
        adopted.set(step, [...already, hint.id]);
        adoptions++;
        fixes.push(`${hint.id} appended to root (resend root=... to place it elsewhere)`);
        continue;
      }
      throw new SpecError([found]);
    }
    if (hint?.kind === 'eof') {
      // Closing brackets after a string that never ended would render the rest of the spec as text.
      const open = unclosedString(request.sources[step]!);
      if (open && /[)\]}]/.test(open.swallowed)) {
        throw new SpecError([problem('E_SYNTAX', `line ${open.line} col ${open.col}: this string never ends, so the rest of the spec was read as its text. A ' closes a string only before , ) ] } : = ; or a line end; write an apostrophe inside as \\'.`)]);
      }
      const fix = repair(texts[step]!, hint);
      if (!fix) throw new SpecError([found]);
      texts[step] = fix.text;
      fixes.push(open ? `unterminated string at line ${open.line} col ${open.col}, ${fix.note}` : fix.note);
      continue;
    }
    const fix = hint ? repair(texts[step]!, hint) : undefined;
    if (!fix) throw new SpecError([found]);
    texts[step] = fix.text;
    fixes.push(fix.note);
  }
}

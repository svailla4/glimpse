// ActionRouter (design 2.7): what the viewer posts to /api/renderer. Host actions (gl_*) are handled here and never
// reach the model; every other action is queued as one `viewer:` line. Everything in a post is untrusted input: the
// shape is checked, the surface and the source component must exist, and only then is anything done.
import {HOST_ACTION_PREFIX, type ActionPayload, type EntityRef} from '@glimpse/catalog';
import {actionLine} from './events.ts';
import type {Session} from './session.ts';

const ENTITY_TYPES: ReadonlySet<string> = new Set(['file', 'dir', 'module', 'package', 'symbol', 'author', 'commit', 'node', 'row']);
const MAX_TEXT = 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT;
const lineNumber = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10_000_000;

function parseAction(value: unknown): ActionPayload | undefined {
  if (!isRecord(value) || !text(value.name) || value.name === '' || !text(value.surfaceId) || !text(value.sourceComponentId)) return undefined;
  return {
    name: value.name,
    surfaceId: value.surfaceId,
    sourceComponentId: value.sourceComponentId,
    timestamp: text(value.timestamp) ? value.timestamp : '',
    context: isRecord(value.context) ? value.context : {},
  };
}

function parseEntity(value: unknown): EntityRef | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.type !== 'string' || !ENTITY_TYPES.has(value.type) || !text(value.id) || value.id === '') return undefined;
  return {
    type: value.type as EntityRef['type'],
    id: value.id,
    ...(text(value.path) ? {path: value.path} : {}),
    ...(lineNumber(value.line) ? {line: value.line} : {}),
    ...(lineNumber(value.endLine) ? {endLine: value.endLine} : {}),
    ...(text(value.label) ? {label: value.label} : {}),
  };
}

export class ActionRouter {
  private session: Session;
  private log: (message: string) => void;

  constructor(session: Session, log: (message: string) => void) {
    this.session = session;
    this.log = log;
  }

  /** Handles one renderer-to-agent message. Returns false when it was malformed or addressed nothing that exists. */
  handle(message: unknown): boolean {
    if (!isRecord(message) || message.version !== '1.0') return false;
    if (isRecord(message.error)) {
      const {code, message: detail, surfaceId} = message.error;
      this.log(`glimpse: viewer error ${text(code) ? code : '?'}${text(surfaceId) ? ` (${surfaceId})` : ''}: ${text(detail) ? detail.replace(/\s+/g, ' ').slice(0, 300) : ''}`);
      return true;
    }
    const action = parseAction(message.action);
    if (!action) return false;
    const record = this.session.surfaces.get(action.surfaceId);
    const source = record?.components.get(action.sourceComponentId);
    if (!record || !source) return false;

    const {session} = this;
    const {context} = action;
    switch (action.name) {
      case 'gl_select': {
        const ref = parseEntity(context.ref);
        if (ref === undefined) return false;
        session.select(record.id, ref);
        return true;
      }
      case 'gl_open':
        if (!text(context.file) || context.file === '') return false;
        void session.openFile(context.file).then(refused => {
          if (refused) this.log(`glimpse: ${refused.message}`);
        });
        return true;
      case 'gl_drill':
        if (!text(context.ds) || typeof context.target !== 'string' || context.target.length > MAX_TEXT) return false;
        session.drill(record.id, context.ds, context.target.trim());
        return true;
      case 'gl_refresh':
        session.refresh(record.id);
        return true;
      case 'gl_close':
        session.closeSurface(record.id);
        return true;
      default:
        // The gl_ prefix is reserved for the host: an unknown one is dropped, never forwarded to the model.
        if (action.name.startsWith(HOST_ACTION_PREFIX)) return false;
        session.events.push(actionLine(source.component === 'Button' ? 'press' : source.component === 'Ask' ? 'answer' : 'event', record.id, action.name, context));
        return true;
    }
  }
}

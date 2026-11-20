// The `events` tool (design 6.4): what the user did in the tab since the last Glimpse call, with an optional
// long-poll. Era-neutral: it only answers the request and sends progress for it; the server never initiates anything.
import type {EventQueue} from '../session/events.ts';
import {text, type ToolResult} from './result.ts';

export const EVENTS_DESCRIPTION =
  'What the user did in the Glimpse tab since your last Glimpse call: selections, button presses, answers. wait > 0 long-polls that many seconds.';

export const EVENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {wait: {type: 'integer', minimum: 0, maximum: 110}},
} as const;

export const MAX_WAIT_S = 110;
const PROGRESS_MS = 15_000;

export interface EventsOptions {
  signal?: AbortSignal;
  /** Sends one progress notification; called about every 15 s while waiting. Absent when the client gave no token. */
  progress?: (count: number) => void;
  progressMs?: number;
}

export async function eventsTool(queue: EventQueue, args: {wait?: unknown}, options: EventsOptions = {}): Promise<ToolResult> {
  const seconds = typeof args.wait === 'number' && Number.isFinite(args.wait) ? Math.min(MAX_WAIT_S, Math.max(0, args.wait)) : 0;
  if (seconds > 0 && queue.size === 0) {
    let count = 0;
    const beat = options.progress ? setInterval(() => options.progress!(++count), options.progressMs ?? PROGRESS_MS) : undefined;
    try {
      await queue.wait(seconds * 1000, options.signal);
    } finally {
      clearInterval(beat);
    }
  }
  const lines = queue.drain();
  return text(lines.length > 0 ? lines.join('\n') : 'none');
}

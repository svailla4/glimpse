// packages/viewer/src/kit/marginal.tsx  (first version by WP0; owned by WP4; exported signature is frozen)
import type {JSX} from 'react';
import {fmtNum} from './format.ts';
import type {DataState} from './hooks.ts';

const STRATEGY: Record<string, string> = {topN: 'top', treecut: 'tree cut', window: 'window', bucket: 'bucketed', neighborhood: 'neighbourhood'};

/** The text of the marginal note, or undefined when everything is shown. */
export function marginalText(state: DataState<unknown>): string | undefined {
  const cut = state.truncated;
  if (cut) {
    const how = STRATEGY[cut.strategy] ?? cut.strategy;
    return `showing ${fmtNum(cut.returned)} of ${fmtNum(cut.total)} · ${how}${cut.by ? ` by ${cut.by}` : ''}`;
  }
  if (Array.isArray(state.data) && typeof state.total === 'number' && state.total > state.data.length) {
    return `showing ${fmtNum(state.data.length)} of ${fmtNum(state.total)}`;
  }
  return undefined;
}

/** Mono marginal note for truncated data: 'showing 500 of 12,840 · top by score'. Renders nothing when nothing is cut. */
export function Marginal(p: {state: DataState<unknown>}): JSX.Element | null {
  const text = marginalText(p.state);
  // The header cuts a note that does not fit with an ellipsis (design rule header-keeps-title): the tooltip always has all of it.
  return text ? <span className="gl-marginal" data-gl-marginal="" title={text}>{text}</span> : null;
}

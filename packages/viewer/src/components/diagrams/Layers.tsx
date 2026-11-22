// Layers: architecture tiers as stacked bands of boxes, top tier first (design 5.6). CSS grid only. The data is read
// by the catalog's cleanLayers (decision links-through-node-ids), as on the server; how much of it is drawn is decided here.
import type * as C from '@glimpse/catalog';
import {cleanLayers, type EntityRef, type LayerItem, type LayersAst} from '@glimpse/catalog';
import {useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {
  DataGate, EntityLink, PlateAside, Redline, fileEntity, fmtNum, linkedEntity, marksSelection, useDataset, useReportState, useSelection, useSizeCap,
  type GlView,
} from '../../kit/index.ts';
import css from './Layers.module.css';

/** Items drawn per band; the rest are counted in a last box. */
export const MAX_ITEMS = 60;
export const MAX_BANDS = 40;

interface Item { label: string; note?: string; entity?: EntityRef }
interface Band { name: string; note?: string; items: Item[]; more: number }

/**
 * The bands as drawn: at most MAX_BANDS, each with at most MAX_ITEMS items. An item with a file selects that file; one
 * naming diagram nodes (`node:'PG'`, decision links-through-node-ids) carries them, and without a file selects the node itself.
 */
function bandsOf(ast: LayersAst, componentId: string): Band[] {
  return ast.bands.slice(0, MAX_BANDS).map((band, b) => ({
    name: band.name,
    ...(band.note !== undefined ? {note: band.note} : {}),
    items: band.items.slice(0, MAX_ITEMS).map((item, i) => {
      const own = item.file !== undefined ? fileEntity(item.file, item.label) : undefined;
      // By place (tier 1 item 2 is `l:1.2`), not label: two items may share a label and stand for different nodes.
      const entity = linkedEntity(own, item.nodes ?? [], {id: `${componentId}:${b + 1}.${i + 1}`, label: item.label});
      return {label: item.label, ...(item.note !== undefined ? {note: item.note} : {}), ...(entity ? {entity} : {})};
    }),
    more: Math.max(0, band.items.length - MAX_ITEMS),
  }));
}

/** The narrowest and widest box, in px. */
const BOX_MIN = 120;
const BOX_MAX = 300;

/**
 * One width for every box of the view, from its longest text: a label fits in about two lines, a note on one. Every
 * tier lays its boxes out in columns of this width, so the columns line up from tier to tier and the boxes of a row
 * are as tall as each other. Boxes sized to their own text, up to 240 px, made a ragged pile of one- and two-line
 * boxes beside empty space. The width is estimated from character counts (the UI font is about 6.4 px a character at
 * 12 px, mono 6.6 px at 11 px); a label longer than its box takes up to three lines, then is cut and gets a tooltip.
 */
export function boxWidth(bands: readonly Band[]): number {
  let need = 0;
  for (const band of bands) {
    for (const item of band.items) need = Math.max(need, item.label.length * 3.4, (item.note?.length ?? 0) * 6.6);
  }
  return Math.round(Math.min(BOX_MAX, Math.max(BOX_MIN, need + 26)));
}

/**
 * Gives a tier name or an item its full text as a tooltip while CSS cuts it, and none while it shows whole: a tooltip
 * that repeats the text under the pointer is noise. The plate header does the same (kit/Frame.tsx).
 */
function revealCut(event: PointerEvent<HTMLElement>): void {
  const holder = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-full]') : null;
  if (!holder || !event.currentTarget.contains(holder)) return;
  const texts = holder.hasAttribute('data-text') ? [holder] : [...holder.querySelectorAll<HTMLElement>('[data-text]')];
  const cut = texts.some(text => text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1);
  if (cut) holder.title = holder.dataset.full ?? '';
  else holder.removeAttribute('title');
}

function LayersBody(p: {id: string; data: unknown}) {
  const {id} = p;
  // As tall as its tiers, up to the plate's maximum height (decision content-sized-plates); past that it scrolls.
  const cap = useSizeCap();
  const rootRef = useRef<HTMLDivElement>(null);
  const {selected} = useSelection(id);
  const cleaned = useMemo(() => cleanLayers(p.data), [p.data]);
  const bands = useMemo(() => (cleaned.ok ? bandsOf(cleaned.ast, id) : []), [cleaned, id]);
  const box = useMemo(() => boxWidth(bands), [bands]);
  // What the data asked for but is not drawn is told to the model: data written by a patch was never checked by the server.
  const dropped = cleaned.ok ? cleaned.dropped : [];
  // Entries left out, counted: the list folds past 8, and its lines for unknown keys leave nothing out.
  const notDrawn = cleaned.ok ? cleaned.droppedCount : 0;
  useReportState(dropped.length > 0 ? 'W_DROPPED' : undefined, `not drawn: ${dropped.join('; ')}`);
  const [active, setActive] = useState(0);

  // One tab stop: the entity under the roving index. EntityLink renders the button, so its tabindex is set here.
  useEffect(() => {
    const stops = rootRef.current?.querySelectorAll<HTMLElement>('[data-layer-item] button') ?? [];
    stops.forEach((stop, i) => { stop.tabIndex = i === Math.min(active, stops.length - 1) ? 0 : -1; });
  });

  if (!cleaned.ok) return <Redline code="E_SHAPE" id={`Layers#${id}`} message={cleaned.error} />;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const stops = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-layer-item] button') ?? [])];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const bandOf = (stop: HTMLElement) => stop.closest('[data-layer]');
    let next = at;
    if (event.key === 'ArrowRight') next = Math.min(stops.length - 1, at + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, at - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = stops.length - 1;
    else if (event.key === 'ArrowDown') {
      // The first entity of the next band that has one.
      const here = bandOf(stops[at]!);
      const found = stops.findIndex((stop, i) => i > at && bandOf(stop) !== here);
      next = found < 0 ? at : found;
    } else if (event.key === 'ArrowUp') {
      const here = bandOf(stops[at]!);
      let found = -1;
      for (let i = at - 1; i >= 0; i--) {
        if (bandOf(stops[i]!) === here) continue;
        // Walk back to the first entity of that band.
        found = i;
        while (found > 0 && bandOf(stops[found - 1]!) === bandOf(stops[i]!)) found--;
        break;
      }
      next = found < 0 ? at : found;
    } else return;
    event.preventDefault();
    if (next !== at) {
      setActive(next);
      stops[next]?.focus();
    }
  };

  // The red-pencil rule of the kit: the selected file itself, a file inside the selected directory or module, or an
  // item naming the selected diagram node (decision links-through-node-ids).
  const isHit = (entity: EntityRef | undefined) => marksSelection(selected, entity);
  const anySelected = bands.some(band => band.items.some(item => isHit(item.entity)));
  const items = bands.reduce((sum, band) => sum + band.items.length + band.more, 0);
  const total = cleaned.ast.bands.length;
  const notes = [
    notDrawn > 0 ? `${fmtNum(notDrawn)} not drawn` : undefined,
    total > MAX_BANDS ? `showing ${MAX_BANDS} of ${fmtNum(total)} tiers` : undefined,
  ].filter(Boolean);
  const ariaLabel = `Layers, ${bands.length} ${bands.length === 1 ? 'tier' : 'tiers'}, ${items} ${items === 1 ? 'item' : 'items'}: ${bands.slice(0, 8).map(band => band.name.slice(0, 40)).join(', ')}`;

  return (
    <div ref={rootRef} className={css.root} style={{maxHeight: cap}} role="group" aria-label={ariaLabel} onKeyDown={onKeyDown} onPointerOver={revealCut}>
      {notes.length > 0 ? <PlateAside><span className={css.marginal} data-gl-note="">{notes.join(' · ')}</span></PlateAside> : null}
      <div className={css.tiers} style={{'--gl-layer-box': `${box}px`}}>
      {bands.map((band, b) => (
        <section key={b} className={css.band} data-layer={band.name} data-first={b === 0 || undefined} aria-label={band.name}>
          <h4 className={css.name} data-full={band.name} data-text="">{band.name}</h4>
          <div className={css.body}>
          <ul className={css.items}>
            {band.items.map((item, i) => {
              const isSelected = isHit(item.entity);
              const content = (
                <span className={css.box}>
                  <span className={css.label} data-text="">{item.label}</span>
                  {item.note ? <span className={css.sub} data-text="">{item.note}</span> : null}
                </span>
              );
              return (
                <li
                  key={i}
                  className={css.item}
                  data-layer-item={item.label}
                  data-entity={item.entity ? '' : undefined}
                  data-selected={isSelected || undefined}
                  data-dim={(anySelected && !isSelected) || undefined}
                  data-full={item.note ? `${item.label}: ${item.note}` : item.label}
                >
                  {item.entity ? <EntityLink entity={item.entity} componentId={id}>{content}</EntityLink> : content}
                </li>
              );
            })}
            {band.more > 0 ? <li className={css.item} data-more=""><span className={css.box}><span className={css.sub}>+ {fmtNum(band.more)} more</span></span></li> : null}
          </ul>
          {band.note ? <p className={css.note}>{band.note}</p> : null}
          </div>
        </section>
      ))}
      </div>
    </div>
  );
}

export const LayersView: GlView<typeof C.Layers> = ({id, props}) => {
  const state = useDataset<LayerItem[]>(props.data);
  return (
    <DataGate state={state} id={`Layers#${id}`}>
      {data => <LayersBody id={id} data={data} />}
    </DataGate>
  );
};

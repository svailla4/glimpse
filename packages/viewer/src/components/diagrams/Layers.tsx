// Layers: architecture tiers as stacked bands of boxes, top tier first (design 5.6). CSS grid only.
import type * as C from '@glimpse/catalog';
import {parseFileLoc, type EntityRef, type LayerItem} from '@glimpse/catalog';
import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {DataGate, EntityLink, PlateAside, Redline, fmtNum, useDataset, useSelection, type GlView} from '../../kit/index.ts';
import {matchesSelection} from './edgekit/index.ts';
import css from './Layers.module.css';

/** Items drawn per band; the rest are counted in a last box. */
export const MAX_ITEMS = 60;
export const MAX_BANDS = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

interface Item { label: string; note?: string; entity?: EntityRef }
interface Band { name: string; note?: string; items: Item[]; more: number }
export interface CleanLayers { bands: Band[]; dropped: number; hiddenBands: number }

function entityOf(file: string, label: string): EntityRef {
  const loc = parseFileLoc(file);
  return {type: 'file', id: loc.path, path: loc.path, ...(loc.line != null ? {line: loc.line} : {}), ...(loc.endLine != null ? {endLine: loc.endLine} : {}), label};
}

/** Coerces the bound rows into bands. Entries that are neither a label nor an object with one are dropped and counted. */
export function cleanLayers(data: readonly unknown[]): CleanLayers {
  let dropped = 0;
  const bands: Band[] = [];
  for (const raw of data.slice(0, MAX_BANDS)) {
    if (!isRecord(raw)) {
      // A bare string is a band without items.
      const name = textOf(raw);
      if (name === undefined) dropped++;
      else bands.push({name, items: [], more: 0});
      continue;
    }
    const all: Item[] = [];
    for (const entry of Array.isArray(raw.items) ? raw.items : []) {
      const label = isRecord(entry) ? textOf(entry.label) : textOf(entry);
      if (label === undefined) {
        dropped++;
        continue;
      }
      const file = isRecord(entry) ? textOf(entry.file) : undefined;
      all.push({label, note: isRecord(entry) ? textOf(entry.note) : undefined, entity: file !== undefined ? entityOf(file, label) : undefined});
    }
    bands.push({name: textOf(raw.name) ?? '—', note: textOf(raw.note), items: all.slice(0, MAX_ITEMS), more: Math.max(0, all.length - MAX_ITEMS)});
  }
  return {bands, dropped, hiddenBands: Math.max(0, data.length - MAX_BANDS)};
}

function LayersBody(p: {id: string; data: unknown; sized: boolean}) {
  const {id} = p;
  const rootRef = useRef<HTMLDivElement>(null);
  const {selected} = useSelection(id);
  const clean = useMemo(() => (Array.isArray(p.data) ? cleanLayers(p.data) : undefined), [p.data]);
  const [active, setActive] = useState(0);

  // One tab stop: the entity under the roving index. EntityLink renders the button, so its tabindex is set here.
  useEffect(() => {
    const stops = rootRef.current?.querySelectorAll<HTMLElement>('[data-layer-item] button') ?? [];
    stops.forEach((stop, i) => { stop.tabIndex = i === Math.min(active, stops.length - 1) ? 0 : -1; });
  });

  if (!clean) {
    const got = p.data === null ? 'null' : typeof p.data === 'object' ? 'an object' : `a ${typeof p.data}`;
    return <Redline code="E_SHAPE" id={`Layers#${id}`} message={`expected an array of {name, items}, received ${got}`} />;
  }

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

  const anySelected = clean.bands.some(band => band.items.some(item => item.entity && matchesSelection(selected, item.entity)));
  const items = clean.bands.reduce((sum, band) => sum + band.items.length + band.more, 0);
  const notes = [
    clean.dropped > 0 ? `${fmtNum(clean.dropped)} unreadable ${clean.dropped === 1 ? 'entry' : 'entries'} dropped` : undefined,
    clean.hiddenBands > 0 ? `showing ${MAX_BANDS} of ${fmtNum(clean.bands.length + clean.hiddenBands)} tiers` : undefined,
  ].filter(Boolean);
  const ariaLabel = `Layers, ${clean.bands.length} ${clean.bands.length === 1 ? 'tier' : 'tiers'}, ${items} ${items === 1 ? 'item' : 'items'}: ${clean.bands.slice(0, 8).map(band => band.name.slice(0, 40)).join(', ')}`;

  return (
    <div ref={rootRef} className={css.root} data-sized={p.sized || undefined} role="group" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {notes.length > 0 ? <PlateAside><span className={css.marginal} data-gl-note="">{notes.join(' · ')}</span></PlateAside> : null}
      {clean.bands.map((band, b) => (
        <section key={b} className={css.band} data-layer={band.name} data-first={b === 0 || undefined} aria-label={band.name}>
          <h4 className={css.name} title={band.name}>{band.name}</h4>
          <ul className={css.items}>
            {band.items.map((item, i) => {
              const isSelected = item.entity !== undefined && matchesSelection(selected, item.entity);
              const box = (
                <span className={css.box}>
                  <span className={css.label}>{item.label}</span>
                  {item.note ? <span className={css.sub}>{item.note}</span> : null}
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
                  title={item.note ? `${item.label}: ${item.note}` : item.label}
                >
                  {item.entity ? <EntityLink entity={item.entity} componentId={id}>{box}</EntityLink> : box}
                </li>
              );
            })}
            {band.more > 0 ? <li className={css.item} data-more=""><span className={css.box}><span className={css.sub}>+ {fmtNum(band.more)} more</span></span></li> : null}
          </ul>
          {band.note ? <p className={css.note}>{band.note}</p> : null}
        </section>
      ))}
    </div>
  );
}

export const LayersView: GlView<typeof C.Layers> = ({id, props}) => {
  const state = useDataset<LayerItem[]>(props.data);
  return (
    <DataGate state={state} id={`Layers#${id}`}>
      {data => <LayersBody id={id} data={data} sized={props.size != null} />}
    </DataGate>
  );
};

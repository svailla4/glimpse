// A file location as a link (design 5.3 FileRef): PathText inside an EntityLink, dotted underline on hover, struck
// through when the host says the file does not exist. Text, Callout and Ask render [[path#L10]] refs with it.
import type {DataClient, FileLoc} from '@glimpse/catalog';
import {useContext, useEffect, useMemo, useState, type JSX} from 'react';
import {EntityLink, HostContext, PathText, fileEntity, marksSelection, useRev, useSelection} from '../../../kit/index.ts';
import styles from './FileLink.module.css';

// One existence probe per host, path and working-tree revision, shared by every link to that path.
const probes = new WeakMap<DataClient, Map<string, {rev: number; missing: Promise<boolean>}>>();

function probe(host: DataClient, path: string, rev: number): Promise<boolean> {
  let byPath = probes.get(host);
  if (!byPath) {
    byPath = new Map();
    probes.set(host, byPath);
  }
  const known = byPath.get(path);
  if (known && known.rev === rev) return known.missing;
  // One line is enough to learn whether the file is there; a failed request says nothing, so the link stays plain.
  const missing = host.file({path, start: 1, end: 1}).then(slice => slice.skipped === 'missing', () => false);
  byPath.set(path, {rev, missing});
  return missing;
}

function useMissing(path: string, enabled: boolean): boolean {
  const host = useContext(HostContext);
  const rev = useRev();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!host || !enabled) return;
    let live = true;
    void probe(host, path, rev).then(value => {
      if (live) setMissing(value);
    });
    return () => {
      live = false;
    };
  }, [host, path, rev, enabled]);
  return enabled && missing;
}

export function FileLink(p: {file: FileLoc; label?: string; componentId: string}): JSX.Element {
  const entity = useMemo(() => fileEntity(p.file), [p.file]);
  const {selected} = useSelection(p.componentId);
  const missing = useMissing(entity.path ?? entity.id, entity.type === 'file');
  const within = selected?.type === 'dir' && marksSelection(selected, entity);
  return (
    <EntityLink entity={entity} componentId={p.componentId}>
      <span className={styles.link} data-missing={missing || undefined} data-within={within || undefined} title={missing ? `${p.file} (not found)` : undefined}>
        <PathText file={p.file} label={p.label} />
      </span>
    </EntityLink>
  );
}

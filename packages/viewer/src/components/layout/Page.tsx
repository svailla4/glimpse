// packages/viewer/src/components/layout/Page.tsx
// View root: masthead (title, subtitle, repository provenance from /meta) over the 12-column grid. `.gl-page` is the
// container the responsive cell rules query and the scope of the plate counter (styles/base.css).
import type * as C from '@glimpse/catalog';
import {useRef} from 'react';
import {useArrangement} from '../../kit/arrange.tsx';
import {ArrangeContext, useChildIds, useMeta, useSurfaceId, type GlView} from '../../kit/index.ts';
import css from './Page.module.css';
import {asText} from './shared.ts';

/** `MAIN @ 4F2A91C · DIRTY` (upper-cased by the stylesheet); nothing outside a git repository. */
function provenance(repo: C.SurfaceMeta['repo'] | undefined): string {
  if (!repo) return '';
  const head = typeof repo.head === 'string' ? repo.head.slice(0, 7) : '';
  const at = [repo.branch, head].filter(Boolean).join(' @ ');
  return [at, repo.dirty ? 'dirty' : '', repo.shallow ? 'shallow' : ''].filter(Boolean).join(' · ');
}

export const PageView: GlView<typeof C.Page> = ({id, props, child}) => {
  const grid = useRef<HTMLDivElement>(null);
  const arrangement = useArrangement(useSurfaceId(), id, useChildIds(id), {container: grid});
  const source = provenance(useMeta()?.repo);
  const children = Array.isArray(props.children) ? props.children : [];
  const title = asText(props.title);
  const subtitle = asText(props.subtitle);
  return (
    <div className="gl-page" data-width={props.width ?? 'page'}>
      <header className={css.mast}>
        {title ? <h1 className={css.title}>{title}</h1> : null}
        {subtitle ? <p className={css.subtitle}>{subtitle}</p> : null}
        {source ? <p className={css.source} title="branch @ commit">{source}</p> : null}
      </header>
      <div className="gl-grid12" ref={grid}>
        <ArrangeContext.Provider value={arrangement}>{children.map(token => child(token))}</ArrangeContext.Provider>
      </div>
    </div>
  );
};

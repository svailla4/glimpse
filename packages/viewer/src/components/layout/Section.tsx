// packages/viewer/src/components/layout/Section.tsx
// A heading followed by a hairline to the right edge; the children sit on a nested 12-column grid.
import type * as C from '@glimpse/catalog';
import {useId, useRef} from 'react';
import {inVisualOrder, useArrangeHandle, useArrangement} from '../../kit/arrange.tsx';
import {ArrangeContext, useChildIds, useChildSpans, useSurfaceId, type GlView} from '../../kit/index.ts';
import css from './Section.module.css';
import {asText} from './shared.ts';

export const SectionView: GlView<typeof C.Section> = ({id, props, child}) => {
  const titleId = useId();
  const grid = useRef<HTMLDivElement>(null);
  const childIds = useChildIds(id);
  const arrangement = useArrangement(useSurfaceId(), id, childIds, {container: grid, spans: useChildSpans(id)});
  // The section is itself a cell of its container (usually the Page): its heading moves it.
  const handle = useArrangeHandle(id);
  const children = inVisualOrder(arrangement, childIds, Array.isArray(props.children) ? props.children : []);
  const subtitle = asText(props.subtitle);
  return (
    <section className={css.section} aria-labelledby={titleId}>
      <header className={handle ? `${css.head} gl-arrange-handle` : css.head} {...handle?.header}>
        <h2 className={css.title} id={titleId}>{asText(props.title)}</h2>
        {handle?.status}
      </header>
      {subtitle ? <p className={css.subtitle}>{subtitle}</p> : null}
      <div className={`gl-grid12 ${css.grid}`} ref={grid}>
        <ArrangeContext.Provider value={arrangement}>{children.map(token => child(token))}</ArrangeContext.Provider>
      </div>
    </section>
  );
};

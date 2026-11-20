// packages/viewer/src/kit/Frame.tsx  (first version by WP0; owned by WP4)
// The plate frame implement() draws around a frameable leaf when it has a title. WP4 gives it the Linework look
// (registration ticks, numbered header, caption); the class names below are the ones styles/base.css targets.
// Two things are contract (KitSlots.Frame in implement.tsx), whatever the look: `children` go inside a `.gl-body`
// that takes the height left under the header, and `aside` (the <PlateAside> slot of the view) goes in the header.
import {useId} from 'react';
import type {KitSlots} from './implement.tsx';

export const Frame: KitSlots['Frame'] = ({def, title, note, aside, children}) => {
  const titleId = useId();
  return (
    <section className="gl-frame" data-gl-frame={def.name} aria-labelledby={titleId}>
      <header className="gl-frame-head">
        <h3 className="gl-frame-title" id={titleId}>{title}</h3>
        {aside}
      </header>
      <div className="gl-body gl-frame-body">{children}</div>
      {note ? <footer className="gl-frame-note">{note}</footer> : null}
    </section>
  );
};

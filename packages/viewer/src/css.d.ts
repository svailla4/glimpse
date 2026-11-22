// packages/viewer/src/css.d.ts
// CSS custom properties in a `style` object, typed: style={{'--gl-span': 3}}. React's CSSProperties lists only the
// standard properties, so without this each `--name` key needed a cast, and the React Compiler leaves a function
// with a cast inside an object key uncompiled (decision compiled-viewer). Write the key as it is, never cast it.
import 'react';

declare module 'react' {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}

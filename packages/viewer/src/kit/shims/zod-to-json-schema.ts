// packages/viewer/src/kit/shims/zod-to-json-schema.ts
// What the viewer bundle gets in place of the `zod-to-json-schema` package (vite.config.ts aliases it here).
// @a2ui/web_core imports that package for one job: writing a catalog out as JSON Schema, which a renderer does when
// it advertises its capabilities to an agent. The Glimpse viewer never does: the server owns the catalog and its
// documents, and the viewer only validates and renders the messages it is sent. Bundling the converter anyway cost
// about 6 kB gzip of the eager script (budget: 200 kB, design rule D13).
// The functions keep their names and shapes so the importing modules link. Should a future @a2ui/web_core call one
// on the render path, it gets a permissive schema instead of a crash, and one console warning says what happened;
// test/build.test.ts fails first, because it checks that the real package is not needed by what the viewer does.
let warned = false;
function note(): void {
  if (warned) return;
  warned = true;
  console.warn('glimpse: zod-to-json-schema is not bundled in the viewer; a JSON Schema was asked for and an open schema was returned');
}

/** The real function converts a zod schema; this one answers "anything". */
export function zodToJsonSchema(): Record<string, unknown> {
  note();
  return {};
}

/** The real function converts one zod definition; see zodToJsonSchema. */
export function parseDef(): Record<string, unknown> {
  note();
  return {};
}

/** The sentinel an override callback returns to fall back to the default conversion. */
export const ignoreOverride: unique symbol = Symbol('Let zodToJsonSchema decide on which parser to use');

export default zodToJsonSchema;

// The root tsconfig compiles for Node (lib ES2023, no DOM). The callbacks passed to page.evaluate() run in the
// browser, so the end-to-end suite needs the DOM types as well.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

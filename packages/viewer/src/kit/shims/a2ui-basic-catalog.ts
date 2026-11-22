// packages/viewer/src/kit/shims/a2ui-basic-catalog.ts
// What the viewer bundle gets in place of `@a2ui/web_core/v0_9/basic_catalog` (vite.config.ts aliases it here).
// @a2ui/react imports two names from that module, the get and set of the markdown renderer the A2UI *basic*
// catalog's Text widget uses. In web_core they live in a file that also imports lit, so asking for them put lit and
// its directives in the eager script (about 6 kB gzip; budget 215 kB, design rule budgets-keep-headroom). Glimpse does not use the
// basic catalog: its own Markdown component renders markdown, in a lazy chunk.
// This is the same registry without lit. The React renderer keeps working exactly as before: it only ever reads
// back what it stored. Only these two names exist here on purpose: if a later @a2ui/react imports anything else
// from the basic catalog, the build fails on the missing export instead of shipping a half-working module.
type MarkdownRenderer = (markdown: string, options?: unknown) => Promise<string>;

let renderer: MarkdownRenderer | undefined;

export function setMarkdownRenderer(next: MarkdownRenderer | undefined): void {
  renderer = next;
}

export function getMarkdownRenderer(): MarkdownRenderer | undefined {
  return renderer;
}

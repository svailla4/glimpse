// packages/catalog/src/normalize.ts
// The canonical Express normalizer: single-quoted strings -> double-quoted strings. It lives in the catalog (not in
// packages/server/src/spec) because the catalog tests, scripts/generate.ts, the committed fixtures and the viewer
// test harness all compile Express through it; packages/server/src/spec/normalize.ts re-exports it. Changing its
// behaviour can change fixtures/gallery.wire.json: run `npm run generate` afterwards.
//
// Rules (pinned by test/normalize.test.ts):
// - Double-quoted strings and comments (`#` or `//` to end of line) are copied unchanged.
// - Inside a single-quoted string a ' closes the string only when the next non-space character is one of
//   , ) ] } : = ; or the end of the line or input. Any other ' is an apostrophe and stays ('doesn't').
// - `\'` is an apostrophe that could be mistaken for the closing quote; other escapes are copied as written.
// - A " inside a single-quoted string is escaped; a raw newline becomes \n.
export function normalizeSpec(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      out += src.slice(i, j);
      i = j;
    } else if (c === "'") {
      let j = i + 1;
      let body = '';
      for (; j < src.length; j++) {
        const d = src[j]!;
        if (d === '\\' && j + 1 < src.length) { body += src[j + 1] === "'" ? "'" : d + src[j + 1]; j++; continue; }
        if (d === "'") {
          let k = j + 1;
          while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
          const next = src[k];
          if (next === undefined || ',)]}:=;\n\r'.includes(next)) break;
          body += "'";
          continue;
        }
        if (d === '"') { body += '\\"'; continue; }
        if (d === '\n') { body += '\\n'; continue; }
        body += d;
      }
      out += '"' + body + '"';
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}


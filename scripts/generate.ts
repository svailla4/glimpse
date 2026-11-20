// scripts/generate.ts - writes every generated file of packages/catalog (run: npm run generate).
//   generated/catalog.json        the catalog document for other A2UI tooling
//   generated/instructions.txt    MCP server instructions (serverInstructions())
//   generated/signatures.txt      typed component signatures (typedSignatureList())
//   fixtures/gallery.wire.json    GALLERY_SPEC compiled to a v1.0 createSurface, with /ds, /ui and /meta
//   fixtures/datasets/<source>.json, fixtures/host/{file,diff,outline,rows}.json
// The content comes from packages/catalog/testing/artifacts.ts so a test can compare it with the files on disk.
// `node scripts/generate.ts --check` writes nothing and exits 1 when a file is stale.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildArtifacts} from '../packages/catalog/testing/artifacts.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'catalog');
const check = process.argv.includes('--check');

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const stale: string[] = [];
let written = 0;
const artifacts = buildArtifacts();
for (const [path, content] of Object.entries(artifacts)) {
  const file = join(root, path);
  if (read(file) === content) continue;
  stale.push(path);
  if (check) continue;
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, content);
  written++;
}

const total = Object.keys(artifacts).length;
if (check && stale.length > 0) {
  console.error(`generate --check: ${stale.length} of ${total} files are stale. Run "npm run generate".\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
console.log(check ? `generate --check: ${total} files are up to date` : `generate: ${written} written, ${total - written} unchanged (packages/catalog)`);

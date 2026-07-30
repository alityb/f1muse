import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSemanticCatalogSnapshot } from '../src/f1ql/semantic-catalog';

export const SEMANTIC_CATALOG_SNAPSHOT_PATH = path.resolve(process.cwd(), 'tests/fixtures/semantic-catalog.snapshot.json');

export function emitSemanticCatalogSnapshot(): string {
  return `${JSON.stringify(buildSemanticCatalogSnapshot(), null, 2)}\n`;
}

if (require.main === module) {
  writeFileSync(SEMANTIC_CATALOG_SNAPSHOT_PATH, emitSemanticCatalogSnapshot());
  console.log(`Wrote ${SEMANTIC_CATALOG_SNAPSHOT_PATH}`);
}

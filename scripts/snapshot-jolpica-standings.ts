import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const season = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isInteger(season) || season < 1950 || season > 2100) {
  throw new Error('Usage: tsx scripts/snapshot-jolpica-standings.ts <season>');
}

const sourceUrl = `https://api.jolpi.ca/ergast/f1/${season}/driverstandings/?format=json&limit=100`;
const outputPath = path.resolve(process.cwd(), `tests/golden/snapshots/jolpica-${season}-driverstandings.json`);

async function main(): Promise<void> {
  const response = await fetch(sourceUrl, {
    headers: { 'User-Agent': 'f1muse-golden-snapshot/1.0' }
  });
  if (!response.ok) {
    throw new Error(`Jolpica request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({
    captured_at: new Date().toISOString(),
    source_url: sourceUrl,
    payload
  }, null, 2)}\n`, 'utf8');
  console.log(`Jolpica standings snapshot written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

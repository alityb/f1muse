import { readFileSync } from 'node:fs';

const input = process.argv[2];
const lines = input ? readFileSync(input, 'utf8').split('\n') : [];
const outcomes = new Map<string, number>();
const operations = new Map<string, number>();

for (const line of lines) {
  if (!line.includes('[F1QLTranslation]')) continue;
  const payload = line.slice(line.indexOf('{'));
  try {
    const event = JSON.parse(payload) as { status?: string; operation?: string };
    const status = event.status ?? 'unknown';
    outcomes.set(status, (outcomes.get(status) ?? 0) + 1);
    if (event.operation) operations.set(event.operation, (operations.get(event.operation) ?? 0) + 1);
  } catch { /* Ignore malformed external log lines. */ }
}

const total = Array.from(outcomes.values()).reduce((sum, value) => sum + value, 0);
const succeeded = outcomes.get('success') ?? 0;
console.log('# F1QL Shadow Translation Review');
console.log('');
console.log(`- Window: trailing 30 days`);
console.log(`- Attempts: ${total}`);
console.log(`- Success rate: ${total ? ((succeeded / total) * 100).toFixed(2) : '0.00'}%`);
console.log('');
console.log('## Outcomes');
for (const [outcome, count] of outcomes) console.log(`- ${outcome}: ${count}`);
console.log('');
console.log('## Operations');
for (const [operation, count] of operations) console.log(`- ${operation}: ${count}`);
console.log('');
console.log(`## Readiness\n- ${total >= 100 && succeeded / total >= 0.99 ? 'Eligible for reviewed execution experiment.' : 'Keep shadow-only; insufficient volume or success rate.'}`);

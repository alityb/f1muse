import { readFileSync } from 'node:fs';

const input = process.argv[2];
const lines = input ? readFileSync(input, 'utf8').split('\n') : [];
const outcomes = new Map<string, number>();
const operations = new Map<string, number>();
const reasons = new Map<string, number>();
const timestamps: string[] = [];

for (const line of lines) {
  let message = line;
  let envelopeTimestamp: string | undefined;
  try {
    const envelope = JSON.parse(line) as { message?: unknown; timestamp?: string };
    message = typeof envelope.message === 'string' ? envelope.message : line;
    envelopeTimestamp = envelope.timestamp;
  } catch { /* Raw console line. */ }
  if (!message.includes('[F1QLTranslation]')) continue;
  const payload = message.slice(message.indexOf('{'));
  try {
    const event = JSON.parse(payload) as { outcome?: string; reason?: string; operation?: string; timestamp?: string };
    const outcome = event.outcome ?? 'unknown';
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    if (event.reason && outcome !== 'succeeded') reasons.set(event.reason, (reasons.get(event.reason) ?? 0) + 1);
    if (event.timestamp ?? envelopeTimestamp) timestamps.push(event.timestamp ?? envelopeTimestamp!);
    if (event.operation) operations.set(event.operation, (operations.get(event.operation) ?? 0) + 1);
  } catch { /* Ignore malformed external log lines. */ }
}

const total = Array.from(outcomes.values()).reduce((sum, value) => sum + value, 0);
const succeeded = outcomes.get('succeeded') ?? 0;
console.log('# F1QL Shadow Translation Review');
console.log('');
console.log(`- Window: ${timestamps.length ? `${timestamps.sort()[0]} to ${timestamps.sort().at(-1)}` : 'no retained events'}`);
console.log(`- Attempts: ${total}`);
console.log(`- Success rate: ${total ? ((succeeded / total) * 100).toFixed(2) : '0.00'}%`);
console.log('');
console.log('## Outcomes');
for (const [outcome, count] of outcomes) console.log(`- ${outcome}: ${count}`);
console.log('\n## Rejection reasons');
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`- ${reason}: ${count}`);
console.log('');
console.log('## Operations');
for (const [operation, count] of operations) console.log(`- ${operation}: ${count}`);
console.log('');
console.log(`## Readiness\n- ${total >= 100 && succeeded / total >= 0.99 ? 'Eligible for reviewed execution experiment.' : 'Keep shadow-only; insufficient volume or success rate.'}`);

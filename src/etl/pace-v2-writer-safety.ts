export interface PaceV2RoundOutcome {
  status: 'success' | 'skipped' | 'failed';
}

export interface PaceV2FailFastResult<Round, Outcome extends PaceV2RoundOutcome> {
  processed: Array<{ round: Round; outcome: Outcome }>;
  failure?: { round: Round; error?: unknown; outcome?: Outcome };
  unprocessed: Round[];
}

export async function processPaceV2RoundsFailFast<Round, Outcome extends PaceV2RoundOutcome>(
  rounds: Round[],
  processRound: (round: Round) => Promise<Outcome>
): Promise<PaceV2FailFastResult<Round, Outcome>> {
  const processed: Array<{ round: Round; outcome: Outcome }> = [];
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    try {
      const outcome = await processRound(round);
      processed.push({ round, outcome });
      if (outcome.status === 'failed') {
        return { processed, failure: { round, outcome }, unprocessed: rounds.slice(index + 1) };
      }
    } catch (error) {
      return { processed, failure: { round, error }, unprocessed: rounds.slice(index + 1) };
    }
  }
  return { processed, unprocessed: [] };
}

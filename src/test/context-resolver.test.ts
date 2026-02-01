import { describe, it, expect } from 'vitest';
import { applyConversationContext } from '../conversation/context-resolver';
import { ConversationContext } from '../conversation/context-types';
import { QueryIntent } from '../types/query-intent';

const baseIntent = {
  kind: 'cross_team_track_scoped_driver_comparison',
  track_id: 'suzuka',
  driver_a_id: 'max_verstappen',
  driver_b_id: 'fernando_alonso',
  season: 2023,
  metric: 'avg_true_pace',
  normalization: 'none',
  clean_air_only: false,
  compound_context: 'mixed',
  session_scope: 'all',
  raw_query: 'test'
} as const;

describe('Conversation context resolver', () => {
  it('carries over season when missing and no explicit year is present', () => {
    const previous: ConversationContext = {
      last_season: 2022
    };

    const draftIntent: QueryIntent = {
      ...baseIntent,
      season: null as unknown as number
    };

    const result = applyConversationContext({
      raw_question: 'How did they compare at Suzuka?',
      draft_intent: draftIntent,
      previous
    });

    expect(result.resolved_intent.season).toBe(2022);
  });

  it('resolves driver pronoun references', () => {
    const previous: ConversationContext = {
      last_driver_ids: ['max_verstappen']
    };

    const draftIntent: QueryIntent = {
      ...baseIntent,
      kind: 'teammate_gap_summary_season',
      driver_a_id: '' as unknown as string,
      driver_b_id: 'sergio_perez'
    };

    const result = applyConversationContext({
      raw_question: 'How did he compare to his teammate?',
      draft_intent: draftIntent,
      previous
    });

    expect(result.resolved_intent.driver_a_id).toBe('max_verstappen');
    expect(result.resolved_intent.driver_b_id).toBe('sergio_perez');
  });

  it('resolves teammate follow-ups from prior teammate queries', () => {
    const previous: ConversationContext = {
      last_driver_ids: ['lando_norris', 'oscar_piastri'],
      last_query_kind: 'teammate_gap_summary_season'
    };

    const draftIntent: QueryIntent = {
      ...baseIntent,
      kind: 'teammate_gap_summary_season',
      driver_a_id: 'lando_norris',
      driver_b_id: '' as unknown as string
    };

    const result = applyConversationContext({
      raw_question: 'What about his teammate?',
      draft_intent: draftIntent,
      previous
    });

    expect(result.resolved_intent.driver_b_id).toBe('oscar_piastri');
  });
});

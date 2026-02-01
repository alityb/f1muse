import { QueryIntent } from '../types/query-intent';

export interface ConversationContext {
  last_driver_ids?: string[];
  last_track_id?: string;
  last_season?: number | null;
  last_query_kind?: string;
}

export interface ContextResolutionInput {
  raw_question: string;
  draft_intent: QueryIntent;
  previous?: ConversationContext;
}

export interface ContextResolutionOutput {
  resolved_intent: QueryIntent;
  updated_context: ConversationContext;
}

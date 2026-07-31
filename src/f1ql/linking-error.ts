export class F1QLLinkingError extends Error {
  constructor(readonly code: 'event_ambiguous' | 'entity_ambiguous' | 'source_coverage_missing' | 'temporal_scope_unsupported', readonly options?: string[], readonly entityCandidates?: string[]) {
    super(code);
  }
}

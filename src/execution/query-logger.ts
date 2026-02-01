import { QueryIntent } from '../types/query-intent';
import { QueryResult, QueryError } from '../types/results';

/**
 * PHASE J: Query log entry structure
 */
export interface QueryLogEntry {
  timestamp: string;
  query_kind: string;
  sql_template_id?: string;
  status: 'success' | 'validation_failed' | 'execution_failed';
  rejection_reason?: string;
  rows_returned?: number;
}

/**
 * PHASE J: Observability and safety logging
 *
 * Logs structured information for each query:
 * - timestamp
 * - validated QueryIntent kind
 * - sql_template_id
 * - success / rejection reason
 * - rows returned (if success)
 */
export class QueryLogger {
  private logs: QueryLogEntry[];
  private maxLogs: number;

  constructor(maxLogs: number = 10000) {
    this.logs = [];
    this.maxLogs = maxLogs;
  }

  /**
   * Log a successful query execution
   */
  logSuccess(intent: QueryIntent, result: QueryResult): void {
    const entry: QueryLogEntry = {
      timestamp: new Date().toISOString(),
      query_kind: intent.kind,
      sql_template_id: result.metadata.sql_template_id,
      status: 'success',
      rows_returned: result.metadata.rows
    };

    this.addLog(entry);
  }

  /**
   * Log a validation failure
   */
  logValidationFailure(intent: QueryIntent, error: QueryError): void {
    const entry: QueryLogEntry = {
      timestamp: new Date().toISOString(),
      query_kind: intent.kind,
      status: 'validation_failed',
      rejection_reason: error.reason
    };

    this.addLog(entry);
  }

  /**
   * Log an execution failure
   */
  logExecutionFailure(intent: QueryIntent, error: QueryError): void {
    const entry: QueryLogEntry = {
      timestamp: new Date().toISOString(),
      query_kind: intent.kind,
      status: 'execution_failed',
      rejection_reason: error.reason
    };

    this.addLog(entry);
  }

  /**
   * Add log entry with rotation
   */
  private addLog(entry: QueryLogEntry): void {
    // Log to console for immediate visibility
    console.log('[QueryLog]', JSON.stringify(entry));

    // Store in memory (with rotation)
    this.logs.push(entry);

    // Rotate if exceeds max size
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  /**
   * Get recent logs
   */
  getRecentLogs(limit: number = 100): QueryLogEntry[] {
    return this.logs.slice(-limit);
  }

  /**
   * Get logs filtered by status
   */
  getLogsByStatus(status: 'success' | 'validation_failed' | 'execution_failed'): QueryLogEntry[] {
    return this.logs.filter(log => log.status === status);
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    success: number;
    validation_failed: number;
    execution_failed: number;
  } {
    return {
      total: this.logs.length,
      success: this.logs.filter(log => log.status === 'success').length,
      validation_failed: this.logs.filter(log => log.status === 'validation_failed').length,
      execution_failed: this.logs.filter(log => log.status === 'execution_failed').length
    };
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = [];
  }
}

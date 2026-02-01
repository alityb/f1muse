/**
 * backward compatible re-export of QueryOrchestrator as QueryExecutor
 *
 * this file maintains the original api surface while delegating to the
 * new modular orchestration layer.
 */

import { QueryOrchestrator, ExecuteOptions } from './orchestration';

// re-export for backward compatibility
export { ExecuteOptions };
export { QueryOrchestrator as QueryExecutor };

import type { DlqFilter, FailureReason } from '../../domain/types/dlq';
import type { DlqQuery } from '../types/adapter';

/**
 * The engine filter for a DLQ query, or undefined when the query neither filters by reason
 * nor skips entries. Both backends hand the same value to the engine (embedded directly,
 * TCP as the `Dlq` command's `filter`), so paging and filtering cannot diverge.
 */
export function dlqFilter(query: DlqQuery): DlqFilter | undefined {
  const offset = query.offset !== undefined && query.offset > 0 ? query.offset : undefined;
  if (query.reason === undefined && offset === undefined) return undefined;
  return {
    ...(query.reason === undefined ? {} : { reason: query.reason as FailureReason }),
    ...(offset === undefined ? {} : { offset }),
  };
}

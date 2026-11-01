/**
 * The DLQ error of a flow parent failed by its child's `failParentOnFailure`. Both
 * backends write it, and the startup repair of legacy stuck parents recognizes such a
 * parent by this prefix, so the format lives in one place.
 */

/** Every parent failed by a child carries an error starting with this prefix. */
export const FAILED_BY_CHILD_PREFIX = 'Child job ';

export function failedByChildMessage(childId: string, error: string): string {
  return `${FAILED_BY_CHILD_PREFIX}${childId} failed: ${error}`;
}

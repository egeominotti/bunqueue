/**
 * The `priority` column value of a job.
 *
 * `bunqueue_jobs.priority` is an INTEGER, while a job's priority is any finite number
 * (2.9.10 admitted fractional priorities and priorities above 1,000,000 on add and on
 * ChangePriority). The payload keeps the exact value; the column, which only orders
 * claims, gets it within the INTEGER range so the write cannot fail with "integer out
 * of range". PostgreSQL rounds a fraction when it assigns a float to an INTEGER.
 */
const MIN_INTEGER = -2_147_483_648;
const MAX_INTEGER = 2_147_483_647;

export function postgresPriorityColumn(priority: number): number {
  if (priority > MAX_INTEGER) return MAX_INTEGER;
  if (priority < MIN_INTEGER) return MIN_INTEGER;
  return priority;
}

import type { Job, JobId, JobLock } from '../types/jobs/model';
import { DEFAULT_LOCK_TTL } from './constants';
import { generateLockToken } from './ids';

export function createJobLock(
  jobId: JobId,
  owner: string,
  ttl: number = DEFAULT_LOCK_TTL,
  now: number = Date.now()
): JobLock {
  return {
    jobId,
    token: generateLockToken(),
    owner,
    createdAt: now,
    expiresAt: now + ttl,
    lastRenewalAt: now,
    renewalCount: 0,
    ttl,
  };
}

export function isLockExpired(lock: JobLock, now: number = Date.now()): boolean {
  return now >= lock.expiresAt;
}

export function renewLock(lock: JobLock, newTtl?: number, now: number = Date.now()): void {
  const ttl = newTtl ?? lock.ttl;
  lock.expiresAt = now + ttl;
  lock.lastRenewalAt = now;
  lock.renewalCount++;
}

/**
 * True when `lock` was created for an earlier processing generation of `job`,
 * that is, the job was pulled again after the lease was granted. Stall retry
 * deliberately keeps the previous lease as a stale-outcome guard, so a lease in
 * `jobLocks` is not necessarily the current one.
 *
 * Pull stamps `startedAt` from a clock read taken before the lease is created
 * in the same delivery, so a lease from the current pull always has
 * `createdAt >= startedAt`. The comparison is strict: a lease created in the
 * same millisecond as the pull belongs to the current generation.
 */
export function isLeaseFromEarlierGeneration(
  job: Pick<Job, 'startedAt'>,
  lock: Pick<JobLock, 'createdAt'>
): boolean {
  return job.startedAt !== null && job.startedAt !== undefined && job.startedAt > lock.createdAt;
}

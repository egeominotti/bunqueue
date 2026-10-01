/**
 * Client Ownership - which connection owns a job's current delivery.
 *
 * `clientJobs` maps a connection to the jobs it pulled. `clientJobOwners` is
 * its reverse index: one record per owned job naming the owning connection and
 * the delivery it owns. A delivery is identified by the processing
 * `JobLocation` object the pull installed in `jobIndex`. Only a pull installs a
 * processing location, and every pull installs a fresh object, so the record
 * of an earlier delivery never matches a later delivery of the same job id.
 *
 * Every mutation of the two maps goes through this module so they stay in
 * step: a job is in `clientJobs.get(c)` exactly when its owner record names
 * `c`. Every operation is O(1) per job.
 */

import type { JobId } from '../domain/types/job';
import type { JobLocation } from '../domain/types/queue';

/** The connection that registered a job's delivery, and that delivery. */
export interface ClientJobOwner {
  readonly clientId: string;
  /** The `jobIndex` entry current when the connection registered the job. */
  readonly delivery: JobLocation | undefined;
}

/** The two ownership maps plus the index that identifies deliveries. */
export interface ClientOwnershipContext {
  jobIndex: Map<JobId, JobLocation>;
  clientJobs: Map<string, Set<JobId>>;
  clientJobOwners: Map<JobId, ClientJobOwner>;
}

/** The maps a detach touches; it never needs the job index. */
export type ClientOwnershipMaps = Pick<ClientOwnershipContext, 'clientJobs' | 'clientJobOwners'>;

function removeFromClient(clientId: string, jobId: JobId, ctx: ClientOwnershipMaps): void {
  const jobs = ctx.clientJobs.get(clientId);
  if (!jobs) return;
  jobs.delete(jobId);
  if (jobs.size === 0) ctx.clientJobs.delete(clientId);
}

/**
 * Register `clientId` as the owner of the job's current delivery (called after
 * PULL). A delivery has one owner, so any previous owner is detached first.
 */
export function registerClientJob(
  clientId: string,
  jobId: JobId,
  ctx: ClientOwnershipContext
): void {
  const previous = ctx.clientJobOwners.get(jobId);
  if (previous && previous.clientId !== clientId) {
    removeFromClient(previous.clientId, jobId, ctx);
  }
  ctx.clientJobOwners.set(jobId, { clientId, delivery: ctx.jobIndex.get(jobId) });
  let jobs = ctx.clientJobs.get(clientId);
  if (!jobs) {
    jobs = new Set();
    ctx.clientJobs.set(clientId, jobs);
  }
  jobs.add(jobId);
}

/**
 * Remove one connection's claim on a job (ACK/FAIL handled on that
 * connection). Another connection's record for the same job is left alone: it
 * may already own a newer delivery.
 */
export function unregisterClientJob(
  clientId: string | undefined,
  jobId: JobId,
  ctx: ClientOwnershipMaps
): void {
  if (!clientId) return;
  removeFromClient(clientId, jobId, ctx);
  if (ctx.clientJobOwners.get(jobId)?.clientId === clientId) ctx.clientJobOwners.delete(jobId);
}

/**
 * End ownership of a job's delivery, whoever holds it. Every transition that
 * ends a delivery without the owner's ACK/FAIL calls this (stall recovery,
 * orphan recovery, lock expiry, timeout, management claims, disconnect
 * release), so a silent connection never keeps a job it no longer runs.
 */
export function detachClientJob(jobId: JobId, ctx: ClientOwnershipMaps): void {
  const owner = ctx.clientJobOwners.get(jobId);
  if (!owner) return;
  ctx.clientJobOwners.delete(jobId);
  removeFromClient(owner.clientId, jobId, ctx);
}

/**
 * True only when `clientId` registered the job's current delivery: the job is
 * processing and its processing entry is the one the connection registered.
 * Disconnect release acts on nothing else, so a stale registration can never
 * release or expire a later delivery owned by another worker.
 */
export function ownsCurrentDelivery(
  clientId: string,
  jobId: JobId,
  ctx: ClientOwnershipContext
): boolean {
  const owner = ctx.clientJobOwners.get(jobId);
  if (owner?.clientId !== clientId) return false;
  const location = ctx.jobIndex.get(jobId);
  return location?.type === 'processing' && location === owner.delivery;
}

/** Forget a disconnected client: its set and only its own owner records. */
export function dropClient(clientId: string, ctx: ClientOwnershipMaps): void {
  const jobs = ctx.clientJobs.get(clientId);
  ctx.clientJobs.delete(clientId);
  if (!jobs) return;
  for (const jobId of jobs) {
    if (ctx.clientJobOwners.get(jobId)?.clientId === clientId) ctx.clientJobOwners.delete(jobId);
  }
}

/**
 * Detach every record whose delivery has ended. An outcome sent on another
 * connection than the pull (pooled clients) unregisters the sender, not the
 * owner, so such records would otherwise live as long as the pulling
 * connection. Runs synchronously from periodic cleanup.
 * @returns the number of records removed.
 */
export function pruneEndedClientDeliveries(ctx: ClientOwnershipContext): number {
  let pruned = 0;
  for (const [jobId, owner] of ctx.clientJobOwners) {
    // Only a live processing delivery keeps its record. A registration that ran
    // after its delivery ended recorded `undefined` or a terminal location, which
    // would otherwise compare equal forever.
    const location = ctx.jobIndex.get(jobId);
    if (location?.type === 'processing' && location === owner.delivery) continue;
    ctx.clientJobOwners.delete(jobId);
    removeFromClient(owner.clientId, jobId, ctx);
    pruned++;
  }
  return pruned;
}

/**
 * PUSHB Validation
 * Per-job validation for batch pushes with PUSH parity: the same
 * validateJobData/validateJobOptions bounds and the same dependsOn
 * existence gate handlePush enforces (core.ts).
 */

import {
  jobId,
  normalizeLegacyJobPayload,
  type JobId,
  type JobInput,
} from '../../../domain/types/job';
import type { HandlerContext } from '../types';
import { validateGroupId, validateJobData, validateJobOptions } from '../protocol';

/** Validate PUSH dependencies against the authoritative engine. */
export function validatePushDependencies(
  dependencies: readonly string[] | undefined,
  ctx: HandlerContext
): string | null | Promise<string | null> {
  if (!dependencies || dependencies.length === 0) return null;
  const ids = dependencies.map(jobId);
  return ctx.queueManager.findMissingDependenciesDurable(ids).then((missingIds) => {
    const missing = new Set(missingIds.map(String));
    const dependency = dependencies.find((id) => missing.has(String(id)));
    return dependency === undefined ? null : `Dependency job not found: ${dependency}`;
  });
}

/**
 * Validate every job of a PUSHB batch. Returns an error message naming the
 * offending index, or null when the whole batch is valid.
 *
 * The dependsOn gate is EXTENDED beyond the PUSH one: a dependency may also
 * reference ANY OTHER job of the same batch via its custom id (the only ids
 * a client can know before the batch is applied). Order within the batch is
 * deliberately irrelevant: the default-on auto-batcher groups concurrent
 * add() calls in arbitrary order, so a child can legitimately precede its
 * parent in the array, and the readiness layer (waitingDeps) resolves the
 * chain once the whole batch is applied. Self-references are rejected, they
 * can never resolve. The broker checks all external references in one batch.
 */
export function validatePushBatchJobs(
  jobs: JobInput[],
  ctx: HandlerContext
): string | null | Promise<string | null> {
  // Custom ids of ALL jobs in this batch: they become real job ids the
  // moment the batch is applied. Allocated lazily (most batches have neither
  // custom ids nor dependencies).
  let batchIds: Set<string> | null = null;
  const dependencies: JobId[] = [];
  for (const job of jobs) {
    if (job.customId) {
      batchIds ??= new Set();
      batchIds.add(job.customId);
    }
    if (job.dependsOn) {
      for (const id of job.dependsOn) dependencies.push(id);
    }
  }

  const external = batchIds ? dependencies.filter((id) => !batchIds.has(id)) : dependencies;
  if (external.length === 0) return validateJobs(jobs);
  return ctx.queueManager
    .findMissingDependenciesDurable(external)
    .then((missingIds) => validateJobs(jobs, new Set(missingIds)));
}

function validateJobs(jobs: JobInput[], missingDependencies?: ReadonlySet<JobId>): string | null {
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    try {
      normalizeLegacyJobPayload(job);
    } catch (error) {
      return `jobs[${i}]: ${error instanceof Error ? error.message : String(error)}`;
    }

    const dataError = validateJobData(job.data);
    if (dataError) return `jobs[${i}]: ${dataError}`;
    const groupError = validateGroupId(job.groupId);
    if (groupError) return `jobs[${i}]: ${groupError}`;

    const optionsError = validateJobOptions(job);
    if (optionsError) return `jobs[${i}]: ${optionsError}`;

    if (job.dependsOn && job.dependsOn.length > 0) {
      for (const depId of job.dependsOn) {
        const key = String(depId);
        if (key === job.customId) {
          return `jobs[${i}]: Job cannot depend on itself: ${key}`;
        }
        if (missingDependencies?.has(depId)) {
          return `jobs[${i}]: Dependency job not found: ${key}`;
        }
      }
    }
  }

  return null;
}

/**
 * Reproduces a broker failure misreported as a negative outcome (pre-commit review).
 *
 * The MCP TCP backend answers `success: false` instead of an error only when the broker
 * says the target does not exist or is in the wrong state. The classifier matched any
 * message containing "cannot", which also covers JavaScript runtime errors the broker
 * forwards unredacted ("Cannot read properties of undefined ...") and validation errors
 * ("A job cannot be its own parent"), so a broker bug looked like "no such job".
 */

import { describe, expect, test } from 'bun:test';
import { CANCEL_JOB_NOT_FOUND_ERROR, cancelRefusedError } from '../src/domain/job/cancellation';
import { BrokerError, isNegativeOutcome } from '../src/mcp/backend/tcp/wire';

const outcome = (message: string) => isNegativeOutcome(new BrokerError('Cmd', message));

describe('isNegativeOutcome', () => {
  test('broker replies meaning "no such target" or "wrong state" are negative outcomes', () => {
    for (const message of [
      'Job not found',
      'Job not found or cannot be cancelled',
      'Job cannot be cancelled: not in queue (current state: active)',
      'Job cannot be cancelled: not in queue (current state: failed)',
      'Job not found or cannot be updated',
      'Job not found or cannot change delay',
      'Job not found or not delayed',
      'Job is not active (current state: completed)',
      "Cannot move job from state 'active' to waiting",
      'Lock not found or invalid token',
    ]) {
      expect({ message, negative: outcome(message) }).toEqual({ message, negative: true });
    }
  });

  test('runtime, validation and auth errors are failures, not negative outcomes', () => {
    for (const message of [
      "Cannot read properties of undefined (reading 'state')",
      "Cannot access 'shard' before initialization",
      'A job cannot be its own parent',
      'Job cannot be removed while the broker is shutting down',
      'Not authenticated',
      'Unknown command',
    ]) {
      expect({ message, negative: outcome(message) }).toEqual({ message, negative: false });
    }
  });
});

/**
 * Mixed versions: bunqueue-mcp 2.9.13 talking to this broker. Its classifier (copied
 * verbatim from `git show 8ef483e5:src/mcp/backend/tcp/wire.ts`) has no "cannot be
 * cancelled" alternative, so a refusal worded only "Job cannot be cancelled (current
 * state: active)" made `bunqueue_cancel_job` a tool error instead of `success: false`.
 */
const NEGATIVE_OUTCOME_2_9_13 =
  /\bnot found\b|\bnot active\b|\bnot delayed\b|\bnot in queue\b|\binvalid token\b|\bcannot move job from state\b/i;

describe('Cancel refusals read by bunqueue-mcp 2.9.13', () => {
  test('every refusal this broker sends is a negative outcome for the 2.9.13 classifier', () => {
    for (const message of [
      CANCEL_JOB_NOT_FOUND_ERROR,
      ...['active', 'failed', 'waiting'].map((state) => cancelRefusedError(state)),
    ]) {
      expect({ message, negative: NEGATIVE_OUTCOME_2_9_13.test(message) }).toEqual({
        message,
        negative: true,
      });
      expect({ message, negative: outcome(message) }).toEqual({ message, negative: true });
    }
  });

  test('a refusal of an existing job never says "not found" (external SDKs keep raising)', () => {
    for (const state of ['active', 'failed', 'waiting']) {
      expect(cancelRefusedError(state)).toBe(
        `Job cannot be cancelled: not in queue (current state: ${state})`
      );
      expect(cancelRefusedError(state)).not.toMatch(/not found/i);
    }
  });
});

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
import { BrokerError, isNegativeOutcome } from '../src/mcp/backend/tcp/wire';

const outcome = (message: string) => isNegativeOutcome(new BrokerError('Cmd', message));

describe('isNegativeOutcome', () => {
  test('broker replies meaning "no such target" or "wrong state" are negative outcomes', () => {
    for (const message of [
      'Job not found',
      'Job not found or cannot be cancelled',
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
      'Not authenticated',
      'Unknown command',
    ]) {
      expect({ message, negative: outcome(message) }).toEqual({ message, negative: false });
    }
  });
});

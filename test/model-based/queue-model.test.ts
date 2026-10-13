import { describe, test } from 'bun:test';
import { runCrossQueueInvariantCampaign } from './cross-queue-invariants';
import { queueCommandArbitraries } from './queue-commands';
import {
  optionalInteger,
  optionalPath,
  optionalSize,
  runQueueModelCampaign,
} from './queue-model-campaign';
import { terminalLifecycleArbitraries } from './terminal-lifecycle-commands';

const DEFAULT_RUNS = 150;
const DEFAULT_COMMANDS = 80;
const DEFAULT_TERMINAL_RUNS = 30;
const DEFAULT_TERMINAL_COMMANDS = 40;

describe('Queue state-machine model against the real broker', () => {
  test('generated lifecycle, batch, dependency, control and SIGKILL sequences preserve invariants', async () => {
    await runQueueModelCampaign({
      arbitraries: queueCommandArbitraries(),
      label: 'lifecycle',
      maxCommands: optionalInteger(Bun.env.BUNQUEUE_MODEL_COMMANDS) ?? DEFAULT_COMMANDS,
      numRuns: optionalInteger(Bun.env.BUNQUEUE_MODEL_RUNS) ?? DEFAULT_RUNS,
      path: optionalPath(Bun.env.BUNQUEUE_MODEL_PATH),
      seed: optionalInteger(Bun.env.BUNQUEUE_MODEL_SEED),
      size: optionalSize(Bun.env.BUNQUEUE_MODEL_SIZE),
      timeLimitMs: 120000,
    });
  }, 130000);

  test('generated completion, failure, retry, cancel and SIGKILL histories preserve invariants', async () => {
    // `max` makes the command cap the real bound: at fast-check's default size a history
    // has at most 10 commands whatever the cap.
    await runQueueModelCampaign({
      arbitraries: terminalLifecycleArbitraries(),
      label: 'terminal-lifecycle',
      maxCommands:
        optionalInteger(Bun.env.BUNQUEUE_TERMINAL_MODEL_COMMANDS) ?? DEFAULT_TERMINAL_COMMANDS,
      numRuns: optionalInteger(Bun.env.BUNQUEUE_TERMINAL_MODEL_RUNS) ?? DEFAULT_TERMINAL_RUNS,
      path: optionalPath(Bun.env.BUNQUEUE_TERMINAL_MODEL_PATH),
      seed: optionalInteger(Bun.env.BUNQUEUE_MODEL_SEED),
      size: 'max',
      timeLimitMs: 60000,
    });
  }, 70000);

  test('generated multi-queue histories preserve shard isolation and global conservation', async () => {
    await runCrossQueueInvariantCampaign();
  }, 70000);
});

import type { Arbitrary, AsyncCommand } from 'fast-check';
import fc from 'fast-check';
import { AckBatchCommand, PullBatchCommand } from './batch-commands';
import { cancelCommandArbitraries } from './cancel-commands';
import { AckFlowCommand, AddFlowCommand } from './flow-commands';
import {
  ProgressCommand,
  RemoveCommand,
  RemoveDlqCommand,
  RetryTerminalCommand,
} from './job-management-commands';
import { MODEL_JOB_IDS } from './model-ids';
import { QueueCommand } from './queue-command';
import {
  AckCommand,
  CrashRestartCommand,
  FailCommand,
  PromoteCommand,
  PullCommand,
  PushCommand,
} from './queue-commands';
import type { QueueModelArbitraries } from './queue-model-campaign';
import type { QueueModel, RealQueue } from './queue-model-harness';

/**
 * The commands that move a job into, out of and away from a terminal state, without the
 * queue controls, contract probes and delays of the full lifecycle model. Drawn from
 * more than fifty kinds, a short history rarely pushes, pulls and completes the same job,
 * so the transitions that need a completed, failed or active job (completion, failure,
 * progress, retry, DLQ removal and cancel, including issue #155's cancel of a completed
 * job) almost never ran under the default size. This vocabulary reaches them in a few
 * commands, against the same real broker, SQLite and oracle.
 */
export function terminalLifecycleArbitraries(): QueueModelArbitraries {
  const slot = fc.integer({ min: 0, max: MODEL_JOB_IDS.length - 1 });
  const any = (label: string, build: (slot: number) => QueueCommand) =>
    slot.map((pick) => new AnySlotCommand(pick, label, build));
  const push = fc
    .tuple(slot, fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 3 }))
    .map(([value, priority, max]) => new PushCommand(value, priority, false, max));
  const progress = fc
    .tuple(slot, fc.integer({ min: 0, max: 100 }))
    .map(
      ([pick, value]) =>
        new AnySlotCommand(pick, 'progress', (at) => new ProgressCommand(at, value))
    );
  const [cancelCompleted, cancelRefused] = cancelCommandArbitraries();
  // Weights favour the steps towards a terminal state and the cancels that need one;
  // promote brings back the jobs a crash or a retry parked behind a 60 s backoff, and
  // crash restarts stay rare because each costs a broker start.
  const weighted: [number, Arbitrary<AsyncCommand<QueueModel, RealQueue>>][] = [
    [5, push],
    [4, fc.constant(new PullCommand())],
    [2, fc.constant(new PullBatchCommand())],
    [4, any('ack', (at) => new AckCommand(at))],
    [2, fc.constant(new AckBatchCommand())],
    [1, any('failRetry', (at) => new FailCommand(at, false))],
    [2, any('failTerminal', (at) => new FailCommand(at, true))],
    [1, progress],
    [1, any('retryCompleted', (at) => new RetryTerminalCommand(at, true))],
    [1, any('retryDlq', (at) => new RetryTerminalCommand(at, false))],
    [1, any('cancel', (at) => new RemoveCommand(at, false))],
    [1, any('removeDlq', (at) => new RemoveDlqCommand(at))],
    [1, fc.constant(new AddFlowCommand())],
    [1, fc.constant(new AckFlowCommand())],
    [1, fc.constant(new CrashRestartCommand())],
    [2, any('promote', (at) => new PromoteCommand(at))],
    [4, cancelCompleted!],
    [3, cancelRefused!],
  ];
  return [fc.oneof(...weighted.map(([weight, arbitrary]) => ({ arbitrary, weight })))];
}

/**
 * Runs a slot command on the `pick`-th slot (wrapping) whose precondition holds, so a
 * drawn ack, failure, progress or retry runs as soon as any job allows it instead of
 * only when the drawn slot happens to.
 */
class AnySlotCommand extends QueueCommand {
  private resolved: QueueCommand | null = null;

  constructor(
    private readonly pick: number,
    private readonly label: string,
    private readonly build: (slot: number) => QueueCommand
  ) {
    super();
  }

  check(model: Readonly<QueueModel>): boolean {
    return this.candidates(model).length > 0;
  }

  async run(model: QueueModel, real: RealQueue): Promise<void> {
    const candidates = this.candidates(model);
    this.resolved = candidates[this.pick % candidates.length]!;
    await this.resolved.run(model, real);
  }

  toString(): string {
    return this.resolved ? this.resolved.toString() : `${this.label}(#${this.pick})`;
  }

  private candidates(model: Readonly<QueueModel>): QueueCommand[] {
    return MODEL_JOB_IDS.map((_, value) => this.build(value)).filter((command) =>
      command.check(model)
    );
  }
}

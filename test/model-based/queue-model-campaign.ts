import type { Arbitrary, AsyncCommand, SizeForArbitrary } from 'fast-check';
import fc from 'fast-check';
import { CommandCoverage } from './command-coverage';
import { RealQueue, type QueueModel } from './queue-model-harness';

export type QueueModelArbitraries = Arbitrary<AsyncCommand<QueueModel, RealQueue>>[];

export interface QueueModelCampaign {
  arbitraries: QueueModelArbitraries;
  label: string;
  maxCommands: number;
  numRuns: number;
  path?: string;
  seed?: number;
  size?: SizeForArbitrary;
  timeLimitMs: number;
}

const COMMAND_SIZES = [
  'xsmall',
  'small',
  'medium',
  'large',
  'xlarge',
  'max',
  '-4',
  '-3',
  '-2',
  '-1',
  '=',
  '+1',
  '+2',
  '+3',
  '+4',
] as const satisfies readonly SizeForArbitrary[];

/**
 * Run generated command histories against a fresh real broker per run. Every history
 * starts from an empty model; each command checks the full oracle after it runs.
 */
export async function runQueueModelCampaign(campaign: QueueModelCampaign): Promise<void> {
  if (campaign.path !== undefined && campaign.seed === undefined) {
    throw new Error(`${campaign.label}: a replay path needs its seed`);
  }
  const coverage = new CommandCoverage();
  let run = 0;

  await fc.assert(
    fc.asyncProperty(
      fc.commands(coverage.track(campaign.arbitraries), {
        maxCommands: campaign.maxCommands,
        ...(campaign.size !== undefined && { size: campaign.size }),
      }),
      async (commands) => {
        coverage.countRun();
        const real = await RealQueue.create(
          `${campaign.label}-${campaign.seed ?? 'random'}-${run++}`
        );
        const model = emptyQueueModel();
        try {
          await fc.asyncModelRun(() => ({ model, real }), commands);
        } finally {
          await real.dispose();
        }
      }
    ),
    {
      endOnFailure: true,
      interruptAfterTimeLimit: campaign.timeLimitMs,
      numRuns: campaign.numRuns,
      ...(campaign.path !== undefined && { path: campaign.path }),
      seed: campaign.seed,
      verbose: 2,
    }
  );
  coverage.report(campaign.label, campaign.numRuns);
}

function emptyQueueModel(): QueueModel {
  return {
    accepted: 0,
    concurrency: null,
    generations: new Map(),
    jobs: new Map(),
    paused: false,
    rateLimit: null,
    rateRemaining: 0,
    removed: 0,
    terminalGenerations: new Set(),
  };
}

export function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`expected a signed safe integer, received ${value}`);
  }
  return parsed;
}

/** fast-check `size` of the generated command histories. */
export function optionalSize(value: string | undefined): SizeForArbitrary | undefined {
  if (value === undefined || value === '') return undefined;
  const size = COMMAND_SIZES.find((candidate) => candidate === value);
  if (size === undefined) {
    throw new Error(`expected a size in ${COMMAND_SIZES.join(', ')}, received ${value}`);
  }
  return size;
}

/** fast-check replay `path` printed with a counterexample, e.g. `97` or `97:3:0`. */
export function optionalPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+(?::\d+)*$/.test(value)) {
    throw new Error(`expected a replay path such as 97 or 97:3:0, received ${value}`);
  }
  return value;
}

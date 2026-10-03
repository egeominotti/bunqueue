/**
 * Job states as getJobState() reports them (src/application/operations/query/state.ts):
 * a job waiting out its retry backoff is `delayed`, and a job in the DLQ is `failed`.
 */
export type JourneyJobState = 'waiting' | 'active' | 'delayed' | 'completed' | 'failed';

export interface JourneyStep {
  /**
   * The attempt in this step throws. The job is still `active` while it runs, so the
   * state chip alone cannot show it; the rail and the card add a "fails" cue.
   */
  attemptFails?: true;
  /** One sentence; text between backticks renders as inline code. */
  detail: string;
  label: string;
  state: JourneyJobState;
}

export interface JobJourney {
  label: string;
  steps: JourneyStep[];
}

export const JOB_JOURNEYS = {
  success: {
    label: 'Succeeds first time',
    steps: [
      {
        label: 'Producer',
        state: 'waiting',
        detail: '`queue.add()` persists the job and returns its ID.',
      },
      {
        label: 'Ready queue',
        state: 'waiting',
        detail: 'The job is eligible and waits in scheduling order.',
      },
      {
        label: 'Worker',
        state: 'active',
        detail: 'One worker claims the job and owns its active attempt.',
      },
      {
        label: 'Completed',
        state: 'completed',
        detail: 'The ACK saves the result and releases the concurrency slot.',
      },
    ],
  },
  retry: {
    label: 'Fails once, then succeeds',
    steps: [
      {
        label: 'Producer',
        state: 'waiting',
        detail: '`queue.add()` persists the job with attempts and backoff.',
      },
      {
        label: 'Ready queue',
        state: 'waiting',
        detail: 'The first attempt becomes eligible for a worker.',
      },
      {
        label: 'Attempt 1',
        state: 'active',
        detail: 'The worker throws, so bunqueue records a failed attempt.',
        attemptFails: true,
      },
      {
        label: 'Retry delay',
        state: 'delayed',
        detail: 'Backoff keeps the job ineligible until its retry time.',
      },
      {
        label: 'Ready again',
        state: 'waiting',
        detail: 'Once the backoff elapses, the job is eligible again in scheduling order.',
      },
      {
        label: 'Attempt 2',
        state: 'active',
        detail: 'A worker claims the next legal attempt.',
      },
      {
        label: 'Completed',
        state: 'completed',
        detail: 'The successful ACK stores the result exactly once.',
      },
    ],
  },
  dlq: {
    label: 'Exhausts every attempt',
    steps: [
      {
        label: 'Producer',
        state: 'waiting',
        detail: '`queue.add()` persists the job with a finite attempt budget.',
      },
      {
        label: 'Ready queue',
        state: 'waiting',
        detail: 'The job becomes eligible for its first attempt.',
      },
      {
        label: 'Attempt 1',
        state: 'active',
        detail: 'Processing fails and consumes one attempt.',
        attemptFails: true,
      },
      {
        label: 'Retry delay',
        state: 'delayed',
        detail: 'Backoff prevents an immediate hot retry.',
      },
      {
        label: 'Final attempt',
        state: 'active',
        detail: 'The worker fails after the remaining attempt is claimed.',
        attemptFails: true,
      },
      {
        label: 'Dead letter queue',
        state: 'failed',
        detail: 'The terminal failure stays available for inspection or replay.',
      },
    ],
  },
} as const satisfies Record<string, JobJourney>;

export interface DetailPart {
  code: boolean;
  text: string;
}

/** Splits a step detail on backticks: odd segments are inline code. */
export function detailParts(detail: string): DetailPart[] {
  return detail
    .split('`')
    .map((text, index) => ({ code: index % 2 === 1, text }))
    .filter(({ text }) => text.length > 0);
}

export function clampJourneyStep(index: number, totalSteps: number): number {
  if (!Number.isFinite(index) || totalSteps <= 0) return 0;
  return Math.max(0, Math.min(Math.trunc(index), totalSteps - 1));
}

export type TopologyId = 'embedded' | 'single-broker' | 'multi-broker';

export interface Topology {
  bestFor: string;
  durability: string;
  id: TopologyId;
  label: string;
  layers: { label: string; nodes: string[] }[];
  links: string[];
  summary: string;
}

export const TOPOLOGIES: Topology[] = [
  {
    id: 'embedded',
    label: 'Embedded',
    summary: 'The producer, queue runtime, and worker share one Bun process.',
    bestFor: 'The smallest deployment, local services, and edge processes.',
    durability: 'Memory or one local SQLite file.',
    layers: [
      { label: 'Bun application', nodes: ['Producer', 'Queue runtime', 'Worker'] },
      { label: 'Optional persistence', nodes: ['SQLite'] },
    ],
    links: ['direct calls'],
  },
  {
    id: 'single-broker',
    label: 'TCP broker',
    summary: 'Independent producers and workers share one bunqueue broker over TCP.',
    bestFor: 'Several processes, several languages, or one central queue service.',
    durability: 'The broker owns memory or one SQLite file.',
    layers: [
      { label: 'Client processes', nodes: ['Producer', 'Worker A', 'Worker B'] },
      { label: 'Queue service', nodes: ['bunqueue broker'] },
      { label: 'Persistence', nodes: ['SQLite'] },
    ],
    links: ['TCP', 'local storage'],
  },
  {
    id: 'multi-broker',
    label: 'PostgreSQL multi-broker',
    summary: 'Clients can use any active broker while PostgreSQL coordinates shared queue state.',
    bestFor: 'Horizontal broker scale, failover, and shared limits across hosts.',
    durability: 'PostgreSQL is authoritative for every broker.',
    layers: [
      { label: 'Client processes', nodes: ['Producers', 'Workers', 'QueueEvents'] },
      { label: 'N active brokers', nodes: ['Broker A', 'Broker B', 'Broker C'] },
      { label: 'Shared persistence', nodes: ['PostgreSQL'] },
    ],
    links: ['TCP through a load balancer', 'transactional coordination'],
  },
];

function lowerFirstWord(label: string): string {
  const [first = '', ...rest] = label.split(' ');
  if (first.length < 2) return label;
  return [first[0].toLowerCase() + first.slice(1), ...rest].join(' ');
}

/**
 * The diagram as one sentence per layer, for its text alternative, e.g.
 * "Client processes: Producer, Worker A, Worker B. Via TCP to queue service: bunqueue broker."
 */
export function describeTopology(topology: Topology): string {
  return topology.layers
    .map(({ label, nodes }, index) => {
      const members = nodes.join(', ');
      if (index === 0) return `${label}: ${members}.`;
      return `Via ${topology.links[index - 1]} to ${lowerFirstWord(label)}: ${members}.`;
    })
    .join(' ');
}

export function resolveTopology(value: string | undefined): Topology {
  return TOPOLOGIES.find(({ id }) => id === value) ?? TOPOLOGIES[0];
}

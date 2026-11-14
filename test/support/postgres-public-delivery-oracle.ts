export interface DeliveryInvocation {
  id: string;
  token?: string;
  attempt: number;
  start: number;
  end?: number;
  stage: 'progress' | 'log' | 'return';
  outcome?: 'returned' | 'threw';
  error?: string;
  result?: number;
}

export interface DeliveryFailure {
  id?: string;
  token?: string;
  at: number;
  error: string;
}

interface TimelineEntry {
  state: string;
  timestamp: number;
  attempt?: number;
  error?: string;
}

export interface DurableDeliveryEvent {
  id: number;
  jobId: string;
  type: string;
  at: number;
  attempt?: number;
  error?: string;
  result?: unknown;
  timeline: TimelineEntry[];
}

export interface DeliveryHistory {
  invocations: DeliveryInvocation[];
  failures: DeliveryFailure[];
  unexpected: unknown[];
  events: DurableDeliveryEvent[];
  jobs: {
    id: string;
    state: string;
    attempt: number;
    result: unknown;
    timeline: TimelineEntry[];
  }[];
  completions: { id: string; result: unknown }[];
}

/** This fixture permits only an applied, pre-log Progress failure followed by retry. */
export function assertPublicDeliveryHistory(
  history: DeliveryHistory,
  expected: ReadonlyMap<string, number>
): void {
  const check: (condition: unknown, message: string) => asserts condition = (
    condition,
    message
  ) => {
    if (!condition) throw new Error(`${message}\n${JSON.stringify(history)}`);
  };
  check(history.unexpected.length === 0, 'Unexpected Worker error or stalled recovery');
  for (const entries of [history.invocations, history.jobs, history.completions]) {
    check(
      entries.every(({ id }) => expected.has(id)),
      'Unexpected job ID'
    );
  }
  check(
    history.events.every(({ jobId }) => expected.has(jobId)),
    'Unexpected event job ID'
  );
  check(history.jobs.length === expected.size, 'Terminal job count mismatch');
  check(history.completions.length === expected.size, 'Completion tombstone count mismatch');
  const tokens = new Set<string>();
  for (const invocation of history.invocations) {
    check(
      typeof invocation.token === 'string' &&
        invocation.token.trim() &&
        !tokens.has(invocation.token),
      'Missing or repeated delivery token'
    );
    tokens.add(invocation.token);
  }
  let totalFailures = 0;
  for (const [id, result] of expected) {
    const calls = history.invocations.filter((entry) => entry.id === id);
    const events = history.events.filter((event) => event.jobId === id);
    const transitions = events.filter(({ type }) => type !== 'pushed' && type !== 'progress');
    const pulls = events.filter(({ type }) => type === 'pulled');
    const failures = events.filter(({ type }) => type === 'failed');
    const retries = events.filter(({ type }) => type === 'retried');
    const completed = events.filter(({ type }) => type === 'completed');
    check(calls.length > 0 && pulls.length === calls.length, `${id}: invocation/pull mismatch`);
    check(
      failures.length === calls.length - 1 && retries.length === failures.length,
      `${id}: unexplained repeated delivery or missing durable failure`
    );
    check(completed.length === 1, `${id}: duplicate or missing durable completion`);
    check(
      transitions.map(({ type }) => type).join(',') ===
        [
          ...calls.flatMap((_, index) => (index ? ['retried', 'failed', 'pulled'] : ['pulled'])),
          'completed',
        ].join(','),
      `${id}: unexpected durable transition (including recovery/release)`
    );
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      check(call.end !== undefined && call.end > call.start, `${id}: unfinished invocation`);
      check(
        index === 0 || calls[index - 1].end! < call.start,
        `${id}: overlapping processor invocations`
      );
    }
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      const pull = pulls[index];
      check(call.attempt === index && pull.attempt === index, `${id}: noncontiguous attempt`);
      check(call.end !== undefined, `${id}: unfinished invocation`);
      if (index === calls.length - 1) {
        check(
          call.outcome === 'returned' && call.stage === 'return' && call.result === result,
          `${id}: incorrect processor result`
        );
        continue;
      }
      check(
        call.outcome === 'threw' &&
          call.stage === 'progress' &&
          call.error === 'Error: Internal server error',
        `${id}: unexpected processor failure or stage`
      );
      const applied = history.failures.filter(
        (failure) => failure.id === id && failure.token === call.token
      );
      check(
        applied.length === 1 &&
          applied[0].error === call.error &&
          applied[0].at > call.end &&
          applied[0].at < calls[index + 1].start,
        `${id}: missing or unordered applied Worker failure`
      );
      const failure = failures[index];
      const retry = retries[index];
      const nextPull = pulls[index + 1];
      check(
        failure.attempt === index + 1 &&
          retry.attempt === index + 1 &&
          failure.error === 'Internal server error',
        `${id}: durable failure attempt/error mismatch`
      );
      check(
        pull.id < retry.id &&
          retry.id < failure.id &&
          failure.id < nextPull.id &&
          pull.at <= failure.at &&
          failure.at <= nextPull.at,
        `${id}: durable failure must precede next pull`
      );
      const failedTimeline = nextPull.timeline.filter(({ state }) => state === 'failed');
      check(
        failedTimeline.length === index + 1 &&
          failedTimeline[index].attempt === index + 1 &&
          failedTimeline[index].timestamp === failure.at &&
          failedTimeline[index].error === failure.error,
        `${id}: missing durable failure timeline`
      );
      totalFailures++;
    }
    const terminal = history.jobs.filter((job) => job.id === id);
    const tombstones = history.completions.filter((job) => job.id === id);
    check(
      terminal.length === 1 &&
        terminal[0].state === 'completed' &&
        terminal[0].attempt === calls.length - 1 &&
        terminal[0].result === result,
      `${id}: incorrect terminal job`
    );
    check(
      tombstones.length === 1 &&
        tombstones[0].result === result &&
        completed[0].result === result &&
        completed[0].attempt === calls.length - 1 &&
        pulls.at(-1)!.id < completed[0].id,
      `${id}: incorrect durable completion result or order`
    );
    check(
      terminal[0].timeline
        .filter(({ state }) => state !== 'waiting' && state !== 'delayed')
        .map(({ state }) => state)
        .join(',') ===
        [
          ...calls.flatMap((_, index) => (index ? ['failed', 'active'] : ['active'])),
          'completed',
        ].join(','),
      `${id}: unexpected terminal timeline`
    );
    const activeTimeline = terminal[0].timeline.filter(({ state }) => state === 'active');
    const failedTimeline = terminal[0].timeline.filter(({ state }) => state === 'failed');
    check(
      activeTimeline.every((entry, index) => entry.timestamp === pulls[index].at) &&
        failedTimeline.every(
          (entry, index) =>
            entry.timestamp === failures[index].at &&
            entry.attempt === index + 1 &&
            entry.error === failures[index].error
        ) &&
        terminal[0].timeline.at(-1)?.timestamp === completed[0].at,
      `${id}: terminal timeline does not match durable transitions`
    );
  }
  check(history.failures.length === totalFailures, 'Unmatched Worker failure');
}

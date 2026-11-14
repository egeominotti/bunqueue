import { expect, test } from 'bun:test';
import {
  assertPublicDeliveryHistory,
  type DeliveryHistory,
} from './support/postgres-public-delivery-oracle';

// Independent, explicit DTO history: no production encoder or collector builds the oracle's input.
function validRetry(): DeliveryHistory {
  return {
    invocations: [
      {
        id: 'job',
        token: 'first',
        attempt: 0,
        start: 1,
        end: 2,
        stage: 'progress',
        outcome: 'threw',
        error: 'Error: Internal server error',
      },
      {
        id: 'job',
        token: 'second',
        attempt: 1,
        start: 4,
        end: 5,
        stage: 'return',
        outcome: 'returned',
        result: 14,
      },
    ],
    failures: [{ id: 'job', token: 'first', at: 3, error: 'Error: Internal server error' }],
    unexpected: [],
    events: [
      {
        id: 10,
        jobId: 'job',
        type: 'pulled',
        at: 100,
        attempt: 0,
        timeline: [{ state: 'active', timestamp: 100 }],
      },
      { id: 11, jobId: 'job', type: 'retried', at: 110, attempt: 1, timeline: [] },
      {
        id: 12,
        jobId: 'job',
        type: 'failed',
        at: 110,
        attempt: 1,
        error: 'Internal server error',
        timeline: [],
      },
      {
        id: 13,
        jobId: 'job',
        type: 'pulled',
        at: 120,
        attempt: 1,
        timeline: [
          { state: 'active', timestamp: 100 },
          { state: 'failed', timestamp: 110, attempt: 1, error: 'Internal server error' },
          { state: 'delayed', timestamp: 110, attempt: 2 },
          { state: 'active', timestamp: 120 },
        ],
      },
      { id: 14, jobId: 'job', type: 'completed', at: 130, attempt: 1, result: 14, timeline: [] },
    ],
    jobs: [
      {
        id: 'job',
        state: 'completed',
        attempt: 1,
        result: 14,
        timeline: [
          { state: 'active', timestamp: 100 },
          { state: 'failed', timestamp: 110, attempt: 1, error: 'Internal server error' },
          { state: 'delayed', timestamp: 110, attempt: 2 },
          { state: 'active', timestamp: 120 },
          { state: 'completed', timestamp: 130 },
        ],
      },
    ],
    completions: [{ id: 'job', result: 14 }],
  };
}

const expected = new Map([['job', 14]]);

test('accepts only a fully evidenced pre-log Progress failure retry', () => {
  expect(() => assertPublicDeliveryHistory(validRetry(), expected)).not.toThrow();
});

test('requires one invocation when no failure occurred', () => {
  const healthy: DeliveryHistory = {
    invocations: [
      {
        id: 'job',
        token: 'only',
        attempt: 0,
        start: 1,
        end: 2,
        stage: 'return',
        outcome: 'returned',
        result: 14,
      },
    ],
    failures: [],
    unexpected: [],
    events: [
      { id: 10, jobId: 'job', type: 'pulled', at: 100, attempt: 0, timeline: [] },
      { id: 11, jobId: 'job', type: 'completed', at: 110, attempt: 0, result: 14, timeline: [] },
    ],
    jobs: [
      {
        id: 'job',
        state: 'completed',
        attempt: 0,
        result: 14,
        timeline: [
          { state: 'active', timestamp: 100 },
          { state: 'completed', timestamp: 110 },
        ],
      },
    ],
    completions: [{ id: 'job', result: 14 }],
  };
  assertPublicDeliveryHistory(healthy, expected);
  healthy.invocations.push({ ...healthy.invocations[0], token: 'unexplained', start: 3, end: 4 });
  expect(() => assertPublicDeliveryHistory(healthy, expected)).toThrow('invocation/pull mismatch');
});

const invalid: [string, (history: DeliveryHistory) => void, string][] = [
  [
    'same-token repeat',
    (h) => {
      h.invocations[1].token = 'first';
    },
    'repeated delivery token',
  ],
  [
    'empty token',
    (h) => {
      h.invocations[0].token = '';
    },
    'Missing or repeated delivery token',
  ],
  [
    'unexplained new-token delivery',
    (h) => {
      h.events = h.events.filter((e) => e.type !== 'failed' && e.type !== 'retried');
    },
    'missing durable failure',
  ],
  [
    'missing applied Worker failure',
    (h) => {
      h.failures = [];
    },
    'applied Worker failure',
  ],
  [
    'wrong Worker failure token',
    (h) => {
      h.failures[0].token = 'other';
    },
    'applied Worker failure',
  ],
  [
    'failure observed after next invocation',
    (h) => {
      h.failures[0].at = 6;
    },
    'applied Worker failure',
  ],
  [
    'skipped processor attempt',
    (h) => {
      h.invocations[1].attempt = 2;
    },
    'noncontiguous attempt',
  ],
  [
    'wrong durable attempt',
    (h) => {
      h.events[3].attempt = 0;
    },
    'noncontiguous attempt',
  ],
  [
    'overlapping processor invocations',
    (h) => {
      h.invocations[0].end = 5;
    },
    'overlapping processor invocations',
  ],
  [
    'durable failure after next pull',
    (h) => {
      h.events[2].id = 20;
    },
    'durable failure must precede next pull',
  ],
  [
    'missing failure timeline',
    (h) => {
      h.events[3].timeline = [];
    },
    'durable failure timeline',
  ],
  [
    'duplicate durable completion',
    (h) => {
      h.events.push({ ...h.events[4], id: 15 });
    },
    'duplicate or missing durable completion',
  ],
  [
    'error after logging begins',
    (h) => {
      h.invocations[0].stage = 'log';
    },
    'unexpected processor failure or stage',
  ],
  [
    'arbitrary processor error',
    (h) => {
      h.invocations[0].error = 'Error: unexpected';
    },
    'unexpected processor failure or stage',
  ],
  [
    'stalled recovery',
    (h) => {
      h.unexpected.push({ kind: 'stalled' });
    },
    'Unexpected Worker error',
  ],
  [
    'durable recovery',
    (h) => {
      h.events.splice(1, 0, { ...h.events[1], type: 'stalled' });
    },
    'unexpected durable transition',
  ],
  [
    'wrong terminal result',
    (h) => {
      h.jobs[0].result = 99;
    },
    'incorrect terminal job',
  ],
  [
    'wrong completion result',
    (h) => {
      h.completions[0].result = 99;
    },
    'incorrect durable completion result',
  ],
  [
    'missing terminal job',
    (h) => {
      h.jobs = [];
    },
    'Terminal job count mismatch',
  ],
];

for (const [name, corrupt, message] of invalid) {
  test(`rejects ${name}`, () => {
    const history = validRetry();
    corrupt(history);
    expect(() => assertPublicDeliveryHistory(history, expected)).toThrow(message);
  });
}

/**
 * SystemOne decision-model client: one wire format for TypeSafe Jev, Cloudflare Clef /
 * Clef-flash (Workers AI envelope) and self-hosted models (Kev 9B, Laya, ...).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { DecisionModel } from '../src/mcp/decisionModel';
import { fakeDecisionServer } from './mcp-harness';

const stops: Array<() => void> = [];
afterEach(() => {
  while (stops.length) stops.pop()?.();
});

function model(
  respond: Parameters<typeof fakeDecisionServer>[0],
  extra: { apiKey?: string; timeoutMs?: number; name?: string } = {}
) {
  const fake = fakeDecisionServer(respond);
  stops.push(fake.stop);
  const decision = new DecisionModel({
    provider: 'systemone',
    model: extra.name ?? 'clef-flash',
    url: fake.url,
    apiKey: extra.apiKey,
    timeoutMs: extra.timeoutMs ?? 2000,
  });
  return { fake, decision };
}

describe('DecisionModel', () => {
  test('sends the SystemOne body with bearer auth and reads choice answers', async () => {
    const { fake, decision } = model(
      () => ({
        answers: {
          pick: { type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 },
        },
      }),
      { apiKey: 'secret', name: 'kev-9b' }
    );
    const answer = await decision.choice('state text', 'Pick one', { a: 'first', b: 'second' });
    expect(answer).toEqual({ choice: 'b', probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 });
    expect(fake.calls[0].authorization).toBe('Bearer secret');
    expect(fake.calls[0].body).toEqual({
      model: 'kev-9b',
      state: 'state text',
      questions: {
        pick: { type: 'choice', instructions: 'Pick one', criteria: { a: 'first', b: 'second' } },
      },
    });
  });

  test('omits the Authorization header without a key', async () => {
    const { fake, decision } = model(() => ({ answers: { check: { type: 'noul', noul: 0.4 } } }));
    expect(await decision.noul({ a: 1 }, 'Is it?')).toBe(0.4);
    expect(fake.calls[0].authorization).toBeNull();
  });

  test('unwraps the Workers AI { result } envelope', async () => {
    const { decision } = model(() => ({
      success: true,
      result: { answers: { check: { type: 'noul', noul: 0.75 } } },
    }));
    expect(await decision.noul('s', 'q')).toBe(0.75);
  });

  test('retries once on 429 and succeeds', async () => {
    let n = 0;
    const { fake, decision } = model(() =>
      n++ === 0
        ? new Response('slow down', { status: 429 })
        : { answers: { check: { type: 'noul', noul: 1 } } }
    );
    expect(await decision.noul('s', 'q')).toBe(1);
    expect(fake.calls).toHaveLength(2);
  });

  test('does not retry a 401', async () => {
    const { fake, decision } = model(() => new Response('no', { status: 401 }));
    await expect(decision.noul('s', 'q')).rejects.toThrow('HTTP 401');
    expect(fake.calls).toHaveLength(1);
  });

  test('times out and reports the model unreachable after one retry', async () => {
    const { fake, decision } = model(
      async () => {
        await Bun.sleep(300);
        return { answers: { check: { type: 'noul', noul: 1 } } };
      },
      { timeoutMs: 50 }
    );
    await expect(decision.noul('s', 'q')).rejects.toThrow('unreachable');
    await Bun.sleep(350);
    expect(fake.calls).toHaveLength(2);
  });

  test('rejects malformed answers', async () => {
    const empty = model(() => ({ nothing: true }));
    await expect(empty.decision.noul('s', 'q')).rejects.toThrow('no answers');
    const badChoice = model(() => ({
      answers: { pick: { type: 'choice', choice: 'z', probabilities: {} } },
    }));
    await expect(badChoice.decision.choice('s', 'q', { a: 'A' })).rejects.toThrow('invalid choice');
    const badNoul = model(() => ({ answers: { check: { type: 'noul', noul: 'yes' } } }));
    await expect(badNoul.decision.noul('s', 'q')).rejects.toThrow('invalid noul');
  });
});

/**
 * Optional decision-model client for the MCP server (SystemOne wire format).
 *
 * One request shape serves every supported model: `POST { model, state, questions }`
 * returning `{ answers: { <id>: { choice, probabilities, confidence } | { noul } } }`.
 * - typesafe:   TypeSafe Jev (`jev-latest`, `jev-1.13.0`) at api.typesafe.ai
 * - cloudflare: Clef / Clef-flash on Workers AI (`@cf/cloudflare/<model>`)
 * - systemone:  any compatible endpoint, e.g. self-hosted Clef, Clef-flash,
 *               Kev 9B, Laya or DiffusionGemma Jev
 *
 * Disabled unless BUNQUEUE_MCP_DECISION_PROVIDER is set. Nothing here runs on the
 * queue's job path; only the MCP tools that opt into it make requests.
 */

export type DecisionProvider = 'typesafe' | 'cloudflare' | 'systemone';

export interface DecisionConfig {
  provider: DecisionProvider;
  model: string;
  url: string;
  apiKey?: string;
  timeoutMs: number;
}

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}

const DEFAULT_MODEL: Record<DecisionProvider, string | undefined> = {
  typesafe: 'jev-latest',
  cloudflare: 'clef-flash',
  systemone: undefined,
};

/** Read the opt-in configuration; null when no provider is configured. */
export function decisionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionConfig | null {
  const raw = env.BUNQUEUE_MCP_DECISION_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw !== 'typesafe' && raw !== 'cloudflare' && raw !== 'systemone') {
    throw new Error(
      `BUNQUEUE_MCP_DECISION_PROVIDER must be typesafe, cloudflare or systemone (got "${raw}")`
    );
  }
  const provider: DecisionProvider = raw;
  const model = env.BUNQUEUE_MCP_DECISION_MODEL?.trim() || DEFAULT_MODEL[provider];
  if (!model) throw new Error('BUNQUEUE_MCP_DECISION_MODEL is required for the systemone provider');
  const apiKey = env.BUNQUEUE_MCP_DECISION_API_KEY?.trim() || undefined;
  const timeoutMs = Number(env.BUNQUEUE_MCP_DECISION_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('BUNQUEUE_MCP_DECISION_TIMEOUT_MS must be a positive number');
  }
  let url = env.BUNQUEUE_MCP_DECISION_URL?.trim();
  if (!url && provider === 'typesafe') url = 'https://api.typesafe.ai/v1/systemone';
  if (!url && provider === 'cloudflare') {
    const account = env.BUNQUEUE_MCP_DECISION_ACCOUNT_ID?.trim();
    if (!account)
      throw new Error('BUNQUEUE_MCP_DECISION_ACCOUNT_ID is required for the cloudflare provider');
    url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`;
  }
  if (!url) throw new Error('BUNQUEUE_MCP_DECISION_URL is required for the systemone provider');
  if (provider !== 'systemone' && !apiKey) {
    throw new Error(`BUNQUEUE_MCP_DECISION_API_KEY is required for the ${provider} provider`);
  }
  return { provider, model, url, apiKey, timeoutMs };
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export class DecisionModel {
  constructor(readonly config: DecisionConfig) {}

  /** Ask the model; answers are keyed by question id. Throws on transport or format errors. */
  async ask(state: unknown, questions: Record<string, Question>): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ model: this.config.model, state, questions });
    let lastError = new Error('decision model request failed');
    // One retry for network errors, timeouts, rate limits and overload; nothing else is retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await Bun.sleep(400);
      let response: Response;
      try {
        response = await fetch(this.config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
      } catch (err) {
        lastError = new Error(
          `decision model unreachable: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (!response.ok) {
        lastError = new Error(`decision model HTTP ${response.status}`);
        if (RETRYABLE.has(response.status)) continue;
        throw lastError;
      }
      const json = (await response.json().catch(() => null)) as {
        answers?: unknown;
        result?: { answers?: unknown };
      } | null;
      // Workers AI wraps the SystemOne body in its { result, success } envelope.
      const answers = json?.answers ?? json?.result?.answers;
      if (!answers || typeof answers !== 'object')
        throw new Error('decision model returned no answers');
      return answers as Record<string, unknown>;
    }
    throw lastError;
  }

  async choice(
    state: unknown,
    instructions: string,
    criteria: Record<string, string>
  ): Promise<ChoiceAnswer> {
    const answers = await this.ask(state, { pick: { type: 'choice', instructions, criteria } });
    const pick = answers.pick as Partial<ChoiceAnswer> | undefined;
    if (!pick || typeof pick.choice !== 'string' || !(pick.choice in criteria)) {
      throw new Error('decision model returned an invalid choice');
    }
    return {
      choice: pick.choice,
      probabilities: pick.probabilities ?? {},
      confidence: pick.confidence,
    };
  }

  /** Probability (0..1) that the statement is true for the given state. */
  async noul(state: unknown, instructions: string): Promise<number> {
    const answers = await this.ask(state, { check: { type: 'noul', instructions } });
    const value = (answers.check as { noul?: unknown } | undefined)?.noul;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('decision model returned an invalid noul answer');
    }
    return value;
  }
}

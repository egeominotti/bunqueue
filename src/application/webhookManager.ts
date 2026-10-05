/**
 * Webhook Manager
 * Manages webhooks and sends HTTP callbacks
 */

import {
  type Webhook,
  type WebhookId,
  type WebhookEvent,
  type WebhookPayload,
  createWebhook,
} from '../domain/types/webhook';
import { validateWebhookUrl } from '../shared/webhookValidation';
import { webhookLog } from '../shared/logger';
import { readWebhookDelivery, type WebhookDelivery } from '../config/componentEnv';
import { assertWhole } from '../config/numbers';
import { SETTINGS } from '../config/settings';

export type { WebhookDelivery } from '../config/componentEnv';

/** HMAC-SHA256 signature using Bun native CryptoHasher (2-3x faster than WebCrypto) */
function signPayload(payload: string, secret: string): string {
  const hasher = new Bun.CryptoHasher('sha256', secret);
  hasher.update(payload);
  return hasher.digest('hex');
}

/**
 * Webhook Manager
 */
export class WebhookManager {
  private readonly webhooks = new Map<WebhookId, Webhook>();
  /** Retry policy: WEBHOOK_MAX_RETRIES / WEBHOOK_RETRY_DELAY_MS, or the server's config. */
  private delivery: WebhookDelivery;
  private readonly validateUrls: boolean;
  private dashboardEmit: ((event: string, data: Record<string, unknown>) => void) | null = null;

  /** Running counter for enabled webhooks - avoids O(n) filter in getStats */
  private enabledCount = 0;

  /**
   * Reads WEBHOOK_MAX_RETRIES and WEBHOOK_RETRY_DELAY_MS now (not at module load) and
   * throws an error naming the variable when one is invalid: a NaN delay would make
   * `Bun.sleep` resolve at once and burst every retry.
   */
  constructor(options?: { validateUrls?: boolean }) {
    this.validateUrls = options?.validateUrls !== false;
    this.delivery = readWebhookDelivery();
  }

  /** Replace the retry policy (the server applies `webhooks.*` from its config file). */
  setDeliveryPolicy(policy: WebhookDelivery): void {
    this.delivery = {
      maxRetries: assertWhole(
        policy.maxRetries,
        'WebhookManager: maxRetries',
        SETTINGS.webhookMaxRetries.rule
      ),
      retryDelayMs: assertWhole(
        policy.retryDelayMs,
        'WebhookManager: retryDelayMs',
        SETTINGS.webhookRetryDelayMs.rule
      ),
    };
  }

  /** The retry policy in effect. */
  getDeliveryPolicy(): WebhookDelivery {
    return this.delivery;
  }

  /** Set the dashboard event emitter callback */
  setDashboardEmit(callback: (event: string, data: Record<string, unknown>) => void): void {
    this.dashboardEmit = callback;
  }

  /** Add a webhook (validates URL to prevent SSRF) */
  add(url: string, events: string[], queue?: string, secret?: string): Webhook {
    if (this.validateUrls) {
      const urlError = validateWebhookUrl(url);
      if (urlError) {
        throw new Error(urlError);
      }
    }

    const webhook = createWebhook(url, events, queue, secret);
    this.webhooks.set(webhook.id, webhook);
    if (webhook.enabled) {
      this.enabledCount++;
    }
    return webhook;
  }

  /** Remove a webhook */
  remove(id: WebhookId): boolean {
    const webhook = this.webhooks.get(id);
    if (webhook?.enabled) {
      this.enabledCount--;
    }
    return this.webhooks.delete(id);
  }

  /** Get webhook by ID */
  get(id: WebhookId): Webhook | undefined {
    return this.webhooks.get(id);
  }

  /** Set webhook enabled state - properly maintains running counter */
  setEnabled(id: WebhookId, enabled: boolean): boolean {
    const webhook = this.webhooks.get(id);
    if (!webhook) return false;

    if (webhook.enabled !== enabled) {
      webhook.enabled = enabled;
      this.enabledCount += enabled ? 1 : -1;
      this.dashboardEmit?.(enabled ? 'webhook:enabled' : 'webhook:disabled', { webhookId: id });
    }
    return true;
  }

  /** List all webhooks */
  list(): Webhook[] {
    return Array.from(this.webhooks.values());
  }

  /** Trigger webhooks for an event */
  async trigger(
    event: WebhookEvent,
    jobId: string,
    queue: string,
    extra?: { data?: unknown; error?: string; progress?: number }
  ): Promise<void> {
    const payload: WebhookPayload = {
      event,
      timestamp: Date.now(),
      jobId,
      queue,
      ...extra,
    };

    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      (wh) => wh.enabled && wh.events.includes(event) && (wh.queue === null || wh.queue === queue)
    );

    // Fire and forget - don't block
    for (const webhook of matchingWebhooks) {
      this.sendWebhook(webhook, payload).catch((err: unknown) => {
        webhookLog.error('Failed to send webhook', { url: webhook.url, error: String(err) });
      });
    }
  }

  /** Send webhook with retries */
  private async sendWebhook(webhook: Webhook, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Event': payload.event,
      'X-Webhook-Timestamp': String(payload.timestamp),
    };

    // Add signature if secret is set
    if (webhook.secret) {
      headers['X-Webhook-Signature'] = signPayload(body, webhook.secret);
    }

    // One policy per delivery, even if the policy is replaced meanwhile.
    const { maxRetries, retryDelayMs } = this.delivery;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          webhook.lastTriggered = Date.now();
          webhook.successCount++;
          this.dashboardEmit?.('webhook:fired', {
            webhookId: webhook.id,
            url: webhook.url,
            event: payload.event,
          });
          return;
        }

        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      // Wait before retry (linear backoff). The delay is a validated whole number of
      // ms; Bun.sleep honours delays above the native timer limit.
      if (attempt < maxRetries - 1) {
        await Bun.sleep(retryDelayMs * (attempt + 1));
      }
    }

    webhook.failureCount++;
    this.dashboardEmit?.('webhook:failed', {
      webhookId: webhook.id,
      url: webhook.url,
      event: payload.event,
      error: lastError?.message ?? 'Webhook delivery failed after max retries',
    });
    throw lastError ?? new Error('Webhook delivery failed after max retries');
  }

  /** Check if there are any enabled webhooks - O(1) */
  hasEnabledWebhooks(): boolean {
    return this.enabledCount > 0;
  }

  /** Get stats - O(1) using running counter */
  getStats() {
    return {
      total: this.webhooks.size,
      enabled: this.enabledCount,
    };
  }
}

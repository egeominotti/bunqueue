import type { CronJobInput } from '../../../domain/types/cron';
import type { SerializedCron, WebhookInfo, WorkerInfo } from '../../types/adapter';
import { serializeMcpCron } from '../serializers';
import { TcpMonitoringBackend } from './monitoring';
import { numberField, replyData } from './wire';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Validates the broker's cron reply and serializes it exactly like the embedded backend.
 * Fields an older broker may omit fall back to the engine defaults; a wrong type throws.
 */
function serializeTcpCron(value: unknown): SerializedCron {
  if (!value || typeof value !== 'object') throw new Error('Invalid cron response from broker');
  const cron = value as Record<string, unknown>;
  const { schedule, repeatEvery, jobName, priority, timezone, maxLimit } = cron;
  if (
    typeof cron.name !== 'string' ||
    typeof cron.queue !== 'string' ||
    !isFiniteNumber(cron.nextRun) ||
    Number.isNaN(new Date(cron.nextRun).getTime()) ||
    (schedule != null && typeof schedule !== 'string') ||
    (repeatEvery != null && !isFiniteNumber(repeatEvery)) ||
    (jobName != null && typeof jobName !== 'string') ||
    (priority != null && !isFiniteNumber(priority)) ||
    (timezone != null && typeof timezone !== 'string') ||
    (maxLimit != null && !isFiniteNumber(maxLimit))
  ) {
    throw new Error('Invalid cron response from broker');
  }
  return serializeMcpCron({
    name: cron.name,
    queue: cron.queue,
    schedule: schedule ?? null,
    repeatEvery: repeatEvery ?? null,
    nextRun: cron.nextRun,
    executions: isFiniteNumber(cron.executions) ? cron.executions : 0,
    jobName: jobName ?? 'default',
    priority: priority ?? 0,
    timezone: timezone ?? null,
    maxLimit: maxLimit ?? null,
  });
}

function serializeTcpWebhook(webhook: Record<string, unknown>): WebhookInfo {
  return {
    id: String(webhook.id),
    url: webhook.url as string,
    events: (webhook.events as string[]) ?? [],
    queue: (webhook.queue as string | null | undefined) ?? undefined,
    enabled: (webhook.enabled as boolean) ?? true,
  };
}

function serializeTcpWorker(worker: Record<string, unknown>, id: unknown): WorkerInfo {
  return {
    id: String(id),
    name: worker.name as string,
    queues: (worker.queues as string[]) ?? [],
    active: numberField(worker, 'activeJobs'),
    processed: numberField(worker, 'processedJobs'),
    failed: numberField(worker, 'failedJobs'),
    lastHeartbeat: numberField(worker, 'lastSeen'),
  };
}

/** Crons, webhooks and workers over TCP. */
export class TcpServiceBackend extends TcpMonitoringBackend {
  async addCron(input: CronJobInput): Promise<SerializedCron> {
    const response = await this.send({
      cmd: 'Cron',
      ...input,
      jobName: input.jobName ?? 'default',
    });
    return serializeTcpCron(response.cron);
  }

  async listCrons(): Promise<SerializedCron[]> {
    const response = await this.send({ cmd: 'CronList' });
    return ((response.crons as unknown[]) ?? []).map(serializeTcpCron);
  }

  /** null when no cron has this name (the broker replies "Cron job not found"). */
  async getCron(name: string): Promise<SerializedCron | null> {
    const response = await this.sendLookup({ cmd: 'CronGet', name });
    return response ? serializeTcpCron(response.cron) : null;
  }

  deleteCron(name: string) {
    return this.sendFlag({ cmd: 'CronDelete', name });
  }

  async addWebhook(url: string, events: string[], queue?: string): Promise<WebhookInfo> {
    const data = replyData(await this.send({ cmd: 'AddWebhook', url, events, queue }));
    const id = data.webhookId;
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new Error('Invalid AddWebhook response from broker: missing webhookId');
    }
    return serializeTcpWebhook({ url, events, queue, ...data, id, enabled: true });
  }

  removeWebhook(id: string) {
    return this.sendFlag({ cmd: 'RemoveWebhook', webhookId: id });
  }

  async listWebhooks(): Promise<WebhookInfo[]> {
    const webhooks = replyData(await this.send({ cmd: 'ListWebhooks' })).webhooks;
    return Array.isArray(webhooks)
      ? (webhooks as Array<Record<string, unknown>>).map(serializeTcpWebhook)
      : [];
  }

  setWebhookEnabled(id: string, enabled: boolean) {
    return this.sendFlag({ cmd: 'SetWebhookEnabled', id, enabled });
  }

  async registerWorker(name: string, queues: string[]): Promise<WorkerInfo> {
    const data = replyData(await this.send({ cmd: 'RegisterWorker', name, queues }));
    const id = data.workerId;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Invalid RegisterWorker response from broker: missing workerId');
    }
    return serializeTcpWorker({ name, queues, ...data }, id);
  }

  unregisterWorker(id: string) {
    return this.sendFlag({ cmd: 'UnregisterWorker', workerId: id });
  }

  workerHeartbeat(id: string) {
    return this.sendFlag({ cmd: 'Heartbeat', id });
  }

  async listWorkers(): Promise<WorkerInfo[]> {
    const workers = replyData(await this.send({ cmd: 'ListWorkers' })).workers;
    return Array.isArray(workers)
      ? (workers as Array<Record<string, unknown>>).map((worker) =>
          serializeTcpWorker(worker, worker.id)
        )
      : [];
  }
}

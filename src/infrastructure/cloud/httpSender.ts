/**
 * HTTP Sender
 * Posts snapshots to the remote dashboard via HTTP with retry and HMAC signing
 * Uses msgpack + zstd encoding (same as WebSocket channel)
 */

import { encodeMessagePack } from '../../shared/msgpack';
import type { CloudConfig, CloudSnapshot } from './types';
import { CircuitBreaker } from './circuitBreaker';
import { SnapshotBuffer } from './buffer';
import { cloudLog } from './logger';

export class HttpSender {
  private readonly circuitBreaker: CircuitBreaker;
  private readonly buffer: SnapshotBuffer;
  private readonly ingestUrl: string;
  private hmacKey: CryptoKey | null = null;
  lastCompressedKB = 0;

  constructor(private readonly config: CloudConfig) {
    this.circuitBreaker = new CircuitBreaker(
      config.circuitBreakerThreshold,
      config.circuitBreakerResetMs
    );
    this.buffer = new SnapshotBuffer(config.bufferSize);
    this.ingestUrl = `${config.url}/api/v1/ingest`;
  }

  /** Send a snapshot. Buffers on failure. */
  async send(snapshot: CloudSnapshot): Promise<void> {
    // Flush buffered snapshots first if any
    if (!this.buffer.isEmpty) {
      await this.flushBuffer();
    }

    if (!this.circuitBreaker.canExecute()) {
      this.buffer.push(snapshot);
      return;
    }

    try {
      await this.post(this.ingestUrl, snapshot);
      this.circuitBreaker.onSuccess();
    } catch (err) {
      this.circuitBreaker.onFailure();
      this.buffer.push(snapshot);
      cloudLog.debug('Snapshot buffered', {
        buffered: this.buffer.size,
        circuit: this.circuitBreaker.getState(),
        error: String(err),
      });
    }
  }

  /** Try to send buffered snapshots one by one */
  private async flushBuffer(): Promise<void> {
    if (!this.circuitBreaker.canExecute()) return;

    while (!this.buffer.isEmpty) {
      const drained = this.buffer.drain(1);
      if (drained.length === 0) break;
      const snapshot = drained[0];

      try {
        await this.post(this.ingestUrl, snapshot);
        this.circuitBreaker.onSuccess();
        cloudLog.debug('Buffer flushed', { remaining: this.buffer.size });
      } catch {
        this.buffer.push(snapshot);
        this.circuitBreaker.onFailure();
        break;
      }
    }
  }

  /** HTTP POST with auth headers and optional HMAC — sends zstd(msgpack) */
  private async post(url: string, body: unknown): Promise<void> {
    const tPack = performance.now();
    const msgpackBuf = encodeMessagePack(body);
    const packMs = Math.round((performance.now() - tPack) * 100) / 100;
    const tZstd = performance.now();
    const compressed = new Uint8Array(await Bun.zstdCompress(msgpackBuf, { level: 6 }));
    this.lastCompressedKB = Math.round(compressed.byteLength / 1024);
    const zstdMs = Math.round((performance.now() - tZstd) * 100) / 100;
    cloudLog.info('Snapshot size', {
      rawKB: Math.round(msgpackBuf.byteLength / 1024),
      compressedKB: Math.round(compressed.byteLength / 1024),
      ratio: `${Math.round((1 - compressed.byteLength / msgpackBuf.byteLength) * 100)}%`,
      packMs,
      zstdMs,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-msgpack',
      'Content-Encoding': 'zstd',
      Authorization: `Bearer ${this.config.apiKey}`,
      'X-Timestamp': String(Date.now()),
    };

    if (this.config.signingSecret) {
      this.hmacKey ??= await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.config.signingSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', this.hmacKey, compressed);
      headers['X-Signature'] = Buffer.from(sig).toString('hex');
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: compressed,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = `HTTP ${res.status}: ${text.slice(0, 200)}`;

      // Auth/plan errors should be visible to the user, not silently buffered
      if (res.status === 401 || res.status === 403) {
        cloudLog.error('Cloud rejected connection', {
          status: res.status,
          response: text.slice(0, 200),
        });
      }

      throw new Error(msg);
    }
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  getCircuitState(): string {
    return this.circuitBreaker.getState();
  }
}

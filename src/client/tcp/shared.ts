/**
 * Shared TCP Client Instances
 * One shared client per distinct set of connection options (`getConnectionKey`), so
 * callers with different targets, credentials, TLS, timeouts or reconnect settings
 * never receive each other's connection.
 */

import type { ConnectionOptions } from './types';
import { TcpClient } from './client';
import { getConnectionKey } from './poolKey';

/** Shared clients keyed by `getConnectionKey` */
const sharedClients = new Map<string, TcpClient>();

/** Get shared TCP client for the given connection target */
export function getSharedTcpClient(options?: Partial<ConnectionOptions>): TcpClient {
  // Validates first, and covers every option: a caller only ever receives a client
  // built from options equal to its own.
  const key = getConnectionKey('TcpClient', options);
  let client = sharedClients.get(key);
  if (!client) {
    client = new TcpClient(options);
    sharedClients.set(key, client);
  }
  return client;
}

/** Close all shared clients */
export function closeSharedTcpClient(): void {
  for (const client of sharedClients.values()) {
    client.close();
  }
  sharedClients.clear();
}

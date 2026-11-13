/**
 * REPRO — issue #189 follow-up: what a TLS reload restores on the HTTP unix socket
 * file when a `chown` or `chmod` of the rebound path fails.
 *
 * Run: bun test test/repro-issue-189-unix-socket-restore.test.ts
 *
 * The listener takes its file-system calls from an injected object, so these paths run
 * without root: the fake reports an operator's `chgrp` on the socket file served now
 * and makes `chownSync` or `chmodSync` fail with a chosen error code. Contract:
 * - the bind of the NEW pair is strict: a restore failure other than an `EPERM` owner
 *   change is a failed bind, and the reload rolls back (`outcome: 'kept-previous'`);
 * - the ROLLBACK rebind of the previous pair is best-effort: a failing `chown` (any
 *   code) keeps the owner with a warning and the previous mode is still applied; a
 *   failing `chmod` logs a warning and the previous listener stays up;
 * - an `EPERM` owner change on the new pair keeps the created owner with a warning.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHttpListener,
  type HttpListener,
  type SocketFileSystem,
} from '../src/infrastructure/server/httpListener';
import { reloadServerTls } from '../src/infrastructure/server/tlsReload';
import { serverLog } from '../src/shared/logger';
import { installPair, makeCertSet, servedFingerprint, type CertSet } from './tls-reload-support';

const OWNER_WARNING = 'HTTP unix socket owner not restored after a TLS reload';
const ROLLBACK_WARNING = 'HTTP unix socket permissions not restored after a TLS reload rollback';

interface FakeSocketFs extends SocketFileSystem {
  /** The next stat reports this gid: an operator's `chgrp` on the file served now. */
  operatorGid: number | null;
  chownError: string | null;
  chmodError: string | null;
  calls: string[];
}

function injected(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

function fakeSocketFs(): FakeSocketFs {
  const fs: FakeSocketFs = {
    operatorGid: null,
    chownError: null,
    chmodError: null,
    calls: [],
    statSync(path) {
      const real = statSync(path);
      // One shot: only the file served before the reload carries the operator's group.
      const gid = fs.operatorGid ?? real.gid;
      fs.operatorGid = null;
      return { mode: real.mode, uid: real.uid, gid };
    },
    chownSync(_path, uid, gid) {
      fs.calls.push(`chown ${uid}:${gid}`);
      if (fs.chownError) throw injected(fs.chownError);
      // A real chown to a group the process is not in would need root; nothing to do.
    },
    chmodSync(path, mode) {
      fs.calls.push(`chmod ${mode.toString(8)}`);
      if (fs.chmodError) throw injected(fs.chmodError);
      chmodSync(path, mode);
    },
  };
  return fs;
}

let set: CertSet | undefined;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // already stopped by the test
    }
  }
  set?.cleanup();
  set = undefined;
});

function tls(certSet: CertSet) {
  return { certFile: certSet.live.cert, keyFile: certSet.live.key };
}

/** A TLS listener on a fresh unix socket path that an operator then set to mode 660. */
function unixListener(certSet: CertSet, fs: FakeSocketFs) {
  const dir = mkdtempSync(join(tmpdir(), 'bq-sock-restore-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, 'http.sock');
  const listener: HttpListener = createHttpListener(
    { socketPath, tls: tls(certSet) },
    { fetch: async () => new Response('ok'), websocket: { message() {} } },
    fs
  );
  cleanups.push(() => listener.stop());
  const created = statSync(socketPath);
  // The mode under test must differ from the one a new socket file is created with.
  expect(created.mode & 0o777).not.toBe(0o660);
  chmodSync(socketPath, 0o660);
  return { listener, socketPath, created };
}

function captureWarnings() {
  const warn = spyOn(serverLog, 'warn').mockImplementation(() => undefined);
  cleanups.push(() => warn.mockRestore());
  return warn;
}

describe('issue #189: unix socket attributes after a TLS reload', () => {
  test('a rollback after a failed chown still restores the previous mode', async () => {
    set = makeCertSet();
    const fs = fakeSocketFs();
    const { listener, socketPath, created } = unixListener(set, fs);
    expect(await servedFingerprint(socketPath)).toBe(set.a.fingerprint);
    const warn = captureWarnings();
    const operatorGid = created.gid + 1;
    fs.operatorGid = operatorGid;
    fs.chownError = 'EIO';

    installPair(set, set.b.cert, set.b.key);
    const result = reloadServerTls([listener], tls(set));
    // The new pair's restore is strict: EIO is a failed bind, so the reload rolls back.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe('kept-previous');
      expect(result.error).toContain('EIO: injected');
    }
    expect(await servedFingerprint(socketPath)).toBe(set.a.fingerprint);
    // The rollback is best-effort: the owner is kept, the operator's mode comes back.
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(fs.calls).toEqual([
      `chown ${created.uid}:${operatorGid}`,
      `chown ${created.uid}:${operatorGid}`,
      'chmod 660',
    ]);
    expect(warn.mock.calls).toEqual([
      [
        OWNER_WARNING,
        {
          path: socketPath,
          uid: created.uid,
          gid: operatorGid,
          keptUid: created.uid,
          keptGid: created.gid,
          error: 'EIO: injected',
        },
      ],
    ]);
  });

  test('EPERM on the owner of the new pair keeps the created owner with a warning', async () => {
    set = makeCertSet();
    const fs = fakeSocketFs();
    const { listener, socketPath, created } = unixListener(set, fs);
    const warn = captureWarnings();
    const operatorGid = created.gid + 1;
    fs.operatorGid = operatorGid;
    fs.chownError = 'EPERM';

    installPair(set, set.b.cert, set.b.key);
    expect(reloadServerTls([listener], tls(set)).ok).toBe(true);
    expect(await servedFingerprint(socketPath)).toBe(set.b.fingerprint);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(fs.calls).toEqual([`chown ${created.uid}:${operatorGid}`, 'chmod 660']);
    expect(warn.mock.calls).toEqual([
      [
        OWNER_WARNING,
        {
          path: socketPath,
          uid: created.uid,
          gid: operatorGid,
          keptUid: created.uid,
          keptGid: created.gid,
          error: 'EPERM: injected',
        },
      ],
    ]);
  });

  test('a rollback whose chmod fails keeps serving the previous pair with a warning', async () => {
    set = makeCertSet();
    const fs = fakeSocketFs();
    const { listener, socketPath } = unixListener(set, fs);
    const warn = captureWarnings();
    fs.chmodError = 'EIO';

    installPair(set, set.b.cert, set.b.key);
    const result = reloadServerTls([listener], tls(set));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outcome).toBe('kept-previous');
      expect(result.error).toContain('EIO: injected');
    }
    expect(await servedFingerprint(socketPath)).toBe(set.a.fingerprint);
    expect(fs.calls).toEqual(['chmod 660', 'chmod 660']);
    expect(warn.mock.calls).toEqual([
      [ROLLBACK_WARNING, { path: socketPath, mode: '660', error: 'EIO: injected' }],
    ]);
  });
});

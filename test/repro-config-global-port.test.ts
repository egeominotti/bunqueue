/**
 * Repro: the global `-p` / `--port` option and its env fallback warned and continued.
 *
 * `--port abc`, `--port 99999`, `--port=` or a trailing `--port` printed a warning and
 * connected to 6789, which may be a different server than the one the user meant.
 * `--port 1e4` was read as 1 (`parseInt`). `TCP_PORT=abc` / `BUNQUEUE_TCP_PORT=0` on
 * a client command warned and used 6789 too. On `start`, a bad `-p` was dropped and the
 * server bound its default port.
 *
 * Every invalid flag value must now throw a ConfigError naming the flag (as typed).
 * Client commands accept 1-65535; on `start`, `-p` follows `--tcp-port` (0-65535, 0 =
 * OS-assigned) and is forwarded to it; there, a value that is not a port is dropped with a
 * warning, as in 2.9.10 (a misread is still an error). Two 2.9.10 behaviors stay for compatibility
 * (test/repro-compat-config-cli.test.ts): `--port=` (empty) means "not given", and an
 * env port that is not a port warns and uses 6789 (Kubernetes injects
 * `BUNQUEUE_TCP_PORT=tcp://...` for a Service named `bunqueue-tcp`).
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { parseGlobalOptions } from '../src/cli/globalOptions';
import { ConfigError } from '../src/config';
import { outcome, withEnv } from './config-test-support';

const env = withEnv();
afterEach(() => env.restore());

const CLEAR = { TCP_PORT: undefined, BUNQUEUE_TCP_PORT: undefined, BQ_TCP_PORT: undefined };

function parse(args: string[], vars: Record<string, string | undefined> = {}) {
  env.set({ ...CLEAR, ...vars });
  return outcome(() => parseGlobalOptions(args));
}

const CLIENT = '(expected a whole number between 1 and 65535)';
const SERVER = '(expected a whole number between 0 and 65535)';

describe('client commands', () => {
  test.each([
    [['--port', 'abc', 'stats'], `Invalid --port: "abc" ${CLIENT}`],
    [['-p', 'abc', 'stats'], `Invalid -p: "abc" ${CLIENT}`],
    [['--port', '99999', 'stats'], `Invalid --port: "99999" ${CLIENT}`],
    [['--port', '1e4', 'stats'], `Invalid --port: "1e4" ${CLIENT}`],
    [['--port', '0', 'stats'], `Invalid --port: "0" ${CLIENT}`],
    [['--port', '-1', 'stats'], `Invalid --port: "-1" ${CLIENT}`],
    [['--port=notanumber', 'stats'], `Invalid --port: "notanumber" ${CLIENT}`],
    [['stats', '--port'], `Invalid --port: missing value ${CLIENT}`],
    [['stats', '-p', '--json'], `Invalid -p: missing value ${CLIENT}`],
  ])('%j is rejected', (args, message) => {
    expect(parse(args)).toEqual({ error: message });
  });

  test('the error is a ConfigError (one clean line at the entry points)', () => {
    env.set(CLEAR);
    expect(() => parseGlobalOptions(['--port', 'abc', 'stats'])).toThrow(ConfigError);
  });

  test.each([
    ['TCP_PORT', 'abc'],
    ['BUNQUEUE_TCP_PORT', '0'],
    ['BQ_TCP_PORT', '70000'],
  ])('%s=%p warns and uses 6789 when it supplies the port', (name, raw) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parse(['stats'], { [name]: raw })).toMatchObject({
        value: { options: { port: 6789 } },
      });
      expect(warn.mock.calls.map(String)).toEqual([expect.stringContaining(`"${raw}" (${name}`)]);
    } finally {
      warn.mockRestore();
    }
  });

  test('valid values', () => {
    expect(parse(['--port', '7000', 'stats'])).toMatchObject({
      value: { options: { port: 7000 } },
    });
    expect(parse(['--port=7001', 'stats'])).toMatchObject({ value: { options: { port: 7001 } } });
    expect(parse(['stats'], { BUNQUEUE_TCP_PORT: ' 7002 ' })).toMatchObject({
      value: { options: { port: 7002 } },
    });
    // An explicit flag wins; the unused env value is not read.
    expect(parse(['-p', '7003', 'stats'], { TCP_PORT: 'abc' })).toMatchObject({
      value: { options: { port: 7003 } },
    });
    expect(parse(['stats'])).toMatchObject({ value: { options: { port: 6789 } } });
  });
});

describe('server mode (start, bare, flag-led)', () => {
  test('a misread value is rejected', () => {
    expect(parse(['--port', '1e4'])).toEqual({ error: `Invalid --port: "1e4" ${SERVER}` });
  });

  test.each([
    [['start', '-p', 'abc'], '-p "abc"'],
    [['start', '--port=70000'], '--port "70000"'],
  ])('%j is dropped with a warning, as 2.9.10 did (the server port applies)', (args, shown) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parse(args)).toMatchObject({ value: { commandArgs: ['start'] } });
      expect(warn.mock.calls.map(String)).toEqual([expect.stringContaining(shown)]);
    } finally {
      warn.mockRestore();
    }
  });

  test('-p 0 is forwarded as --tcp-port 0 (OS-assigned), like --tcp-port itself', () => {
    expect(parse(['start', '-p', '0'])).toMatchObject({
      value: { commandArgs: ['start', '--tcp-port', '0'] },
    });
  });

  test('TCP_PORT is the server port here: the server validates it, not the client parser', () => {
    expect(parse(['start'], { TCP_PORT: '0' })).toMatchObject({
      value: { commandArgs: ['start'] },
    });
  });
});

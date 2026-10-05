import { describe, expect, test } from 'bun:test';
import {
  assertDuration,
  assertInteger,
  describeValue,
  parseDurationEnv,
  parseIntegerEnv,
} from '../src/shared/durations';

// src/shared/durations.ts: boundary validation for public duration options
// (assertDuration), counts and limits (assertInteger) and server env vars
// (parseDurationEnv).

const NAME = 'Worker: heartbeatInterval';

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a throw');
}

describe('assertDuration', () => {
  test.each([0, 1, 1.5, 30_000, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE])(
    'returns %p unchanged',
    (value) => {
      expect(assertDuration(value, NAME)).toBe(value);
    }
  );

  test('the message names the option, the expectation and the received value', () => {
    const error = thrown(() => assertDuration(NaN, NAME));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe(
      'Worker: heartbeatInterval must be a finite number of milliseconds >= 0 (got NaN)'
    );
  });

  test.each([
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
    [-1, '-1'],
    [-0.5, '-0.5'],
  ])('rejects %p with a RangeError', (value, shown) => {
    const error = thrown(() => assertDuration(value, NAME));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toEndWith(`(got ${shown})`);
  });

  test.each([
    ['100', '"100"'],
    [undefined, 'undefined'],
    [null, 'null'],
    [true, 'true'],
    [10n, '10n'],
    [{}, 'an object'],
    [[1], 'an array'],
    [() => 1, 'a function'],
  ])('rejects the non-number %p with a TypeError', (value, shown) => {
    const error = thrown(() => assertDuration(value, NAME));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(
      `${NAME} must be a finite number of milliseconds >= 0 (got ${shown})`
    );
  });

  test('-0 is accepted as 0 and shown as -0 when it is out of range', () => {
    expect(assertDuration(-0, NAME)).toBe(-0);
    expect(thrown(() => assertDuration(-0, NAME, { min: 1 })).message).toEndWith('(got -0)');
  });

  test('min and max are inclusive and named in the message', () => {
    const opts = { min: 1, max: 30_000 };
    expect(assertDuration(1, NAME, opts)).toBe(1);
    expect(assertDuration(30_000, NAME, opts)).toBe(30_000);
    expect(thrown(() => assertDuration(0, NAME, opts)).message).toBe(
      `${NAME} must be a finite number of milliseconds between 1 and 30000 (got 0)`
    );
    expect(() => assertDuration(30_001, NAME, opts)).toThrow(RangeError);
  });

  test('integer rejects fractions and says "whole number"', () => {
    expect(assertDuration(5, NAME, { integer: true })).toBe(5);
    const error = thrown(() => assertDuration(1.5, NAME, { integer: true }));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe(`${NAME} must be a whole number of milliseconds >= 0 (got 1.5)`);
  });

  test('allowInfinity accepts Infinity whatever max is, and still rejects NaN and -Infinity', () => {
    const opts = { allowInfinity: true, max: 1_000 };
    expect(assertDuration(Infinity, NAME, opts)).toBe(Infinity);
    expect(assertDuration(1_000, NAME, opts)).toBe(1_000);
    expect(() => assertDuration(1_001, NAME, opts)).toThrow(RangeError);
    expect(() => assertDuration(-Infinity, NAME, opts)).toThrow(RangeError);
    expect(thrown(() => assertDuration(NaN, NAME, opts)).message).toBe(
      `${NAME} must be a finite number of milliseconds between 0 and 1000 or Infinity (got NaN)`
    );
  });
});

describe('parseDurationEnv', () => {
  const VAR = 'STATS_INTERVAL_MS';

  test('unset or empty returns the fallback', () => {
    expect(parseDurationEnv(VAR, undefined, 300_000)).toBe(300_000);
    expect(parseDurationEnv(VAR, '', 300_000)).toBe(300_000);
  });

  test.each([
    ['0', 0],
    ['1', 1],
    ['007', 7],
    [' 5000 ', 5000],
    ['\t60000\n', 60_000],
    ['2147483648', 2 ** 31],
    ['2592000000', 2_592_000_000],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    // Forms parseInt read as written in 2.9.10 (upgrade compatibility): a sign, a
    // zero fraction, the unit, a Docker --env-file comment.
    ['+5', 5],
    ['5.0', 5],
    ['10ms', 10],
    ['10 MS', 10],
    ['1500.5', 1500],
    ['60000 # one minute', 60_000],
  ])('parses %p as %p', (raw, value) => {
    expect(parseDurationEnv(VAR, raw, 1)).toBe(value);
  });

  test('the message names the variable, the raw value and the expectation', () => {
    expect(thrown(() => parseDurationEnv(VAR, 'abc', 1)).message).toBe(
      'Invalid STATS_INTERVAL_MS: "abc" (expected a whole number of milliseconds >= 0)'
    );
  });

  test.each([
    'abc',
    ' ',
    '-1',
    '1.5e3',
    '1e3',
    '0x10',
    '1_000',
    '10s',
    '10mb',
    'NaN',
    'Infinity',
    '9007199254740993',
    '1 000',
  ])('rejects %p', (raw) => {
    const error = thrown(() => parseDurationEnv(VAR, raw, 1));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toStartWith(`Invalid ${VAR}: ${JSON.stringify(raw)} (expected `);
  });

  test('min and max bound the value and appear in the message', () => {
    const opts = { min: 1_000, max: 86_400_000 };
    expect(parseDurationEnv(VAR, '1000', 1, opts)).toBe(1_000);
    expect(parseDurationEnv(VAR, '86400000', 1, opts)).toBe(86_400_000);
    expect(thrown(() => parseDurationEnv(VAR, '999', 1, opts)).message).toBe(
      'Invalid STATS_INTERVAL_MS: "999" (expected a whole number of milliseconds between 1000 and 86400000)'
    );
    expect(() => parseDurationEnv(VAR, '86400001', 1, opts)).toThrow(Error);
    expect(() => parseDurationEnv(VAR, '0', 1, opts)).toThrow(Error);
  });

  test('allowZero lets 0 through below min and says so', () => {
    const opts = { min: 1_000, allowZero: true };
    expect(parseDurationEnv(VAR, '0', 5, opts)).toBe(0);
    expect(parseDurationEnv(VAR, ' 0 ', 5, opts)).toBe(0);
    expect(parseDurationEnv(VAR, '1000', 5, opts)).toBe(1_000);
    expect(thrown(() => parseDurationEnv(VAR, '1', 5, opts)).message).toBe(
      'Invalid STATS_INTERVAL_MS: "1" (expected 0 or a whole number of milliseconds >= 1000)'
    );
  });

  test('min 1 without allowZero rejects 0', () => {
    expect(() => parseDurationEnv(VAR, '0', 5, { min: 1 })).toThrow(
      'Invalid STATS_INTERVAL_MS: "0" (expected a whole number of milliseconds >= 1)'
    );
  });

  test('the fallback is returned as given, even when it lies outside the limits', () => {
    expect(parseDurationEnv(VAR, undefined, 0, { min: 1_000 })).toBe(0);
  });
});

describe('assertInteger', () => {
  const COUNT = 'TcpClient: maxInFlight';

  test.each([0, 1, -3, 100, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    'returns the whole number %p unchanged',
    (value) => {
      expect(assertInteger(value, COUNT)).toBe(value);
    }
  );

  test('the message names the option, the expectation and the received value', () => {
    const error = thrown(() => assertInteger(0, COUNT, { min: 1, allowInfinity: true }));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe(
      'TcpClient: maxInFlight must be a whole number >= 1 or Infinity (got 0)'
    );
  });

  test.each([
    [NaN, 'NaN'],
    [1.5, '1.5'],
    [-0.5, '-0.5'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
  ])('rejects %p with a RangeError', (value, shown) => {
    const error = thrown(() => assertInteger(value, COUNT));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe(`${COUNT} must be a whole number (got ${shown})`);
  });

  test.each([
    ['3', '"3"'],
    [undefined, 'undefined'],
    [null, 'null'],
    [3n, '3n'],
    [{}, 'an object'],
  ])('rejects the non-number %p with a TypeError', (value, shown) => {
    const error = thrown(() => assertInteger(value, COUNT));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(`${COUNT} must be a whole number (got ${shown})`);
  });

  test('min and max are inclusive and named in the message', () => {
    const opts = { min: 1, max: 65_535 };
    expect(assertInteger(1, COUNT, opts)).toBe(1);
    expect(assertInteger(65_535, COUNT, opts)).toBe(65_535);
    expect(thrown(() => assertInteger(65_536, COUNT, opts)).message).toBe(
      `${COUNT} must be a whole number between 1 and 65535 (got 65536)`
    );
    expect(thrown(() => assertInteger(0, COUNT, opts))).toBeInstanceOf(RangeError);
    expect(thrown(() => assertInteger(9, COUNT, { max: 8 })).message).toBe(
      `${COUNT} must be a whole number <= 8 (got 9)`
    );
  });

  test('allowInfinity accepts Infinity whatever max is, and still rejects NaN and -Infinity', () => {
    const opts = { min: 0, max: 10, allowInfinity: true };
    expect(assertInteger(Infinity, COUNT, opts)).toBe(Infinity);
    expect(() => assertInteger(-Infinity, COUNT, opts)).toThrow(RangeError);
    expect(thrown(() => assertInteger(NaN, COUNT, opts)).message).toBe(
      `${COUNT} must be a whole number between 0 and 10 or Infinity (got NaN)`
    );
  });

  test('-0 is a whole number and is shown as -0 when it is out of range', () => {
    expect(assertInteger(-0, COUNT)).toBe(-0);
    expect(thrown(() => assertInteger(-0, COUNT, { min: 1 })).message).toEndWith('(got -0)');
  });

  // A count above 2^53 - 1 is not exact (2^53 + 1 === 2^53), so a loop bound or a
  // counter compared against it never terminates or never matches.
  test.each([
    [2 ** 53, '9007199254740992'],
    [-(2 ** 53), '-9007199254740992'],
    [1e300, '1e+300'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
  ])('rejects the unsafe integer %p with a RangeError that says why', (value, shown) => {
    const error = thrown(() => assertInteger(value, COUNT, { min: 1 }));
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toBe(
      `${COUNT} must be a whole number >= 1 (got ${shown}, not a safe integer)`
    );
  });

  test('the safe-integer bound holds even under an explicit larger max', () => {
    expect(() => assertInteger(2 ** 53, COUNT, { max: 1e300 })).toThrow(RangeError);
    expect(assertInteger(Infinity, COUNT, { min: 1, allowInfinity: true })).toBe(Infinity);
  });

  test('unit names what is counted', () => {
    const opts = { min: 0, unit: 'bytes' };
    expect(assertInteger(1_024, COUNT, opts)).toBe(1_024);
    expect(thrown(() => assertInteger(-1, COUNT, opts)).message).toBe(
      `${COUNT} must be a whole number of bytes >= 0 (got -1)`
    );
    expect(thrown(() => assertInteger('1kb', COUNT, opts)).message).toBe(
      `${COUNT} must be a whole number of bytes >= 0 (got "1kb")`
    );
  });
});

describe('parseIntegerEnv', () => {
  // The single whole-number env parser: counts, sizes and ports use it directly, and
  // parseDurationEnv is parseIntegerEnv with unit 'milliseconds'.
  const VAR = 'RATE_LIMIT_MAX_REQUESTS';

  test('unset or empty returns the fallback, as given', () => {
    expect(parseIntegerEnv(VAR, undefined, 10_000, { min: 1 })).toBe(10_000);
    expect(parseIntegerEnv(VAR, '', 10_000, { min: 1 })).toBe(10_000);
    expect(parseIntegerEnv(VAR, undefined, -5, { min: 1 })).toBe(-5);
  });

  test.each([
    ['1', 1],
    [' 250 ', 250],
    ['007', 7],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ['+5', 5],
    ['5.00', 5],
    ['5 # five', 5],
  ])('parses %p as %p', (raw, value) => {
    expect(parseIntegerEnv(VAR, raw, 1, { min: 1 })).toBe(value);
  });

  test.each(['abc', '-1', '1.5e3', '1e3', '0x10', '64MB', ' ', '9007199254740993'])(
    'rejects %p with the same grammar as parseDurationEnv',
    (raw) => {
      expect(() => parseIntegerEnv(VAR, raw, 1)).toThrow(
        `Invalid ${VAR}: ${JSON.stringify(raw)} (expected `
      );
      expect(() => parseDurationEnv(VAR, raw, 1)).toThrow(
        `Invalid ${VAR}: ${JSON.stringify(raw)} (expected `
      );
    }
  );

  test('the unit, min and max appear in the message', () => {
    expect(thrown(() => parseIntegerEnv(VAR, '0', 1, { min: 1, unit: 'requests' })).message).toBe(
      'Invalid RATE_LIMIT_MAX_REQUESTS: "0" (expected a whole number of requests >= 1)'
    );
    expect(
      thrown(() => parseIntegerEnv('TCP_PORT', '70000', 1, { min: 0, max: 65_535 })).message
    ).toBe('Invalid TCP_PORT: "70000" (expected a whole number between 0 and 65535)');
    expect(thrown(() => parseIntegerEnv('N', 'x', 1)).message).toBe(
      'Invalid N: "x" (expected a whole number >= 0)'
    );
  });

  test('allowZero lets 0 through below min and says so', () => {
    const opts = { min: 1_024, allowZero: true, unit: 'bytes' };
    expect(parseIntegerEnv(VAR, '0', 5, opts)).toBe(0);
    expect(thrown(() => parseIntegerEnv(VAR, '1', 5, opts)).message).toBe(
      'Invalid RATE_LIMIT_MAX_REQUESTS: "1" (expected 0 or a whole number of bytes >= 1024)'
    );
  });

  test('parseDurationEnv is parseIntegerEnv in milliseconds', () => {
    for (const raw of ['5', '0', 'abc', '1e3']) {
      const duration = (() => {
        try {
          return parseDurationEnv(VAR, raw, 9, { min: 1 });
        } catch (error) {
          return (error as Error).message;
        }
      })();
      const integer = (() => {
        try {
          return parseIntegerEnv(VAR, raw, 9, { min: 1, unit: 'milliseconds' });
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(duration).toEqual(integer);
    }
  });
});

describe('describeValue', () => {
  test.each([
    ['abc', '"abc"'],
    [1n, '1n'],
    [-0, '-0'],
    [NaN, 'NaN'],
    [() => 1, 'a function'],
    [null, 'null'],
    [undefined, 'undefined'],
    [[1], 'an array'],
    [{ a: 1 }, 'an object'],
  ])('%p is shown as %s', (value, shown) => {
    expect(describeValue(value)).toBe(shown);
  });
});

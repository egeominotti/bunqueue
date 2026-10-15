import { describe, test, expect, spyOn } from 'bun:test';
import { parseGlobalOptions as parseWith } from '../src/cli/globalOptions';

describe('#1 short -h/-v are positional-gated', () => {
  test('push q data -h host: -h passes through, command would execute', () => {
    const { options, commandArgs } = parseWith(['push', 'q', '{"a":1}', '-h', 'myhost']);
    expect(options.help).toBe(false);
    expect(commandArgs).toEqual(['push', 'q', '{"a":1}', '-h', 'myhost']);
  });

  test('-h before any command is still global help', () => {
    const { options } = parseWith(['-h']);
    expect(options.help).toBe(true);
  });

  test('-v after a command passes through; --version stays global', () => {
    const v = parseWith(['stats', '-v']);
    expect(v.options.version).toBe(false);
    const long = parseWith(['stats', '--version']);
    expect(long.options.version).toBe(true);
  });

  test('--help stays global anywhere', () => {
    const { options } = parseWith(['push', 'q', '{}', '--help']);
    expect(options.help).toBe(true);
  });
});

describe('#2 -- separator stops global parsing', () => {
  test('flags after -- are never consumed as global', () => {
    const { options, commandArgs } = parseWith(['job', 'log', '5', '--', '--json']);
    expect(options.json).toBe(false);
    expect(commandArgs).toEqual(['job', 'log', '5', '--', '--json']);
  });

  test('-- as first arg passes everything through', () => {
    const { options, commandArgs } = parseWith(['--', 'stats', '--json', '-t', 'x']);
    expect(options.json).toBe(false);
    expect(options.token).toBeUndefined();
    expect(commandArgs).toEqual(['stats', '--', '--json', '-t', 'x']);
  });
});

describe('#3 attached short flags warn instead of silent data loss', () => {
  test('push -p10 warns (priority would be silently dropped)', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { commandArgs } = parseWith(['push', 'q', '{"a":1}', '-p10']);
      expect(commandArgs).toContain('-p10');
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls.map((c) => c.join(' ')).join('\n'));
      expect(msg).toContain('-p10');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('pull -t5000 does NOT warn (pull owns -t, attached form works)', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseWith(['pull', 'q', '-t5000']);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

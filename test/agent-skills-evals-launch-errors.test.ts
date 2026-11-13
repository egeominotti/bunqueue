import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { evalFixture } from './agent-skills-tools-audit-support';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('evaluation launch errors preserve aggregate reports', () => {
  for (const mode of [
    'missing-version-launch',
    'missing-discovery-launch',
    'missing-session-launch',
  ]) {
    test(`${mode} writes diagnostics and retains previously collected outcomes`, async () => {
      const f = evalFixture(mode);
      dirs.push(f.dir);
      if (mode === 'missing-version-launch') unlinkSync(join(f.dir, 'fake-agent'));
      const result = await f.run();
      expect(result.killed).toBe(false);
      expect(result.code).toBe(1);
      const base = join(f.dir, 'artifacts/skill-evals');
      const report = join(base, readdirSync(base).sort().at(-1)!, 'report.json');
      expect(existsSync(report)).toBe(true);
      const data = f.report();
      expect(data.launchErrors?.length).toBeGreaterThan(0);
      expect(
        data.launchErrors?.every(
          (error) => error.command.includes('fake-agent') && error.error.length > 0
        )
      ).toBe(true);
      if (mode === 'missing-session-launch') {
        expect(data.discovery.valid).toBe(true);
        expect(data.outcomes.map((o) => o.status)).toEqual(['ok', 'error']);
        expect(data.outcomes[0]?.loaded).toEqual(['bunqueue-dev']);
        expect(data.summary[0]?.shouldTrigger).toEqual({ hit: 1, total: 1 });
        expect(data.summary[0]?.shouldNot.total).toBe(0);
        expect(data.summary[0]?.errors).toBe(1);
        const dir = join(base, readdirSync(base).sort().at(-1)!);
        expect(readFileSync(join(dir, data.outcomes[1]!.log), 'utf8')).toMatch(/ENOENT|not found/i);
      } else {
        expect(data.discovery.valid).toBe(false);
        expect(data.outcomes).toEqual([]);
        if (mode === 'missing-discovery-launch') expect(f.calls()).toEqual([['--version']]);
      }
    });
  }
});

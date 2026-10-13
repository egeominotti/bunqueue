import type { Arbitrary, AsyncCommand } from 'fast-check';

/**
 * Opt-in (`BUNQUEUE_MODEL_STATS=1`) coverage counter: how many generated commands of each
 * kind passed their precondition and actually ran. A command that is generated but never
 * runs exercises nothing, so this is the evidence that a transition is reachable under a
 * given campaign size. Wrapping only maps the generated value, so the random draws, the
 * shrinker and seed/path replay are unchanged.
 */
export class CommandCoverage {
  readonly enabled = Bun.env.BUNQUEUE_MODEL_STATS === '1';
  private readonly executed = new Map<string, number>();
  private runs = 0;

  track<M extends object, R>(
    arbitraries: Arbitrary<AsyncCommand<M, R>>[]
  ): Arbitrary<AsyncCommand<M, R>>[] {
    if (!this.enabled) return arbitraries;
    return arbitraries.map((arbitrary) => arbitrary.map((command) => this.wrap(command)));
  }

  countRun(): void {
    this.runs++;
  }

  report(campaign: string, plannedRuns: number): void {
    if (!this.enabled) return;
    const rows = [...this.executed].sort(([a], [b]) => a.localeCompare(b));
    const lines = rows.map(([kind, count]) => `  ${kind}: ${count}`);
    console.log(
      `[model coverage] ${campaign}: ${this.runs}/${plannedRuns} runs\n${lines.join('\n')}`
    );
  }

  private wrap<M extends object, R>(command: AsyncCommand<M, R>): AsyncCommand<M, R> {
    return {
      check: (model) => command.check(model),
      run: async (model, real) => {
        try {
          await command.run(model, real);
        } finally {
          // After the run, so a command that resolves its target names what it ran.
          const kind = kindOf(command.toString());
          this.executed.set(kind, (this.executed.get(kind) ?? 0) + 1);
        }
      },
      toString: () => command.toString(),
    };
  }
}

/** `fail(model-job-0,terminal)` -> `fail(terminal)`: the name plus its plain-word arguments. */
function kindOf(text: string): string {
  const match = /^([^(]*)\((.*)\)$/.exec(text);
  if (!match) return text;
  const words = match[2]!
    .split(',')
    .map((argument) => argument.trim())
    .filter((argument) => /^[A-Za-z]+$/.test(argument));
  return words.length > 0 ? `${match[1]}(${words.join(',')})` : match[1]!;
}

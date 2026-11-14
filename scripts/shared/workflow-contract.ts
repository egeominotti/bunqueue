import { Context, check, type Mode } from './workflow-contract-support';
import { linear, branching, ecommerce, schema } from './workflow-contract-basic';
import { signal, concurrent, parallel } from './workflow-contract-control';
import { compensation, stepTimeout, retry, signalTimeout } from './workflow-contract-recovery';
import { nested, doUntil, doWhile, forEach, map } from './workflow-contract-operators';
import { archive, observability, subscribe } from './workflow-contract-observers';

export async function runWorkflowContract(mode: Mode): Promise<{ passed: number; failed: number }> {
  let port: number | undefined;
  if (mode === 'tcp') {
    const raw = process.env.TCP_PORT ?? '';
    check(/^\d+$/.test(raw), 'TCP_PORT must name the runner-owned TCP broker');
    port = Number(raw);
    check(Number.isInteger(port) && port > 0 && port <= 65535, 'TCP_PORT must be a valid TCP port');
  }
  let passed = 0;
  let failed = 0;
  const cases = [
    linear,
    branching,
    compensation,
    signal,
    concurrent,
    ...(mode === 'tcp' ? [ecommerce, stepTimeout] : [stepTimeout, ecommerce]),
    retry,
    parallel,
    signalTimeout,
    archive,
    observability,
    nested,
    doUntil,
    doWhile,
    forEach,
    map,
    subscribe,
    schema,
  ];
  for (const [index, scenario] of cases.entries()) {
    console.log(`\n${index + 1}. ${scenario.title}...`);
    const context = new Context(mode, port);
    const errors: unknown[] = [];
    try {
      await scenario.run(context);
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await context.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      failed++;
      console.error(
        `   [FAIL] ${scenario.title}`,
        new AggregateError(errors, 'Workflow case failed')
      );
    } else {
      passed++;
      console.log(`   [PASS] ${scenario.title}`);
    }
  }
  return { passed, failed };
}

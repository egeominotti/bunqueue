import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clampJourneyStep,
  describeTopology,
  detailParts,
  JOB_JOURNEYS,
  type JourneyStep,
  resolveTopology,
  TOPOLOGIES,
} from '../docs/src/components/examples/explainerModels';

const REPO = join(import.meta.dir, '..');
const EXAMPLES = readFileSync(join(REPO, 'docs/src/content/docs/examples.mdx'), 'utf8');
const COMPONENT_ROOT = join(REPO, 'docs/src/components/examples');

function source(name: string): string {
  return readFileSync(join(COMPONENT_ROOT, name), 'utf8');
}

describe('examples page progression', () => {
  test('moves from the learning path through local jobs to the end-to-end deployment', () => {
    const headings = [
      '## Learning path',
      '## Minimal queue and worker',
      '## Understand the job lifecycle',
      '## Retries and the dead letter queue',
      '## Scheduled and repeating jobs',
      '## Deduplicate jobs with jobId',
      '## Choose a deployment topology',
      '## Distributed mode (server + TCP)',
      '## Watch job events',
      '## Graceful shutdown',
      '## Workflow: automatic rollback on failure',
      '## Workflow: wait for a human decision',
      '## End-to-end example projects',
    ];
    const positions = headings.map((heading) => EXAMPLES.indexOf(heading));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(EXAMPLES.match(/## End-to-end example projects/g)).toHaveLength(1);
  });

  test('keeps every learning-path destination local and explicit', () => {
    const learningPath = source('ExamplesLearningPath.astro');
    for (const anchor of [
      '#minimal-queue-and-worker',
      '#understand-the-job-lifecycle',
      '#retries-and-the-dead-letter-queue',
      '#scheduled-and-repeating-jobs',
      '#deduplicate-jobs-with-jobid',
      '#choose-a-deployment-topology',
      '#workflow-automatic-rollback-on-failure',
      '#end-to-end-example-projects',
    ]) {
      expect(learningPath).toContain(`href="${anchor}"`);
    }
  });
});

describe('interactive job lifecycle model', () => {
  test('covers success, retry recovery, and terminal DLQ routes', () => {
    expect(Object.keys(JOB_JOURNEYS)).toEqual(['success', 'retry', 'dlq']);
    expect(JOB_JOURNEYS.success.steps.map(({ label }) => label)).toEqual([
      'Producer',
      'Ready queue',
      'Worker',
      'Completed',
    ]);
    expect(JOB_JOURNEYS.retry.steps.map(({ label }) => label)).toEqual([
      'Producer',
      'Ready queue',
      'Attempt 1',
      'Retry delay',
      'Ready again',
      'Attempt 2',
      'Completed',
    ]);
    expect(JOB_JOURNEYS.dlq.steps.at(-1)?.label).toBe('Dead letter queue');
  });

  test('gives every step the state getJobState() reports', () => {
    const states = (id: keyof typeof JOB_JOURNEYS) =>
      (JOB_JOURNEYS[id].steps as readonly JourneyStep[]).map(({ state }) => state);
    expect(states('success')).toEqual(['waiting', 'waiting', 'active', 'completed']);
    expect(states('retry')).toEqual([
      'waiting',
      'waiting',
      'active',
      'delayed',
      'waiting',
      'active',
      'completed',
    ]);
    expect(states('dlq')).toEqual(['waiting', 'waiting', 'active', 'delayed', 'active', 'failed']);
  });

  test('marks exactly the attempts that throw, which are still active', () => {
    const failing = Object.entries(JOB_JOURNEYS).flatMap(([id, journey]) =>
      (journey.steps as readonly JourneyStep[])
        .filter(({ attemptFails }) => attemptFails)
        .map(({ label, state }) => `${id}:${label}:${state}`)
    );
    expect(failing).toEqual([
      'retry:Attempt 1:active',
      'dlq:Attempt 1:active',
      'dlq:Final attempt:active',
    ]);
  });

  test('splits a detail on backticks into text and inline code', () => {
    expect(detailParts('`queue.add()` persists the job.')).toEqual([
      { code: true, text: 'queue.add()' },
      { code: false, text: ' persists the job.' },
    ]);
    expect(detailParts('Call `a` then `b`.')).toEqual([
      { code: false, text: 'Call ' },
      { code: true, text: 'a' },
      { code: false, text: ' then ' },
      { code: true, text: 'b' },
      { code: false, text: '.' },
    ]);
    expect(detailParts('No code here.')).toEqual([{ code: false, text: 'No code here.' }]);
    expect(detailParts('')).toEqual([]);
    expect(detailParts('``')).toEqual([]);
  });

  test('renders every step detail as balanced text and code', () => {
    for (const journey of Object.values(JOB_JOURNEYS)) {
      for (const { detail } of journey.steps) {
        expect(detail.split('`').length % 2, detail).toBe(1);
        expect(
          detailParts(detail)
            .map(({ text }) => text)
            .join('')
        ).toBe(detail.replaceAll('`', ''));
      }
    }
  });

  test('clamps every requested step to a legal route index', () => {
    expect(clampJourneyStep(-1, 4)).toBe(0);
    expect(clampJourneyStep(2.9, 4)).toBe(2);
    expect(clampJourneyStep(99, 4)).toBe(3);
    expect(clampJourneyStep(Number.NaN, 4)).toBe(0);
    expect(clampJourneyStep(1, 0)).toBe(0);
  });

  test('uses native controls and announces state changes', () => {
    const component = source('JobJourney.astro');
    expect(component).toContain('type="button"');
    expect(component).toContain('aria-pressed=');
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("customElements.get('bq-job-journey')");
    expect(component).toContain('clampJourneyStep(stepIndex, steps.length)');
    expect(component).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(component).toContain('scrollIntoView({');
  });
});

describe('interactive deployment topology model', () => {
  test('progresses from embedded to one broker and then N PostgreSQL brokers', () => {
    expect(TOPOLOGIES.map(({ id }) => id)).toEqual(['embedded', 'single-broker', 'multi-broker']);
    expect(TOPOLOGIES[0].durability).toContain('SQLite');
    expect(TOPOLOGIES[1].layers.flatMap(({ nodes }) => nodes)).toContain('bunqueue broker');
    expect(TOPOLOGIES[2].layers.flatMap(({ nodes }) => nodes)).toContain('PostgreSQL');
    expect(
      TOPOLOGIES[2].layers.find(({ label }) => label === 'N active brokers')?.nodes
    ).toHaveLength(3);
  });

  test('describes each diagram as one sentence per layer, links included', () => {
    expect(describeTopology(resolveTopology('embedded'))).toBe(
      'Bun application: Producer, Queue runtime, Worker. Via direct calls to optional persistence: SQLite.'
    );
    expect(describeTopology(resolveTopology('single-broker'))).toBe(
      'Client processes: Producer, Worker A, Worker B. Via TCP to queue service: bunqueue broker. ' +
        'Via local storage to persistence: SQLite.'
    );
    expect(describeTopology(resolveTopology('multi-broker'))).toBe(
      'Client processes: Producers, Workers, QueueEvents. ' +
        'Via TCP through a load balancer to N active brokers: Broker A, Broker B, Broker C. ' +
        'Via transactional coordination to shared persistence: PostgreSQL.'
    );
  });

  test('names every node and link of every topology in its description', () => {
    for (const topology of TOPOLOGIES) {
      expect(topology.links).toHaveLength(topology.layers.length - 1);
      const description = describeTopology(topology);
      for (const node of topology.layers.flatMap(({ nodes }) => nodes)) {
        expect(description).toContain(node);
      }
      for (const link of topology.links) expect(description).toContain(`Via ${link} to `);
    }
  });

  test('falls back to the simplest topology for missing or invalid state', () => {
    expect(resolveTopology(undefined).id).toBe('embedded');
    expect(resolveTopology('not-a-topology').id).toBe('embedded');
    expect(resolveTopology('multi-broker').id).toBe('multi-broker');
  });

  test('connects each control to one labelled panel and exposes a live summary', () => {
    const component = source('TopologyExplorer.astro');
    expect(component).toContain('aria-controls={`topology-${topology.id}`}');
    expect(component).toContain('aria-pressed=');
    expect(component).toContain('role="img"');
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain("customElements.get('bq-topology-explorer')");
  });

  test('keeps every new source below the project file-size limit', () => {
    const files = readdirSync(COMPONENT_ROOT).sort();
    expect(files).toEqual([
      'ExamplesLearningPath.astro',
      'JobJourney.astro',
      'TopologyExplorer.astro',
      'examples-explainers.css',
      'examples-journey.css',
      'examples-learning.css',
      'examples-topology.css',
      'explainerModels.ts',
    ]);
    for (const name of files) {
      expect(source(name).split('\n').length, name).toBeLessThanOrEqual(300);
    }
    const styles = source('examples-explainers.css');
    expect(styles).toContain('.ex-route[hidden],');
    expect(styles).toContain('.ex-topology-panel[hidden]');
    for (const name of [
      'examples-explainers.css',
      'examples-journey.css',
      'examples-learning.css',
    ]) {
      expect(source(name), name).toContain('@media (prefers-reduced-motion: reduce)');
    }
  });

  test('lays out each widget by its own width, never by the viewport', () => {
    expect(source('examples-explainers.css')).toContain('container: ex-panel / inline-size;');
    expect(source('examples-learning.css')).toContain('container: ex-learning / inline-size;');
    for (const name of [
      'examples-explainers.css',
      'examples-journey.css',
      'examples-learning.css',
      'examples-topology.css',
    ]) {
      const css = source(name);
      expect(css, name).not.toMatch(/@media[^{]*width/);
      expect(css, name).not.toContain('overflow-wrap: anywhere');
    }
    expect(source('examples-journey.css')).toContain('@container ex-panel (max-width: 44rem)');
    expect(source('examples-topology.css')).toContain('@container ex-panel (max-width: 44rem)');
    expect(source('examples-learning.css')).toContain('@container ex-learning (max-width: 36rem)');
  });

  test('keeps the size-holding copies out of search and the accessibility tree', () => {
    const component = source('JobJourney.astro');
    expect(component).toContain(
      '<p class="ex-now-text ex-now-ghost" aria-hidden="true" data-pagefind-ignore>'
    );
    expect(component).toContain('update(false);');
  });
});

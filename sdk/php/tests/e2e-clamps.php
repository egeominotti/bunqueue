<?php

declare(strict_types=1);

namespace Bunqueue\Tests;

use Bunqueue\OptionGuard;
use Bunqueue\Queue;
use Bunqueue\Worker;

/**
 * E2E: the four options pinned by sdk/CLAUDE.md rule 4 (docs/protocol.md 6.3 and 9).
 * A number is clamped, never rejected, and null (or omission) means the default.
 * Values that are not int or float keep their 0.2.0 conversion and never throw
 * (e2e-compat.php); a float `batchSize` still means 10, as in 0.2.0.
 */

/** @param array<string, mixed> $options */
function clampWorker(array $options): Worker
{
    return new Worker('clamps', fn () => null, $options);
}

/** @param list<array{0: mixed, 1: int|float}> $cases */
function assertWorkerOption(string $option, array $cases): void
{
    foreach ($cases as [$given, $expected]) {
        $worker = clampWorker([$option => $given]);
        assertSame($expected, $worker->{$option}, sprintf('%s %s', $option, var_export($given, true)));
        $worker->close();
    }
}

test('clamps: heartbeatIntervalS <= 0 or non-finite disables, a number is never rejected', function (): void {
    assertWorkerOption('heartbeatIntervalS', [
        [0, 0.0], [-1, 0.0], [-0.5, 0.0], [NAN, 0.0], [INF, 0.0], [-INF, 0.0],
        [0.05, 0.05], [10, 10.0], [1e300, 1e300], [null, 10.0],
    ]);
});

test('clamps: an int batchSize clamps to [1, 1000] and any float means 10', function (): void {
    assertWorkerOption('batchSize', [
        [5000, 1000], [0, 1], [-3, 1], [32, 32], [2.5, 10], [0.5, 10], [1000.9, 10],
        [5000.0, 10], [50.0, 10], [NAN, 10], [INF, 10], [-INF, 10], [null, 10],
    ]);
});

test('clamps: pollTimeoutMs clamps to [0, 30000] and NaN means 5000', function (): void {
    assertWorkerOption('pollTimeoutMs', [
        [NAN, 5000], [INF, 30_000], [-INF, 0], [-10, 0], [0, 0], [1.9, 1], [300, 300],
        [1e19, 30_000], [30_001, 30_000], [null, 5000],
    ]);
});

test('clamps: waitForJob ttl clamps to [0, 600000]; null and NaN mean 30000', function (): void {
    $cases = [
        [null, 30_000], [NAN, 30_000], [INF, 600_000], [-INF, 0], [-5, 0], [0, 0],
        [1.5, 1], [700_000, 600_000], [600_000, 600_000], [45_000, 45_000],
    ];
    foreach ($cases as [$given, $expected]) {
        assertSame($expected, OptionGuard::waitJobTtlMs($given), sprintf('ttl %s', var_export($given, true)));
    }
});

test('clamps: waitForJob accepts NaN and infinite ttls against a real server', function (Server $server): void {
    $queue = new Queue(uniqueName('wait-nan'), ['port' => $server->port]);
    $worker = new Worker($queue->name, fn () => ['done' => true], [
        'port' => $server->port,
        'pollTimeoutMs' => 300,
        'heartbeatIntervalS' => 0,
    ]);
    try {
        $job = $queue->add('t', ['x' => 1]);
        assertTrue(waitUntil(fn () => $worker->runOnce() === 1, 10.0), 'the job is processed');
        foreach ([NAN, INF, null] as $ttl) {
            $result = $queue->waitForJob($job->id(), $ttl);
            assertSame(['done' => true], $result, sprintf('waitForJob ttl %s returns the result', var_export($ttl, true)));
        }
    } finally {
        $worker->close();
        $queue->obliterate();
        $queue->close();
    }
});

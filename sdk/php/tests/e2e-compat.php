<?php

declare(strict_types=1);

namespace Bunqueue\Tests;

use Bunqueue\Queue;
use Bunqueue\Worker;

/**
 * E2E: `batchSize`, `pollTimeoutMs` and `heartbeatIntervalS` keep the setting
 * bunqueue/client 0.2.0 derived from every value it accepted. That includes
 * numeric strings read from the environment, bools, floats and values it replaced
 * with a default. The oracle is the 0.2.0 constructor code, verbatim.
 *
 * The only intended differences are the `pollTimeoutMs` values that 0.2.0 turned
 * into a non-blocking pull through PHP's int cast. NAN and INF became 0, and a
 * float beyond the int range wrapped (1e19 became 0, 2^64 + 8192 became 8192).
 * `compatPollFix()` lists them.
 */

/** The 0.2.0 `Worker::__construct` expressions, copied verbatim. */
function v020Setting(string $option, mixed $raw): int|float
{
    return match ($option) {
        'batchSize' => \is_int($raw) ? min(max(1, $raw), 1000) : 10,
        'pollTimeoutMs' => max(0, min(\is_numeric($raw) && is_finite((float) $raw) ? (int) $raw : 0, 30_000)),
        'heartbeatIntervalS' => (is_finite((float) $raw) && (float) $raw > 0) ? (float) $raw : 0.0,
    };
}

/**
 * The poll timeout this release uses where 0.2.0's int cast broke the value, or
 * null where 0.2.0's result must be kept. NAN means the 5000 default; INF and
 * out-of-range floats clamp to [0, 30000] instead of wrapping.
 */
function compatPollFix(mixed $raw): ?int
{
    if (!\is_float($raw) && !(\is_string($raw) && is_numeric($raw))) {
        return null;
    }
    $number = (float) $raw;
    if (is_nan($number)) {
        return 5000;
    }
    if (is_infinite($number) || abs($number) >= 2.0 ** 63) {
        return $number > 0 ? 30_000 : 0;
    }
    return null;
}

/** @return list<mixed> */
function compatInputs(): array
{
    return [
        '5000', '10', '50', '0', '-5', '2.5', ' 300', '300 ', '5e3', '1e19', '-1e19', '1e999', '0x1A', '',
        'abc', '10abc', true, false, [], [5], new \stdClass(),
        0, 1, -1, 32, 300, 5000, 30_001, PHP_INT_MAX, PHP_INT_MIN,
        0.0, -0.0, 0.5, 1.9, 2.5, 50.0, 1000.9, 5000.0, -0.5, 0.05,
        NAN, INF, -INF, 1e19, -1e19, 1e300, 2.0 ** 63, 2.0 ** 64 + 8192,
    ];
}

/** Run `$fn` without printing warnings such as "Object ... could not be converted to float". */
function compatQuietly(callable $fn): mixed
{
    set_error_handler(static fn (): bool => true, E_WARNING);
    try {
        return $fn();
    } finally {
        restore_error_handler();
    }
}

function compatLabel(string $option, mixed $raw): string
{
    $value = \is_array($raw) || \is_object($raw) ? get_debug_type($raw) : var_export($raw, true);
    return "{$option} => {$value}";
}

/**
 * Build a worker per case and fail once, listing every case that threw or differs.
 *
 * @param list<array{0: string, 1: mixed, 2: int|float}> $cases option, raw value, expected setting
 */
function assertCompatSettings(array $cases): void
{
    $mismatches = [];
    foreach ($cases as [$option, $raw, $expected]) {
        $label = compatLabel($option, $raw);
        try {
            $actual = compatQuietly(fn () => new Worker('compat', fn () => null, [$option => $raw]))->{$option};
        } catch (\Throwable $error) {
            $mismatches[] = sprintf('%s threw %s: %s', $label, $error::class, $error->getMessage());
            continue;
        }
        if ($actual !== $expected) {
            $mismatches[] = sprintf('%s gave %s, expected %s', $label, var_export($actual, true), var_export($expected, true));
        }
    }
    assertTrue($mismatches === [], \count($mismatches) . " mismatches:\n  " . implode("\n  ", $mismatches));
}

test('compat: worker options keep the 0.2.0 setting for every value 0.2.0 accepted', function (): void {
    $cases = [];
    foreach (['batchSize', 'pollTimeoutMs', 'heartbeatIntervalS'] as $option) {
        foreach (compatInputs() as $raw) {
            $fix = $option === 'pollTimeoutMs' ? compatPollFix($raw) : null;
            $cases[] = [$option, $raw, $fix ?? compatQuietly(fn () => v020Setting($option, $raw))];
        }
    }
    assertCompatSettings($cases);
});

test('compat: env and config values found by the audit keep their 0.2.0 meaning', function (): void {
    assertCompatSettings([
        ['pollTimeoutMs', '5000', 5000],
        ['pollTimeoutMs', '0', 0],
        ['heartbeatIntervalS', '10', 10.0],
        ['heartbeatIntervalS', '0.5', 0.5],
        ['heartbeatIntervalS', false, 0.0],
        ['heartbeatIntervalS', '', 0.0],
        ['batchSize', 50.0, 10],
        ['batchSize', '50', 10],
        ['batchSize', 2.5, 10],
        ['batchSize', 5000.0, 10],
        ['batchSize', 50, 50],
    ]);
});

test('compat: only wrapped or non-finite poll timeouts differ from 0.2.0', function (): void {
    $cases = [
        [NAN, 5000], [INF, 30_000], [-INF, 0], [1e19, 30_000], [-1e19, 0], [1e300, 30_000],
        [2.0 ** 63, 30_000], [2.0 ** 64 + 8192, 30_000], ['1e999', 30_000], ['-1e999', 0],
    ];
    assertCompatSettings(array_map(fn (array $case): array => ['pollTimeoutMs', ...$case], $cases));
});

test('compat: a worker configured from environment strings processes jobs', function (Server $server): void {
    $queue = new Queue(uniqueName('compat-env'), ['port' => $server->port]);
    $worker = new Worker($queue->name, fn () => ['ok' => true], [
        'port' => $server->port,
        'pollTimeoutMs' => '300',
        'heartbeatIntervalS' => '10',
        'batchSize' => '5',
    ]);
    try {
        assertSame(300, $worker->pollTimeoutMs, "pollTimeoutMs '300' is honoured");
        assertSame(10.0, $worker->heartbeatIntervalS, "heartbeatIntervalS '10' is honoured");
        assertSame(10, $worker->batchSize, "batchSize '5' keeps the 0.2.0 default of 10");
        $job = $queue->add('t', ['x' => 1]);
        assertTrue(waitUntil(fn () => $worker->runOnce() === 1, 10.0), 'the job is processed');
        assertSame(['ok' => true], $queue->waitForJob($job->id(), 5000), 'the result is stored');
    } finally {
        $worker->close();
        $queue->obliterate();
        $queue->close();
    }
});

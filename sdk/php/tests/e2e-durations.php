<?php

declare(strict_types=1);

namespace Bunqueue\Tests;

use Bunqueue\Connection;
use Bunqueue\Exception\BunqueueException;
use Bunqueue\OptionGuard;
use Bunqueue\Queue;
use Bunqueue\Worker;

/**
 * E2E: durations and lease lengths are validated where they enter.
 *
 * In PHP `(int) NAN` and `(int) INF` are 0 and a zero stream timeout makes `fread`
 * non-blocking, so an unchecked value became a busy loop, a reconnect storm or an
 * uncaught `ValueError` instead of a clear error at construction.
 */

/** Whether `$construct` throws \InvalidArgumentException. */
function rejectsOption(callable $construct): bool
{
    try {
        $construct();
    } catch (\InvalidArgumentException) {
        return true;
    }
    return false;
}

/** CPU seconds (user + system) this process has consumed so far. */
function cpuSeconds(): float
{
    $usage = getrusage();
    return $usage['ru_utime.tv_sec'] + $usage['ru_utime.tv_usec'] / 1e6
        + $usage['ru_stime.tv_sec'] + $usage['ru_stime.tv_usec'] / 1e6;
}

test('durations: poll timeout 0 never re-polls without waiting', function (Server $server): void {
    $queue = new Queue(uniqueName('poll0'), ['port' => $server->port]);
    $pulls = 0;
    $worker = null;
    $deadline = microtime(true) + 1.0;
    $worker = new Worker($queue->name, fn () => 'ok', [
        'port' => $server->port,
        'pollTimeoutMs' => 0,
        'heartbeatIntervalS' => 0,
        'onEvent' => function (array $event) use (&$pulls, &$worker, $deadline): void {
            if ($event['type'] === 'command' && ($event['command'] ?? '') === 'PULLB') {
                $pulls++;
            }
            if (microtime(true) >= $deadline && $worker !== null) {
                $worker->stop();
            }
        },
    ]);
    try {
        assertSame(0, $worker->pollTimeoutMs, 'poll timeout 0 kept (non-blocking pull)');
        $worker->run();
        // 50 ms idle wait: about 20 pulls per second. Without it: one pull per RTT.
        assertTrue($pulls < 100, "empty-queue loop issued {$pulls} PULLB in ~1 s (hot loop)");
        assertTrue($pulls >= 5, "empty-queue loop still polls ({$pulls} PULLB in ~1 s)");
    } finally {
        $queue->obliterate();
        $queue->close();
    }
});

test('durations: runOnce stays immediate at poll timeout 0', function (Server $server): void {
    $queue = new Queue(uniqueName('once0'), ['port' => $server->port]);
    $worker = new Worker($queue->name, fn () => 'ok', [
        'port' => $server->port,
        'pollTimeoutMs' => 0,
        'heartbeatIntervalS' => 0,
    ]);
    try {
        $worker->runOnce(); // registers
        $fastest = INF;
        for ($i = 0; $i < 5; $i++) {
            $started = microtime(true);
            assertSame(0, $worker->runOnce(), 'empty queue handles nothing');
            $fastest = min($fastest, microtime(true) - $started);
        }
        assertTrue($fastest < 0.05, sprintf('runOnce must not sleep (fastest %.1f ms)', $fastest * 1000));
        $queue->add('t', ['x' => 1]);
        assertTrue(waitUntil(fn () => $worker->runOnce() === 1, 5.0), 'non-blocking poll still delivers');
    } finally {
        $worker->close();
        $queue->obliterate();
        $queue->close();
    }
});

test('durations: invalid connection timeouts are rejected at construction', function (Server $server): void {
    $invalid = [NAN, INF, -INF, 0, 0.0, -1, -0.5, '5', null, true];
    foreach (['connectTimeout', 'commandTimeout'] as $option) {
        foreach ($invalid as $value) {
            if ($value === null) {
                continue; // null means the default
            }
            $label = sprintf('%s=%s', $option, var_export($value, true));
            assertTrue(
                rejectsOption(fn () => new Connection(['port' => $server->port, $option => $value])),
                "Connection {$label} must throw InvalidArgumentException"
            );
            assertTrue(
                rejectsOption(fn () => new Queue('q', ['port' => $server->port, $option => $value])),
                "Queue {$label} must throw InvalidArgumentException"
            );
            assertTrue(
                rejectsOption(fn () => new Worker('q', fn () => null, ['port' => $server->port, $option => $value])),
                "Worker {$label} must throw InvalidArgumentException"
            );
        }
    }
    $valid = new Connection(['port' => $server->port, 'connectTimeout' => 2, 'commandTimeout' => 0.5]);
    try {
        assertTrue($valid->ping(), 'int and fractional timeouts are accepted');
        foreach ([NAN, INF, 0.0, -1.0] as $timeout) {
            assertTrue(
                rejectsOption(fn () => $valid->call(['cmd' => 'Ping'], $timeout)),
                sprintf('call() timeout %s must throw InvalidArgumentException', var_export($timeout, true))
            );
        }
        assertTrue($valid->ping(), 'a rejected call() timeout leaves the connection usable');
    } finally {
        $valid->close();
    }
});

test('durations: commandTimeout 0 cannot become a reconnect storm', function (Server $server): void {
    $connects = 0;
    try {
        $connection = new Connection([
            'port' => $server->port,
            'commandTimeout' => 0,
            'onEvent' => function (array $event) use (&$connects): void {
                if ($event['type'] === 'connected') {
                    $connects++;
                }
            },
        ]);
    } catch (\InvalidArgumentException) {
        return; // rejected before any socket exists
    }
    $timeouts = 0;
    for ($i = 0; $i < 5; $i++) {
        try {
            $connection->ping();
        } catch (BunqueueException) {
            $timeouts++;
        }
    }
    $connection->close();
    throw new \AssertionError("commandTimeout 0 accepted: {$timeouts}/5 calls failed over {$connects} fresh connections");
});

test('durations: a NaN commandTimeout cannot busy-spin a long-poll', function (Server $server): void {
    try {
        $connection = new Connection(['port' => $server->port, 'commandTimeout' => NAN]);
    } catch (\InvalidArgumentException) {
        return;
    }
    try {
        $connection->ping();
        $cpu = cpuSeconds();
        $started = microtime(true);
        // A 500 ms server-side long-poll on an empty queue, read under the NaN deadline.
        $connection->call(['cmd' => 'PULL', 'queue' => uniqueName('nan-spin'), 'timeout' => 500]);
        $wall = microtime(true) - $started;
        $burned = cpuSeconds() - $cpu;
    } finally {
        $connection->close();
    }
    throw new \AssertionError(sprintf(
        'commandTimeout NAN accepted: a %.0f ms long-poll burned %.0f ms of CPU',
        $wall * 1000,
        $burned * 1000
    ));
});

test('durations: a non-finite connectTimeout cannot kill a running worker', function (Server $server): void {
    try {
        $worker = new Worker('q', fn () => null, ['port' => $server->port, 'connectTimeout' => INF]);
    } catch (\InvalidArgumentException) {
        return;
    }
    try {
        $worker->runOnce();
    } catch (\Throwable $error) {
        throw new \AssertionError(sprintf(
            'connectTimeout INF accepted, then the first connect threw %s: %s',
            $error::class,
            $error->getMessage()
        ));
    }
    throw new \AssertionError('connectTimeout INF accepted');
});

test('durations: lockTtlMs must be a whole number of milliseconds >= 1', function (Server $server): void {
    foreach ([0, -1, -30_000, 1.5, 30_000.0, NAN, INF, '30000', true] as $value) {
        $label = var_export($value, true);
        try {
            new Worker('q', fn () => null, ['port' => $server->port, 'lockTtlMs' => $value]);
            throw new \AssertionError("lockTtlMs {$label} accepted");
        } catch (\InvalidArgumentException) {
            // expected
        } catch (\TypeError $error) {
            throw new \AssertionError("lockTtlMs {$label} raised TypeError, not InvalidArgumentException");
        }
    }
    $worker = new Worker('q', fn () => null, ['port' => $server->port, 'lockTtlMs' => 1]);
    assertSame(1, $worker->lockTtlMs, 'lockTtlMs 1 is the smallest accepted lease');
    $default = new Worker('q', fn () => null, ['port' => $server->port]);
    assertSame(30_000, $default->lockTtlMs, 'default lease is 30000 ms');
});

test('durations: huge poll timeouts clamp to 30000, not to 0', function (Server $server): void {
    foreach ([1e19, 1e300, 30_001, 60_000.0] as $value) {
        $worker = new Worker('q', fn () => null, ['port' => $server->port, 'pollTimeoutMs' => $value]);
        assertSame(30_000, $worker->pollTimeoutMs, sprintf('pollTimeoutMs %s clamps to 30000', var_export($value, true)));
    }
    // Rule 4 (e2e-clamps.php covers every case): negative clamps to 0, NAN means 5000.
    $worker = new Worker('q', fn () => null, ['port' => $server->port, 'pollTimeoutMs' => -10]);
    assertSame(0, $worker->pollTimeoutMs, 'pollTimeoutMs -10 clamps to 0');
});

test('durations: an empty long-poll waits 10 ms before the next pull', function (Server $server): void {
    $queue = new Queue(uniqueName('poll1'), ['port' => $server->port]);
    $pulls = 0;
    $worker = null;
    $deadline = microtime(true) + 1.0;
    $worker = new Worker($queue->name, fn () => 'ok', [
        'port' => $server->port,
        'pollTimeoutMs' => 1,
        'heartbeatIntervalS' => 0,
        'onEvent' => function (array $event) use (&$pulls, &$worker, $deadline): void {
            if ($event['type'] === 'command' && ($event['command'] ?? '') === 'PULLB') {
                $pulls++;
            }
            if (microtime(true) >= $deadline && $worker !== null) {
                $worker->stop();
            }
        },
    ]);
    try {
        assertSame(1, $worker->pollTimeoutMs, 'a 1 ms long-poll is kept');
        $worker->run();
        // Main client rule (polling.ts): 10 ms after an empty pull when pollTimeout > 0,
        // so at most ~90 pulls per second; a 1 ms long-poll alone allows ~1000.
        assertTrue($pulls < 150, "empty 1 ms long-poll loop issued {$pulls} PULLB in ~1 s");
        assertTrue($pulls >= 5, "empty 1 ms long-poll loop still polls ({$pulls} PULLB in ~1 s)");
    } finally {
        $queue->obliterate();
        $queue->close();
    }
});

test('durations: huge timeouts are capped at the largest stream timeout PHP honours', function (Server $server): void {
    // php_tvtoto() turns a stream timeout above (INT_MAX - 1000) / 1000 s into an
    // infinite poll, and (int) of a float above PHP_INT_MAX wraps (1e300 -> 0).
    $cap = 2_147_482.0;
    foreach ([1e19, 1e300, (float) PHP_INT_MAX, 1e9, 2_147_483.0] as $value) {
        foreach (['connectTimeout', 'commandTimeout'] as $name) {
            $got = OptionGuard::seconds($value, $name);
            assertSame($cap, $got, sprintf('%s %s caps at %.1f s (got %s)', $name, var_export($value, true), $cap, var_export($got, true)));
        }
    }
    foreach ([0.001, 0.5, 30, 2_147_482.0] as $value) {
        assertSame((float) $value, OptionGuard::seconds($value, 'commandTimeout'), sprintf('%s is honoured', var_export($value, true)));
    }
});

test('durations: a huge commandTimeout cannot busy-spin a long-poll', function (Server $server): void {
    $connection = new Connection(['port' => $server->port, 'commandTimeout' => 1e300]);
    try {
        assertTrue($connection->ping(), 'commandTimeout 1e300 still pings');
        $cpu = cpuSeconds();
        $started = microtime(true);
        // A 500 ms server-side long-poll on an empty queue: (int) 1e300 === 0 made the
        // stream timeout 0, so every read returned at once and the loop spun.
        $connection->call(['cmd' => 'PULL', 'queue' => uniqueName('huge-spin'), 'timeout' => 500]);
        $wall = microtime(true) - $started;
        $burned = cpuSeconds() - $cpu;
        assertTrue($wall >= 0.4, sprintf('the long-poll really waited (%.0f ms)', $wall * 1000));
        assertTrue($burned < 0.15, sprintf('a %.0f ms long-poll burned %.0f ms of CPU', $wall * 1000, $burned * 1000));
    } finally {
        $connection->close();
    }
});

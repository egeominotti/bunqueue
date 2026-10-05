//! Regressions for durations that reach a timer, a socket timeout or a lease.
//!
//! Each test drives the public API against a disposable broker and observes
//! the defect through telemetry or broker state: an empty pull must be followed
//! by the main client's idle wait before the next one, a non-positive lock TTL
//! must not wedge the worker in a permanent error loop, and a zero command
//! timeout must be rejected before any socket opens instead of opening and
//! dropping one per call.

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bunqueue_client::{
    Connection, ConnectionOptions, Error, JobOptions, Queue, TelemetryCallback, TelemetryEvent,
    Value, Worker, WorkerOptions,
};
use support::Server;

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn connection_options(server: &Server) -> ConnectionOptions {
    ConnectionOptions {
        host: "127.0.0.1".into(),
        port: server.port,
        ..Default::default()
    }
}

fn recording() -> (TelemetryCallback, Arc<Mutex<Vec<TelemetryEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let callback: TelemetryCallback = Arc::new(move |event| {
        captured.lock().expect("telemetry lock").push(event);
    });
    (callback, events)
}

fn count(events: &Mutex<Vec<TelemetryEvent>>, matches: impl Fn(&TelemetryEvent) -> bool) -> usize {
    events
        .lock()
        .expect("telemetry lock")
        .iter()
        .filter(|event| matches(event))
        .count()
}

/// Run a worker on an empty queue for about one second and count its PULLB.
fn pulls_in_one_second(server: &Server, poll_timeout_ms: i64) -> usize {
    let pulls = Arc::new(AtomicUsize::new(0));
    let counter = pulls.clone();
    let telemetry: TelemetryCallback = Arc::new(move |event| {
        if matches!(&event, TelemetryEvent::CommandStarted { command, .. } if command == "PULLB") {
            counter.fetch_add(1, Ordering::Relaxed);
        }
    });
    let worker = Worker::new(
        unique("rust-empty-poll"),
        |_| Ok(Value::Nil),
        WorkerOptions {
            connection: ConnectionOptions {
                telemetry: Some(telemetry),
                ..connection_options(server)
            },
            poll_timeout_ms,
            heartbeat_interval: None,
            ..Default::default()
        },
    );
    let runner = worker.clone();
    let handle = thread::spawn(move || runner.run());
    thread::sleep(Duration::from_secs(1));
    worker.stop();
    handle
        .join()
        .expect("worker thread")
        .expect("worker run returns cleanly");
    worker.close();
    pulls.load(Ordering::Relaxed)
}

#[test]
fn non_blocking_poll_waits_between_empty_pulls() {
    let server = Server::start();
    let observed = pulls_in_one_second(&server, 0);
    eprintln!("poll_timeout_ms=0: {observed} PULLB in ~1 s");
    // A 50 ms idle wait allows about 20 pulls per second; a zero-delay loop
    // issues one PULLB per round trip (thousands per second on loopback).
    assert!(
        observed < 100,
        "a non-blocking poll must not re-poll with zero delay: {observed} PULLB in ~1 s"
    );
    assert!(observed > 0, "the worker must still poll");
}

#[test]
fn short_long_poll_waits_between_empty_pulls() {
    let server = Server::start();
    let observed = pulls_in_one_second(&server, 1);
    eprintln!("poll_timeout_ms=1: {observed} PULLB in ~1 s");
    // The main client waits 10 ms after an empty pull when its poll timeout is
    // positive: with a 1 ms long poll that is at most ~90 pulls per second.
    // Without the wait each cycle lasts only the 1 ms broker wait plus a round
    // trip (hundreds of PULLB per second).
    assert!(
        observed < 150,
        "a 1 ms long poll must wait 10 ms after an empty pull: {observed} PULLB in ~1 s"
    );
    assert!(observed > 0, "the worker must still poll");
}

fn assert_lock_ttl_falls_back_to_default(lock_ttl_ms: i64) {
    let server = Server::start();
    let options = connection_options(&server);
    let queue_name = unique("rust-lock-ttl");
    let queue = Queue::new(queue_name.clone(), options.clone());
    queue
        .add(
            "job",
            Value::Map(Vec::new()),
            JobOptions {
                durable: Some(true),
                ..Default::default()
            },
        )
        .expect("add job");
    let worker = Worker::new(
        queue_name,
        |_| Ok(Value::from("done")),
        WorkerOptions {
            connection: options,
            concurrency: 1,
            batch_size: 1,
            poll_timeout_ms: 1_000,
            lock_ttl_ms,
            heartbeat_interval: None,
            ..Default::default()
        },
    );
    let processed = worker.run_once();
    worker.close();
    queue.obliterate().expect("lock ttl cleanup");
    queue.close();
    assert_eq!(
        processed.expect("a non-positive lock TTL must not make every PULLB fail"),
        1,
        "lock_ttl_ms {lock_ttl_ms} must fall back to the default lease"
    );
}

#[test]
fn negative_lock_ttl_uses_the_default_lease() {
    assert_lock_ttl_falls_back_to_default(-1);
}

#[test]
fn zero_lock_ttl_uses_the_default_lease() {
    assert_lock_ttl_falls_back_to_default(0);
}

#[test]
fn zero_command_timeout_is_rejected_before_any_socket_opens() {
    let server = Server::start();
    let (telemetry, events) = recording();
    let connection = Connection::new(ConnectionOptions {
        command_timeout: Duration::ZERO,
        telemetry: Some(telemetry),
        ..connection_options(&server)
    });
    for _ in 0..5 {
        match connection.ping() {
            Err(Error::Connection(message)) => assert!(
                message.contains("command_timeout") && message.contains("greater than zero"),
                "unexpected message: {message}"
            ),
            other => panic!("a zero command timeout must be rejected, got {other:?}"),
        }
    }
    connection.close();
    let connects = count(&events, |event| {
        matches!(event, TelemetryEvent::Connecting { .. })
    });
    assert_eq!(
        connects, 0,
        "no socket may be opened for a zero command timeout"
    );
}

#[test]
fn zero_per_call_timeout_is_rejected_without_dropping_the_socket() {
    let server = Server::start();
    let (telemetry, events) = recording();
    let connection = Connection::new(ConnectionOptions {
        telemetry: Some(telemetry),
        ..connection_options(&server)
    });
    assert!(connection.ping().expect("initial ping"));
    for _ in 0..5 {
        let outcome = connection.call_timeout(
            vec![(Value::from("cmd"), Value::from("Ping"))],
            Duration::ZERO,
        );
        match outcome {
            Err(Error::Connection(message)) => assert!(
                message.contains("greater than zero"),
                "unexpected message: {message}"
            ),
            other => panic!("a zero per-call timeout must be rejected, got {other:?}"),
        }
    }
    assert!(connection.ping().expect("ping after rejected calls"));
    connection.close();
    let connects = count(&events, |event| {
        matches!(event, TelemetryEvent::Connecting { .. })
    });
    assert_eq!(
        connects, 1,
        "a rejected per-call timeout must not reconnect"
    );
}

#[test]
fn zero_connect_timeout_is_rejected_with_a_named_error() {
    let server = Server::start();
    let connection = Connection::new(ConnectionOptions {
        connect_timeout: Duration::ZERO,
        ..connection_options(&server)
    });
    match connection.ping() {
        Err(Error::Connection(message)) => assert!(
            message.contains("connect_timeout") && message.contains("greater than zero"),
            "unexpected message: {message}"
        ),
        other => panic!("a zero connect timeout must be rejected, got {other:?}"),
    }
    connection.close();
}

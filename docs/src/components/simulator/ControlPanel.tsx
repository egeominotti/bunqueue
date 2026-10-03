import { useState } from 'react';
import type { QueueView, SimulatorEngine, Snapshot } from '../../lib/simulator';
import RangeField from './RangeField';

// Manual controls: push jobs, start workers, pause/drain queues, and
// dial in chaos (failure rate, per-queue rate limit).
export default function ControlPanel({
  engine,
  snap,
}: {
  engine: SimulatorEngine;
  snap: Snapshot;
}) {
  const [queueName, setQueueName] = useState('emails');
  const [jobName, setJobName] = useState('send-welcome');
  const [priority, setPriority] = useState(0);
  const [delay, setDelay] = useState(0);
  const [bulkCount, setBulkCount] = useState(25);
  const [concurrency, setConcurrency] = useState(3);

  const target = queueName.trim();
  const queue = snap.queues.find((q) => q.name === target);
  const failurePct = Math.round(snap.failureRate * 100);
  const rateLimit = queue?.rateLimit ?? 0;
  const targetCode = <code>{target || '…'}</code>;

  const pushOne = () => {
    if (!target) return;
    engine.push(target, jobName.trim() || 'job', { priority, delay });
  };

  const pushMany = () => {
    if (!target) return;
    const base = jobName.trim() || 'job';
    engine.pushBulk(target, bulkCount, () => ({
      name: base,
      priority: Math.floor(Math.random() * 10),
      delay,
    }));
  };

  return (
    <aside className="panel controls" aria-label="Simulator controls">
      <section className="ctl-section">
        <h2 className="panel-title">Push jobs</h2>
        <label className="ctl-field">
          <span className="ctl-label">Queue</span>
          <input
            type="text"
            value={queueName}
            onChange={(e) => setQueueName(e.target.value)}
            list="sim-queues"
            placeholder="emails"
            spellCheck={false}
            autoComplete="off"
          />
          <datalist id="sim-queues">
            {snap.queues.map((q) => (
              <option key={q.name} value={q.name} />
            ))}
          </datalist>
        </label>
        <label className="ctl-field">
          <span className="ctl-label">Job name</span>
          <input
            type="text"
            value={jobName}
            onChange={(e) => setJobName(e.target.value)}
            placeholder="send-welcome"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="ctl-pair">
          <RangeField label="Priority" value={priority} min={0} max={9} onChange={setPriority} />
          <label className="ctl-field">
            <span className="ctl-label">Delay</span>
            <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
              <option value={0}>none</option>
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
            </select>
          </label>
        </div>
        <RangeField
          label="Bulk size"
          value={bulkCount}
          min={5}
          max={100}
          step={5}
          valueText={`${bulkCount} jobs`}
          onChange={setBulkCount}
        />
        <div className="ctl-buttons">
          <button type="button" className="btn btn-primary" onClick={pushOne}>
            Push job
          </button>
          <button type="button" className="btn" onClick={pushMany}>
            Push {bulkCount}
          </button>
        </div>
      </section>

      <section className="ctl-section">
        <h2 className="panel-title">Workers</h2>
        <RangeField
          label="Concurrency"
          value={concurrency}
          min={1}
          max={8}
          valueText={`${concurrency} slots`}
          onChange={setConcurrency}
        />
        <button
          type="button"
          className="btn btn-block"
          onClick={() => target && engine.createWorker(target, concurrency)}
        >
          Start worker on {targetCode}
        </button>
      </section>

      <section className="ctl-section">
        <h2 className="panel-title">
          Queue controls
          {queue?.paused && <span className="badge badge-paused">Paused</span>}
        </h2>
        <div className="ctl-buttons">
          {queue?.paused ? (
            <button type="button" className="btn" onClick={() => engine.resume(target)}>
              Resume
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => engine.pause(target)}>
              Pause
            </button>
          )}
          <button type="button" className="btn" onClick={() => engine.drain(target)}>
            Drain
          </button>
          <button type="button" className="btn" onClick={() => engine.retryDlq(target)}>
            Retry DLQ
          </button>
        </div>
        {snap.queues.length > 0 && (
          <ul className="queue-list" aria-label="Queues">
            {snap.queues.map((q) => (
              <li key={q.name}>
                <QueueRow
                  queue={q}
                  selected={q.name === queueName}
                  onSelect={() => setQueueName(q.name)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ctl-section">
        <h2 className="panel-title">Chaos</h2>
        <RangeField
          label="Failure rate"
          value={failurePct}
          min={0}
          max={80}
          step={5}
          display={`${failurePct}%`}
          valueText={`${failurePct}%`}
          onChange={(v) => engine.setFailureRate(v / 100)}
        />
        <RangeField
          label={<>Rate limit on {targetCode}</>}
          value={rateLimit}
          min={0}
          max={20}
          display={rateLimit === 0 ? 'off' : `${rateLimit}/s`}
          valueText={rateLimit === 0 ? 'off' : `${rateLimit} jobs per second`}
          onChange={(v) => {
            if (target) engine.setRateLimit(target, v);
          }}
        />
      </section>
    </aside>
  );
}

// One queue: name and shard, then its counts in words, so the state colors are a
// second signal rather than the only one. Selecting it targets the controls above.
function QueueRow({
  queue: q,
  selected,
  onSelect,
}: {
  queue: QueueView;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="queue-row"
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="queue-row-head">
        <span className="queue-row-name">{q.name}</span>
        <span className="queue-row-shard">S{q.shardIndex}</span>
        {q.paused && <span className="badge badge-paused">Paused</span>}
        {q.rateLimit > 0 && <span className="badge badge-rate">≤{q.rateLimit}/s</span>}
      </span>
      <span className="queue-row-counts">
        <span className="qc qc-waiting"><b>{q.waiting}</b> waiting</span>
        <span className="qc qc-delayed"><b>{q.delayed}</b> delayed</span>
        <span className="qc qc-active"><b>{q.active}</b> active</span>
        <span className="qc qc-dlq"><b>{q.dlq}</b> dead</span>
      </span>
    </button>
  );
}

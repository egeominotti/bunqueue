import type { SimulatorEngine } from '../../lib/simulator';
import type { Snapshot } from '../../lib/simulator';

const SPEEDS = [0.5, 1, 2, 4];

function fmtClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// The simulation's transport control: clock, pause, speed — plus the
// live counters that summarize everything below.
export default function TransportBar({
  snap,
  engine,
  onReset,
}: {
  snap: Snapshot;
  engine: SimulatorEngine;
  onReset: () => void;
}) {
  const { totals } = snap;
  const toggleLabel = snap.running ? 'Pause simulation' : 'Resume simulation';
  return (
    <div className="transport">
      <div className="transport-clock">
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => engine.setRunning(!snap.running)}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            {snap.running ? (
              <path d="M4.5 3h2.25v10H4.5zM9.25 3h2.25v10H9.25z" />
            ) : (
              <path d="M5 2.75v10.5L13.25 8z" />
            )}
          </svg>
        </button>
        <span className={`clock-time ${snap.running ? '' : 'is-paused'}`}>
          {fmtClock(snap.simTime)}
          {!snap.running && <span className="clock-state"> paused</span>}
        </span>
        <div className="speed-group" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className="speed-btn"
              onClick={() => engine.setSpeed(s)}
              aria-pressed={snap.speed === s}
              aria-label={`${s}× speed`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <dl className="transport-stats">
        <Stat label="Pushed" value={totals.pushed} />
        <Stat label="Active" value={totals.active} tone="active" />
        <Stat label="Completed" value={totals.completed} tone="completed" />
        <Stat label="Retries" value={totals.retried} tone="retry" />
        <Stat label="Dead" value={totals.dead} tone="failed" />
        <Stat label="Jobs/s" value={totals.jobsPerSec.toFixed(1)} />
      </dl>

      <button
        type="button"
        className="btn btn-ghost transport-reset"
        onClick={onReset}
        title="Clear all queues, workers and history"
      >
        Reset
      </button>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: string;
}) {
  return (
    <div className={`t-stat ${tone ? `tone-${tone}` : ''}`}>
      <dt className="t-stat-label">{label}</dt>
      <dd className="t-stat-value">{value}</dd>
    </div>
  );
}

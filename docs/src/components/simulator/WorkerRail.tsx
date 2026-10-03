import type { WorkerView } from '../../lib/simulator';

// One card per worker: its concurrency slots as dots (filled = busy),
// lifetime counters, and a stop control that drains gracefully.
export default function WorkerRail({
  workers,
  onStop,
}: {
  workers: WorkerView[];
  onStop: (id: string) => void;
}) {
  return (
    <section className="panel worker-panel" aria-labelledby="sim-workers-title">
      <h2 className="panel-title" id="sim-workers-title">
        Workers
      </h2>
      {workers.length === 0 ? (
        <p className="panel-empty">No workers. Start one to process jobs.</p>
      ) : (
        <ul className="worker-list">
          {workers.map((w) => (
            <li key={w.id} className={`worker-card is-${w.status}`}>
              <div className="worker-top">
                <span className="worker-id">{w.id}</span>
                <span className="worker-queue">{w.queue}</span>
                {w.status !== 'running' && (
                  <span className="badge">{w.status === 'stopping' ? 'Stopping' : 'Stopped'}</span>
                )}
                <span
                  className="worker-slots"
                  role="img"
                  title={`${w.activeCount}/${w.concurrency} slots busy`}
                  aria-label={`${w.activeCount} of ${w.concurrency} slots busy`}
                >
                  {Array.from({ length: w.concurrency }, (_, i) => (
                    <i key={i} className={i < w.activeCount ? 'slot-busy' : 'slot-idle'} />
                  ))}
                </span>
              </div>
              <div className="worker-stats">
                <span>
                  <b>{w.processed}</b> done
                </span>
                <span className={w.failed > 0 ? 'worker-failed' : ''}>
                  <b>{w.failed}</b> failed
                </span>
                {w.status === 'running' && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => onStop(w.id)}
                    aria-label={`Stop worker ${w.id}`}
                  >
                    Stop
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

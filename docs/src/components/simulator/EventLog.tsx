import type { SimEvent, SimEventType } from '../../lib/simulator';

function fmtT(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// The job state each event moves a job into, for its color. Control actions
// (worker, pause, resume, drain, rate limit, scenario) are not job states and
// stay neutral. The message text always names the event, so the color is a
// second signal, never the only one.
const EVENT_STATE: Partial<Record<SimEventType, string>> = {
  push: 'waiting',
  done: 'completed',
  retry: 'retry',
  dlq: 'failed',
  'retry-dlq': 'waiting',
};

// The server log tail: every push, completion, retry, dead letter and
// control action, newest first, stamped with sim-time. It changes several
// times a second, so it is a log that is not announced as it updates.
export default function EventLog({ events }: { events: SimEvent[] }) {
  return (
    <section className="panel event-panel" aria-labelledby="sim-events-title">
      <h2 className="panel-title" id="sim-events-title">
        Events <span className="panel-hint">newest first</span>
      </h2>
      {events.length === 0 ? (
        <p className="panel-empty">Quiet so far. Push a job or run a scenario.</p>
      ) : (
        <div
          className="event-scroll"
          role="log"
          aria-live="off"
          aria-labelledby="sim-events-title"
          tabIndex={0}
        >
          <ul className="event-list">
            {events.map((ev) => (
              <li
                key={ev.id}
                className={`event ev-${ev.type} ${EVENT_STATE[ev.type] ? `ev-state-${EVENT_STATE[ev.type]}` : 'ev-control'}`}
              >
                <span className="event-t">{fmtT(ev.t)}</span>
                <span className="event-msg">{ev.msg}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

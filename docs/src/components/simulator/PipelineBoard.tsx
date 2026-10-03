import type { ReactNode } from 'react';
import { fmtMs } from '../../lib/simulator';
import type { LaneId, SimJob, Snapshot } from '../../lib/simulator';

const LANES: { id: LaneId; label: string; empty: string }[] = [
  { id: 'waiting', label: 'Waiting', empty: 'Push a job' },
  { id: 'delayed', label: 'Delayed', empty: 'No scheduled jobs' },
  { id: 'active', label: 'Active', empty: 'Start a worker' },
  { id: 'completed', label: 'Completed', empty: 'Nothing done yet' },
  { id: 'dlq', label: 'Dead letter', empty: 'No dead letters' },
];

// The signature element: the job lifecycle as five live lanes.
// Chips move waiting → active → completed; failures bounce back through
// delayed with a backoff countdown until they land in the dead-letter lane.
// On narrow screens the lanes scroll sideways inside the board, which is
// focusable so the keyboard can scroll it too.
export default function PipelineBoard({ snap }: { snap: Snapshot }) {
  const showQueueTag = snap.queues.length > 1;
  return (
    <div className="panel board">
      <div className="board-scroll" role="region" aria-label="Job lifecycle lanes" tabIndex={0}>
        <div className="board-lanes">
          {LANES.map(({ id, label, empty }) => {
            const lane = snap.lanes[id];
            const overflow = lane.total - lane.jobs.length;
            return (
              <section key={id} className={`lane lane-${id}`} aria-labelledby={`sim-lane-${id}`}>
                <header className="lane-head">
                  <span className="lane-dot" aria-hidden="true" />
                  <h2 className="lane-title" id={`sim-lane-${id}`}>
                    {label}
                  </h2>
                  <span className="lane-count">{lane.total}</span>
                </header>
                <ul className="lane-body" role="list">
                  {lane.jobs.map((job) => (
                    <Chip
                      key={job.id}
                      job={job}
                      lane={id}
                      simTime={snap.simTime}
                      showQueue={showQueueTag}
                    />
                  ))}
                  {overflow > 0 && <li className="lane-overflow">+{overflow} more</li>}
                  {lane.total === 0 && <li className="lane-empty">{empty}</li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Chip({
  job,
  lane,
  simTime,
  showQueue,
}: {
  job: SimJob;
  lane: LaneId;
  simTime: number;
  showQueue: boolean;
}) {
  // A delayed job that already failed is waiting out a retry backoff, not a schedule.
  const retrying = lane === 'delayed' && job.attemptsMade > 0;
  return (
    <li className={`chip chip-${lane} ${retrying ? 'chip-retry' : ''}`} title={chipTitle(job)}>
      <span className="chip-top">
        <span className="chip-id">#{job.id}</span>
        <span className="chip-meta">{chipMeta(job, lane, simTime)}</span>
      </span>
      <span className="chip-name">{job.name}</span>
      {showQueue && <span className="chip-queue">{job.queue}</span>}
      {lane === 'active' && (
        <span className="chip-progress" aria-hidden="true">
          <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </span>
      )}
      {lane === 'dlq' && job.failedReason && (
        <span className="chip-reason">{job.failedReason}</span>
      )}
    </li>
  );
}

// The attempt count and the backoff countdown are two separate tokens, so a retry
// chip fits the narrowest lane without truncating either.
function chipMeta(job: SimJob, lane: LaneId, simTime: number): ReactNode {
  switch (lane) {
    case 'waiting':
      return `P${job.priority}`;
    case 'delayed': {
      const eta = fmtMs(Math.max(0, job.runAt - simTime));
      if (job.attemptsMade === 0) return `in ${eta}`;
      return (
        <>
          <span>
            ↻ {job.attemptsMade}/{job.maxAttempts}
          </span>{' '}
          <span>{eta}</span>
        </>
      );
    }
    case 'active':
      return `${Math.round(job.progress * 100)}%`;
    case 'completed':
      return fmtMs((job.finishedAt ?? 0) - (job.startedAt ?? 0));
    case 'dlq':
      return `${job.attemptsMade}/${job.maxAttempts}`;
  }
}

function chipTitle(job: SimJob): string {
  const parts = [`#${job.id} ${job.name}`, `queue ${job.queue}`, `priority ${job.priority}`];
  if (job.attemptsMade > 0) parts.push(`attempts ${job.attemptsMade}/${job.maxAttempts}`);
  if (job.failedReason) parts.push(job.failedReason);
  return parts.join(' · ');
}

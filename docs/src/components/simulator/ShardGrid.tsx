import type { ShardView } from '../../lib/simulator';

// Where each queue physically lives: fnv1aHash(queueName) & 7.
// A cell lights up when a push lands on it.
export default function ShardGrid({ shards }: { shards: ShardView[] }) {
  const maxLoad = Math.max(1, ...shards.map((s) => s.load));
  return (
    <section className="panel shard-panel" aria-labelledby="sim-shards-title">
      <h2 className="panel-title" id="sim-shards-title">
        Shards <code className="panel-hint">fnv1aHash(queue) &amp; {shards.length - 1}</code>
      </h2>
      <ul className="shard-grid" role="list">
        {shards.map((shard) => (
          <li
            key={shard.index}
            className={`shard-cell ${shard.flash ? 'is-flash' : ''} ${shard.load > 0 ? 'has-load' : ''}`}
            title={
              shard.queues.length > 0
                ? `S${shard.index}: ${shard.queues.join(', ')} — ${shard.load} pending`
                : `S${shard.index}: empty`
            }
          >
            <span className="shard-name">S{shard.index}</span>
            <span className="shard-load">
              {shard.load}
              <span className="sr-only"> pending</span>
            </span>
            <span className="shard-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((shard.load / maxLoad) * 100)}%` }} />
            </span>
            <span className="shard-queues">{shard.queues.join(' ') || 'empty'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

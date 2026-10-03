import type { SimulatorEngine } from '../../lib/simulator';
import { SCENARIOS } from '../../lib/simulator';

// One-click demos — the fastest way to see each mechanic move. The last one
// run stays pressed and its hint is shown below, announced once per click.
export default function ScenarioBar({
  engine,
  selected,
  onSelect,
}: {
  engine: SimulatorEngine;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const current = SCENARIOS.find((s) => s.id === selected);
  return (
    <div className="scenarios">
      <div className="scenario-bar" role="group" aria-labelledby="sim-scenarios-label">
        <span className="scenario-label" id="sim-scenarios-label">
          Scenarios
        </span>
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="scenario-chip"
            aria-current={s.id === selected ? 'true' : undefined}
            onClick={() => {
              s.apply(engine);
              onSelect(s.id);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="scenario-hint" aria-live="polite">
        {current ? current.hint : 'Run a demo, or drive the queue by hand from the controls.'}
      </p>
    </div>
  );
}

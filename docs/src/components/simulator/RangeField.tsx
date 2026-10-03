import type { CSSProperties, ReactNode } from 'react';

// A labelled slider: the name on the left, the current value on the right, and a
// track filled up to the value. The visible value is left out of the accessible name
// because the slider announces its own value (or `valueText`, when the raw number
// needs a unit or a word such as "off").
export default function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  valueText,
  onChange,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: ReactNode;
  valueText?: string;
  onChange: (value: number) => void;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <label className="ctl-field">
      <span className="ctl-label">
        <span className="ctl-name">{label}</span>
        <span className="ctl-value" aria-hidden="true">
          {display ?? value}
        </span>
      </span>
      <input
        type="range"
        className="ctl-range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        style={{ '--fill': `${fill}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

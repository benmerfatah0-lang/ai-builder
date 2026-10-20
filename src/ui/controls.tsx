import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Section({
  title,
  icon,
  action,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon?: IconName;
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <section className={`section ${open ? 'is-open' : ''}`}>
      <div className="section-head">
        <button
          type="button"
          className="section-title"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={contentId}
        >
          {icon && <Icon name={icon} size={14} />}
          <span>{title}</span>
          <Icon name="chevronDown" size={14} className={open ? 'chevron open' : 'chevron'} />
        </button>
        {action}
      </div>
      {open && (
        <div className="section-body" id={contentId}>
          {children}
        </div>
      )}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field ${className}`}>
      {label && <span className="field-label">{label}</span>}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 1000) / 1000);
}

export function NumberField({
  value,
  onCommit,
  min = -Infinity,
  max = Infinity,
  step = 1,
  label,
  suffix,
  disabled = false,
  compact = false,
  ariaLabel,
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  suffix?: string;
  disabled?: boolean;
  compact?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(() => formatNumber(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(formatNumber(value));
    }
  }, [value]);

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(max, Math.max(min, parsed));
      onCommit(clamped);
      setDraft(formatNumber(clamped));
    } else {
      setDraft(formatNumber(value));
    }
  };

  return (
    <label className={`number-field ${compact ? 'compact' : ''}`}>
      {label && <span className="number-label">{label}</span>}
      <span className="number-input-wrap">
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          aria-label={ariaLabel ?? label}
          disabled={disabled}
          step={step}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              setDraft(formatNumber(value));
              event.currentTarget.blur();
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
              const next = Math.min(max, Math.max(min, (Number.parseFloat(draft) || 0) + delta));
              setDraft(formatNumber(next));
              onCommit(next);
            }
          }}
        />
        {suffix && <span className="number-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (input: number) => String(Math.round(input * 100) / 100),
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <label className="slider-field">
      <span className="slider-head">
        <span className="field-label">{label}</span>
        <span className="slider-value">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <span className="select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </span>
    </label>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="color-field">
      <span className="field-label">{label}</span>
      <span className="color-control">
        <span className="color-swatch" style={{ background: value }}>
          <input
            type="color"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`${label} color`}
          />
        </span>
        <span className="color-hex">{value.toUpperCase()}</span>
      </span>
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`toggle ${checked ? 'is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  active = false,
  danger = false,
  className = '',
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'is-active' : ''} ${danger ? 'is-danger' : ''} ${className}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'danger';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function TextField({
  label,
  value,
  onCommit,
  maxLength = 80,
  disabled = false,
  placeholder,
}: {
  label?: string;
  value: string;
  onCommit: (value: string) => void;
  maxLength?: number;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(value);
      return;
    }
    if (trimmed !== value) onCommit(trimmed);
    else setDraft(trimmed);
  };

  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <input
        className="input"
        value={draft}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

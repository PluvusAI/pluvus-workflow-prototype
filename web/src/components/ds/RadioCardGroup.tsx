// RadioCardGroup — single-select list of large cards (title + optional
// description/icon), one selected at a time. The picker grammar the campaign
// wizard's template step already used inline (a radiogroup of sticker cards);
// extracted here so the reward-structure picker and any future N-way card
// choice share one accessible, keyboard-navigable implementation.
//
// Accessibility: a role="radiogroup" wrapping role="radio" buttons, matching the
// existing TemplateCard pattern in CampaignWizard. Arrow keys are handled by the
// browser's default focus model per button; selection is on click/Enter/Space.
import type { ReactNode } from "react";
import { colors, radii, font } from "../../theme";

export interface RadioCardOption<V extends string> {
  value: V;
  label: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** Disable this one option (e.g. an unavailable structure). */
  disabled?: boolean;
}

interface Props<V extends string> {
  /** Accessible group label (visually hidden — pair with a FormField label). */
  ariaLabel: string;
  options: RadioCardOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  /** Lay cards in a responsive grid instead of a vertical stack. */
  columns?: number;
  disabled?: boolean;
}

export function RadioCardGroup<V extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  columns,
  disabled,
}: Props<V>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: columns ? "grid" : "flex",
        gridTemplateColumns: columns ? `repeat(${columns}, 1fr)` : undefined,
        flexDirection: columns ? undefined : "column",
        gap: 10,
      }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        const isDisabled = disabled || opt.disabled;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={isDisabled}
            onClick={() => onChange(opt.value)}
            className="ds-focusable ds-card-interactive"
            style={{
              padding: "14px 16px",
              background: selected ? `${colors.accent}0f` : colors.bg,
              border: `1px solid ${selected ? colors.accent : colors.border}`,
              borderRadius: radii.md,
              boxShadow: selected ? `0 0 0 3px ${colors.accent}22` : "none",
              cursor: isDisabled ? "not-allowed" : "pointer",
              opacity: isDisabled ? 0.5 : 1,
              display: "flex",
              gap: 12,
              alignItems: opt.description ? "flex-start" : "center",
              textAlign: "left",
              width: "100%",
            }}
          >
            {opt.icon && (
              <div
                aria-hidden
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 9,
                  background: colors.panelAlt,
                  border: `1px solid ${colors.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {opt.icon}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: font.size.md,
                  fontWeight: font.weight.semibold,
                  color: colors.text,
                  marginBottom: opt.description ? 3 : 0,
                }}
              >
                {opt.label}
              </div>
              {opt.description && (
                <div
                  style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.5 }}
                >
                  {opt.description}
                </div>
              )}
            </div>
            {selected && (
              <div
                aria-hidden
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: colors.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  color: "#fff",
                  fontSize: 12,
                }}
              >
                ✓
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

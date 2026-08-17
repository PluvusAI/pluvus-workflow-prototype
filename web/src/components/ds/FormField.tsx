// FormField — label + control + optional hint/error wrapper.
// Generates an id so the <label htmlFor> properly associates with its control
// (a11y). Pass children that accept an id, or wire it manually.
import type { ReactNode } from "react";
import { colors, font } from "../../theme";

interface Props {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Show a required marker (*) after the label. Visual only — no validation. */
  required?: boolean | undefined;
  children: ReactNode;
}

export function FormField({ label, htmlFor, hint, error, required, children }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: font.size.sm,
          fontWeight: font.weight.medium,
          color: colors.text,
          lineHeight: 1.4,
        }}
      >
        {label}
        {required && (
          <span aria-hidden style={{ color: colors.danger, marginLeft: 3 }}>
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <span style={{ fontSize: font.size.xs, color: colors.textDim, lineHeight: 1.5 }}>
          {hint}
        </span>
      )}
      {error && (
        <span
          role="alert"
          style={{ fontSize: font.size.xs, color: colors.danger, lineHeight: 1.5 }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

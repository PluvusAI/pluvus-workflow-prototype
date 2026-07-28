// ---------------------------------------------------------------------------
// Brand-approval gate — feature flag
// ---------------------------------------------------------------------------
// The gate holds a local_payment deal for the brand's Approve/Reject before the
// content brief + payout link go out. It is OFF by default so every existing run,
// test and harness is byte-identical until a deployment opts in with
// BRAND_APPROVAL_GATE_ENABLED=true. The flag is read at ACCEPT time only (in the
// runtime dispatch), so flipping it never retroactively re-gates an in-flight run.

export function brandApprovalGateEnabled(): boolean {
  return process.env["BRAND_APPROVAL_GATE_ENABLED"] === "true";
}

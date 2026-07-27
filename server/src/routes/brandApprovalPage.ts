// ---------------------------------------------------------------------------
// Brand-approval pages — server-rendered HTML (brand-approval gate)
// ---------------------------------------------------------------------------
// The BRAND receives one email with two magic links (Approve / Reject). Per the
// payout-confirm precedent (I-5), the GET link renders an INTERSTITIAL whose
// button POSTs — GET never mutates (mail scanners prefetch GETs). Pure string
// builders (no Express types) so the markup is unit-testable and there is one
// source of truth per page state. Shares the dark-theme chrome with the payout
// pages so the hosted surfaces feel like one product.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- The raw magic-link token is in the URL query string; never leak it via the
       Referer header to any linked/loaded resource (PLU-118, Calvin review). This
       mirrors the Referrer-Policy header the route also sets. -->
  <meta name="referrer" content="no-referrer" />
  <title>${esc(title)}</title>
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --panelAlt: #1c2230; --border: #2d333b;
      --text: #e6edf3; --muted: #9198a1; --dim: #6e7681; --accent: #388bfd;
      --accentDim: #1f6feb; --success: #3fb950; --danger: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--text); min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px;
    }
    .card {
      width: 100%; max-width: 480px; background: var(--panel);
      border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
    }
    .head { padding: 22px 24px 14px; border-bottom: 1px solid var(--border); }
    .brand { font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--dim); }
    h1 { font-size: 19px; margin: 8px 0 4px; }
    .sub { font-size: 13.5px; color: var(--muted); line-height: 1.5; margin: 0; }
    .body { padding: 20px 24px 24px; display: flex; flex-direction: column; gap: 14px; }
    .terms { background: var(--panelAlt); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
    .kv { font-size: 13px; color: var(--muted); margin: 2px 0; }
    .kv b { color: var(--text); font-weight: 600; }
    form { margin: 0; }
    button {
      width: 100%; color: #fff; border: none; border-radius: 7px;
      padding: 12px 14px; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    button.approve { background: var(--success); }
    button.approve:hover { background: #2ea043; }
    button.reject { background: var(--danger); }
    button.reject:hover { background: #da3633; }
    .note { padding: 24px; text-align: center; }
    .badge {
      display: inline-block; width: 44px; height: 44px; line-height: 44px; border-radius: 50%;
      font-size: 22px; margin-bottom: 12px;
    }
    .ok { background: rgba(63,185,80,0.15); color: var(--success); }
    .warn { background: rgba(248,81,73,0.15); color: var(--danger); }
    .info { background: rgba(56,139,253,0.15); color: var(--accent); }
    .foot { padding: 12px 24px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--dim); text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    ${inner}
    <div class="foot">Secure brand approval · No account or password required.</div>
  </div>
</body>
</html>`;
}

export interface BrandApprovalTerms {
  fixedFee?: number | null;
  commissionRate?: number | null;
  negotiationFloor?: number | null;
  negotiationCeiling?: number | null;
  deliverables?: string | null;
  timeline?: string | null;
  paymentTerms?: string | null;
  rewardDescription?: string | null;
}

function formatDollars(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** Render the agreed-terms block shared by the interstitial. */
function termsBlock(t: BrandApprovalTerms): string {
  const rows: string[] = [];
  if (typeof t.fixedFee === "number" && Number.isFinite(t.fixedFee)) {
    const hasRange =
      typeof t.negotiationFloor === "number" &&
      Number.isFinite(t.negotiationFloor) &&
      typeof t.negotiationCeiling === "number" &&
      Number.isFinite(t.negotiationCeiling);
    const range = hasRange
      ? ` (your range: ${formatDollars(t.negotiationFloor!)}–${formatDollars(t.negotiationCeiling!)})`
      : "";
    rows.push(`<div class="kv">Fee: <b>${esc(formatDollars(t.fixedFee) + range)}</b></div>`);
  }
  if (typeof t.commissionRate === "number" && Number.isFinite(t.commissionRate) && t.commissionRate > 0) {
    rows.push(`<div class="kv">Commission: <b>${esc(formatAmount(t.commissionRate))}%</b> on referral sales</div>`);
  }
  if (t.deliverables) rows.push(`<div class="kv">Deliverables: <b>${esc(t.deliverables)}</b></div>`);
  if (t.timeline) rows.push(`<div class="kv">Timeline: <b>${esc(t.timeline)}</b></div>`);
  if (t.paymentTerms) rows.push(`<div class="kv">Payment terms: <b>${esc(t.paymentTerms)}</b></div>`);
  if (t.rewardDescription) rows.push(`<div class="kv">Perk: <b>${esc(t.rewardDescription)}</b></div>`);
  if (rows.length === 0) return "";
  return `<div class="terms">${rows.join("")}</div>`;
}

export interface BrandApprovalInterstitialInput {
  approvalId: string;
  token: string;
  brandName: string;
  creatorName: string;
  creatorHandle?: string | null;
  creatorPlatform?: string | null;
  campaignName?: string | null;
  terms: BrandApprovalTerms;
  /** "approve" renders the green button + POSTs to /brand-approval/approve/:id;
   *  "reject" renders the red button + POSTs to /brand-approval/reject/:id. */
  action: "approve" | "reject";
}

/** The interstitial (primary GET state): one button that POSTs with the token. */
export function renderBrandApprovalInterstitialPage(
  input: BrandApprovalInterstitialInput,
): string {
  const isApprove = input.action === "approve";
  const creatorLabel = input.creatorHandle
    ? `${input.creatorName} (@${input.creatorHandle})`
    : input.creatorName;
  const campaignPhrase = input.campaignName ? ` for ${esc(input.campaignName)}` : "";
  const heading = isApprove ? "Approve this creator?" : "Reject this creator?";
  const lead = isApprove
    ? `Approving sends ${esc(input.creatorName)} the content brief and payout link.`
    : `Rejecting pauses this deal — nothing is sent to the creator and our team will follow up.`;
  const buttonClass = isApprove ? "approve" : "reject";
  const buttonText = isApprove
    ? `Approve — send the brief`
    : `Reject — hold this deal`;
  const actionPath = isApprove ? "approve" : "reject";

  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>${esc(heading)}</h1>
      <p class="sub">${esc(creatorLabel)}${input.creatorPlatform ? ` on ${esc(input.creatorPlatform)}` : ""} has agreed to terms${campaignPhrase}. ${lead}</p>
    </div>
    <div class="body">
      ${termsBlock(input.terms)}
      <form method="POST" action="/brand-approval/${actionPath}/${esc(input.approvalId)}">
        <input type="hidden" name="token" value="${esc(input.token)}" />
        <button type="submit" class="${buttonClass}">${esc(buttonText)}</button>
      </form>
    </div>`;
  return shell(heading, inner);
}

/** Page after a successful approve (POST). */
export function renderBrandApprovedPage(input: {
  brandName: string;
  creatorName: string;
}): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Approved</h1>
    </div>
    <div class="note">
      <div class="badge ok">✓</div>
      <p class="sub">Thanks — we've sent ${esc(input.creatorName)} the content brief and payout link.<br/>
      Nothing more to do here.</p>
    </div>`;
  return shell("Approved", inner);
}

/** Page after a successful reject (POST). */
export function renderBrandRejectedPage(input: {
  brandName: string;
  creatorName: string;
}): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Deal paused</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">We've paused ${esc(input.creatorName)}'s deal. Nothing was sent to the creator, and our team will follow up.</p>
    </div>`;
  return shell("Deal Paused", inner);
}

/** Idempotent notice when the approval was already decided (mail-prefetch safe). */
export function renderBrandApprovalAlreadyActionedPage(input: {
  brandName: string;
  status: string;
}): string {
  // PROCESSING means a decision from a concurrent click is in flight (the claim is
  // held only for the duration of the workflow action). Show a gentle "in progress"
  // notice rather than a definitive "approved/rejected" the row hasn't reached yet.
  if (input.status === "PROCESSING") {
    const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Working on it</h1>
    </div>
    <div class="note">
      <div class="badge info">…</div>
      <p class="sub">Your response is being processed. There's nothing more to do here — you can safely close this page.</p>
    </div>`;
    return shell("Working On It", inner);
  }
  const label =
    input.status === "APPROVED"
      ? "already approved"
      : input.status === "REJECTED"
        ? "already rejected"
        : `already ${input.status.toLowerCase()}`;
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Nothing to do</h1>
    </div>
    <div class="note">
      <div class="badge info">✓</div>
      <p class="sub">This creator has been ${esc(label)}. There's nothing more to do here.</p>
    </div>`;
  return shell("Already Handled", inner);
}

/**
 * Neutral "handled elsewhere" notice (PLU-118, Calvin review §3). Shown when the
 * brand's click raced another actor (a creator opt-out, or the OTHER decision) that
 * moved the deal to a state THIS decision did not produce — so we do NOT record
 * this decision. Deliberately says neither "approved" nor "rejected": the deal's
 * true outcome lives on the instance and is surfaced to the operator.
 */
export function renderBrandApprovalHandledElsewherePage(input: { brandName: string }): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Nothing to do</h1>
    </div>
    <div class="note">
      <div class="badge info">✓</div>
      <p class="sub">This deal has already moved forward through another update, so no action is needed here. Our team has the latest status — you can safely close this page.</p>
    </div>`;
  return shell("Already Handled", inner);
}

/** Friendly expired-link page. */
export function renderBrandApprovalExpiredPage(input: { brandName: string | null }): string {
  const brand = input.brandName ? esc(input.brandName) : "your account";
  const inner = `
    <div class="head">
      <h1>Link expired</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">This approval link has expired.<br/>
      Please reach out to your Pluvus contact to approve ${brand}'s creator.</p>
    </div>`;
  return shell("Link Expired", inner);
}

/**
 * Retry-friendly page: the brand's click was accepted but the follow-on action
 * (sending the brief / halting the deal) hit a transient failure, so the decision
 * was NOT finalized and the claim was reverted to AWAITING_APPROVAL. The SAME link
 * still works — the brand can simply click again (PLU-118, Calvin review §2).
 */
export function renderBrandApprovalRetryPage(input: { brandName: string }): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Something went wrong</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">We couldn't finish processing your response just now, so nothing has changed yet.<br/>
      Please click the button in your email again in a moment. If it keeps failing, reach out to your Pluvus contact.</p>
    </div>`;
  return shell("Please Try Again", inner);
}

/** Invalid / not-found link (unknown approval or token mismatch — no detail). */
export function renderBrandApprovalInvalidPage(): string {
  const inner = `
    <div class="head">
      <h1>Link not found</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">This approval link is invalid or has expired.<br/>
      Please check the link in your email, or reach out to your Pluvus contact.</p>
    </div>`;
  return shell("Link Not Found", inner);
}

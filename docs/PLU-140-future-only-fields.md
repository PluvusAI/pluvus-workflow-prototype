# PLU-140 — Which negotiation-policy fields are "future-only," and why

**Audience:** anyone (engineer, PM, designer) trying to understand why some
worksheet Page-8 questions are fully working and some are shown but disabled.

**Short version:** A field is "future-only" when Pluvus **cannot actually do
anything with the answer yet** — either there's nowhere to save it, or nothing
in the negotiation agent reads it.

**Current decision (founder direction):** build the **full Page-8 layout now**,
but render the future-only controls as **disabled, UI-only placeholders** (flag
`FieldSpec.uiOnly` in `web/.../sections.ts`) so the intended structure is in
place and Harshit can wire them next week. They are **excluded from every data
path** — no payload, no validation, no clear-on-switch — and a code comment on
`uiOnly` states they must not be enabled until their DB column, launch-snapshot
logic, and negotiation-engine behavior all exist. (This is for internal build
tracking; it won't go to production, so there is no user-facing "coming soon."）

---

## The one rule we followed

For every question on Page 8 (Private Negotiation Settings), we asked **two**
questions:

1. **Can we save the answer?** — Is there a database column for it?
2. **Will Pluvus act on the answer?** — Does the negotiation agent read it and
   change what it does?

A field is **shipped** only if the answer to **both** is yes.
A field is **future-only** if the answer to **either** is no.

Why so strict? Because the issue we're implementing says, in plain words:

> "Do not create agent capabilities merely because a schema field exists…
> explicitly mark future-only fields."

In other words: **don't build a switch that isn't wired to anything.**

---

## Why an *enabled* dead control would be dangerous — so ours are disabled

Imagine we shipped a **working** control called **"When Pluvus can't close a
deal: Reject automatically."** The brand picks *Reject* and saves. They now
believe: *"Good — if a creator asks for too much, Pluvus will just say no."*

But under the hood, the negotiation agent has no "reject" behavior — it always
**escalates** (sends the deal to a human to review). So what actually happens:

- The brand *thinks* deals are being auto-rejected.
- In reality every out-of-range deal lands in a human review queue.
- The brand's stored setting is a **silent lie**.

On a money/negotiation path, that's not a cosmetic bug — it's a broken promise
about how the brand's budget gets spent.

**That's exactly why the future-only controls are rendered DISABLED and wired to
nothing.** They're visible so the layout and future wiring points are in place,
but a brand can't set a value the agent would ignore: the input can't be edited,
nothing is saved, nothing is validated. When the real DB + engine support lands,
flipping off the `uiOnly` flag turns each one into a live control in its final
position — no re-layout needed.

---

## An analogy

Think of a car dashboard.

- A **speedometer** is wired to the wheels — it shows real speed. (This is a
  *shipped* field: you set it, the car honors it.)
- Painting a **"TURBO" button** on the dash that isn't connected to the engine
  doesn't make the car faster. It just misleads the driver. (This is what a
  *future-only field would become* if we rendered it anyway.)

We install real gauges. We don't paint fake buttons.

---

## The 5 future-only fields (and exactly why each one is out)

Every field below fails **at least one** of the two tests. The database table is
`NegotiationPolicy` (see `server/src/db/schema.ts`), which today has columns for
fee bounds, commission-rate bounds, gift flexibility, max rounds, tolerance,
guidance, and negotiable/non-negotiable category markers — and **nothing else.**

| Worksheet | What it asks | Can we save it? | Does the agent act on it? | Verdict |
|---|---|---|---|---|
| **S8.A2** | Commission **duration** band (shortest/longest commission length Pluvus may accept) | ❌ No column — we store commission *rate* bounds, but not a commission *duration* range | ❌ Engine reads no duration band | **Future-only** |
| **S8.C1** | Deliverable flexibility (may Pluvus accept fewer posts / a different format?) | ❌ No column | ❌ No engine support | **Future-only** |
| **S8.C2** | Latest posting date Pluvus can accept (schedule slack, in days) | ❌ No column | ❌ No engine support | **Future-only** |
| **S8.C3** | Usage-rights / exclusivity minimums (shortest rights duration Pluvus may accept) | ❌ No column | ❌ No engine support | **Future-only** |
| **S8.C4** | Alternative Content Angles Pluvus can accept | ❌ No column | ❌ No engine support | **Future-only** |
| **S8.C5** | Script/idea submission waiver (may Pluvus drop the script requirement?) | ❌ No column | ❌ No engine support | **Future-only** |
| **S8.E0** | Approval mode ("how in-the-loop": fully autonomous / approve first deal / approve every deal) | ❌ No column | ❌ Engine has no "pause and wait for brand approval before closing" step — it auto-closes inside the limits | **Future-only** |
| **S8.E1** | Out-of-policy rule: **Escalate to you** vs **Reject automatically** | ❌ No column | ❌ Engine's out-of-range behavior is hardwired to **escalate** — there is no auto-reject code path | **Future-only** ⚠️ *(this one is marked "Required" in the worksheet — see below)* |

> Grouping note: S8.C1–C5 are five separate "band" controls; they're listed
> individually above but share the same reason (no columns, no engine), so we
> refer to them together as "the C-series bands."

### The special case: S8.E1 is the only *Required* one that's disabled

The worksheet marks **S8.E1 (escalate vs. reject) as Required.** It's rendered
(so the layout is complete) but **disabled/UI-only**, because enabling it
honestly needs **both** a new database column **and** a brand-new agent behavior
(auto-reject), and the issue explicitly says PLU-140 adds **"no new
negotiation-engine capability."**

So this is a real, deliberate deferral of a worksheet-Required control — tracked,
not hidden:

- The control's hint states the current default in plain words: *"Today every
  out-of-policy request escalates to you."* So there's no illusion about
  present behavior.
- It carries the `uiOnly` code comment (see below) so the wiring checklist is
  right next to the field, and it's split into follow-up Linear issues.

---

## What we DID ship for Page 8 (so the picture is complete)

These passed both tests — real column, and the agent (or the launch-readiness
gate) actually uses them:

| Worksheet | Field | Column it saves to |
|---|---|---|
| **S8.P1** | Highest fee (ceiling) — *Required* | `ceilingCents` (+ preferred/floor) |
| **S8.A1** | Highest commission (ceiling) — *Required* | `commissionCeilingRate` (+ preferred/floor) |
| **S8.G2** | Cash-instead-of-product ceiling | `giftValueFlexibilityCents` |
| Page 8 | Max negotiation rounds | `maxRounds` |
| Page 8 | Over-ceiling tolerance | `overCeilingTolerance` |
| Page 8 | Negotiation guidance (free text) | `negotiationGuidance` |
| S8.E1 (partial) | Terms Pluvus may **not** negotiate (fee/commission/gift) | `nonNegotiableTerms` |

### Two things that look future-only but aren't

- **S8.G1 (substitutions)** — this one *has* a column (`giftSubstitutionAllowed`),
  so it's **shipped**, not future-only. The catch: the worksheet wanted
  *multi-select chips* ("which substitutions?") but the column is a single
  **yes/no boolean**. So we rendered it as a **toggle**. That's a *narrowing* of
  a real, working field — a different situation from the 5 dead ones above.

- **S8.E1's "non-negotiable" idea** — while the *escalate-vs-reject choice* is
  future-only, the related idea of *"mark these terms as fixed"* **does** have a
  column (`nonNegotiableTerms`). So we shipped that part as the **"Terms Pluvus
  may not negotiate"** checkboxes (fee / commission / gift), which the
  launch-readiness check actually reads. Only the escalate/reject toggle itself
  is deferred.

---

## What it would take to un-defer one of these later

The UI is already in place (disabled). To turn one **live**, a policy value also
has to survive **launch**, which freezes the policy into an immutable snapshot.
So each future-only field needs, at minimum:

1. A column on **`NegotiationPolicy`** (the editable draft policy), **and**
2. The same column on **`NegotiationPolicySnapshot`** (the frozen-at-launch
   copy) — miss this and the value is silently dropped the moment the campaign
   goes live,
3. A line in **`launchCampaign()`** that copies the column into the snapshot,
4. Read/validate wiring in the **PATCH route** and (if required) the
   **readiness** check,
5. Web: rename the field key from `uiOnly_*` to the real column key, add it to
   the types + the clear-on-switch map, **and remove the `uiOnly` flag**, and —
   the big one —
6. **Engine code** in the negotiation agent that actually reads the value and
   changes what Pluvus does.

Step 6 is why these are deferred: it's the "new negotiation-engine capability"
the current issue puts out of scope. The column is the easy 10%; the engine
behavior is the 90% that makes the control *true*.

These are broken into follow-up Linear issues (DB/snapshots, engine wiring,
negotiation behavior, approval/rejection logic, e2e testing).

---

## One-paragraph summary

A "future-only" field is a question we can't yet answer truthfully with Pluvus's
behavior — there's no column to store it and/or no agent code to act on it. On
Page 8 those are **S8.A2** (commission-duration band), **S8.C1–C5** (deliverable
/ posting-date / rights / angle / script bands), **S8.E0** (approval mode), and
**S8.E1** (escalate-vs-reject). Per founder direction we **built the full Page-8
layout** but rendered these as **disabled, UI-only placeholders** (`uiOnly`),
excluded from every data path, with a code comment stating they must not be
enabled until their DB column, launch-snapshot logic, and engine behavior all
exist. When those land, clearing the `uiOnly` flag turns each into a live control
in its final spot — no re-layout, and no risk of a control that silently lies in
the meantime.

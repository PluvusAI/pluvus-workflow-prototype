"""PLU-114 — deterministic campaign-knowledge retrieval.

Selects only the campaign-knowledge sections relevant to the current creator turn
(latest message + open obligations) so ONLY those reach the /negotiate and /draft
prompts, instead of the whole-brief blob. Deterministic keyword/regex router —
NO embeddings, NO vector DB, NO model call (invariant #2). Pure function over
inputs the executor already assembles; writes nothing durable.

Load-bearing invariants (PLAN.md §0):
  #1 Retrieval is a NOISE reducer, never a source of truth. It narrows what the
     model reads; it never fabricates a fact or moves a dollar figure.
  #3 no_match is an EXPLICIT outcome, never `[]`. The caller then falls back to
     today's flat block, so a too-conservative router degrades to current
     behavior — never a regression, never a stripped email.
  #4 A selected-but-absent section defers honestly (requested_but_unavailable);
     it is still returned (so observability records the ask) but carries NO value.
  #5 Open obligations WIDEN retrieval: a deferred "when does it ship?" from turn 1
     pulls in `shipping` on turn 3 even when turn 3's message is silent on it.
  #6 Broad questions ("what are the terms?") select MULTIPLE sections on purpose.
  #7 Every retrieval records what was selected, why (rule), and where each value
     resolved from (campaign_field vs brief_section). Section VALUES are never
     part of the record the caller logs — keys/rules/ids only.

The regexes reuse the SAME topic vocabulary already proven in the negotiation
`_KNOWN_FACT_QA` (negotiate.py:4051) and the parser's `_KEYWORD_SIGNALS`
(brief.py) routers, so the classifier here and the post-draft verifier agree on
what a "usage-rights" mention is.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Optional

from app.injection import normalize_untrusted_text

# ---------------------------------------------------------------------------
# Section vocabulary (§4.1)
# ---------------------------------------------------------------------------
# The closed set of section keys v1 routes to — the topics creators actually ask
# about in negotiation. Kept as the camelCase keys the parser emits where they
# overlap (usageRights/exclusivity/paymentTerms/timeline/deliverables/shipping/
# overview) so ParsedBrief.sections → AvailableSections.brief is a projection.
#
# REVIEW correction #3: `attributionWindow` is FLAT-FIELD-ONLY. It is NOT a parser
# section key (absent from brief._SINGLE_KEYS) — the parser has no attribution
# heading/keyword. It routes from `fields`, never from `brief`.
SectionKey = Literal[
    "usageRights",
    "exclusivity",
    "paymentTerms",
    "timeline",
    "deliverables",
    "shipping",
    "attributionWindow",
    "overview",
]

# All valid keys, for validation / iteration.
SECTION_KEYS: tuple[str, ...] = (
    "usageRights",
    "exclusivity",
    "paymentTerms",
    "timeline",
    "deliverables",
    "shipping",
    "attributionWindow",
    "overview",
)

# At most this many sections per turn — guarantees retrieval can NEVER re-create
# the whole-brief dump (§4.8). Five is the size of the core-commercial broad set;
# a normal turn selects one or two.
MAX_SELECTED_SECTIONS = 5


# ---------------------------------------------------------------------------
# The sectionMap — deterministic message→section(s) router (§4.2)
# ---------------------------------------------------------------------------
# One matcher per topic. Each `test` is the SAME family of question-signal regex
# the verifier (_KNOWN_FACT_QA) uses to check whether a question about that field
# was answered — running the router and the verifier off the same signals keeps
# them from disagreeing. A topic may select MORE THAN ONE section (broad topics).


@dataclass(frozen=True)
class _SectionRule:
    topic: str
    test: re.Pattern[str]
    sections: tuple[SectionKey, ...]
    # Calvin follow-up §3.3: a rule that fires on a GREEDY / over-broad signal
    # (e.g. a bare `address`, which is as likely to mean a contract address as a
    # shipping one). Such a match is `low` confidence UNLESS a corroborating
    # high-confidence rule also fired this turn — low confidence triggers the
    # caller's full-context fallback rather than a narrow (possibly wrong) block.
    greedy: bool = False


SECTION_MAP: tuple[_SectionRule, ...] = (
    _SectionRule(
        "usage_rights_question",
        re.compile(r"usage|reshare|reuse|use my|use the content|licen[cs]e|rights|repost|whitelist", re.I),
        ("usageRights",),
    ),
    _SectionRule(
        "exclusivity_question",
        re.compile(r"exclusiv|locked? out|lock me|other brand|competitor|category|tied to|only (you|work|with)", re.I),
        ("exclusivity",),
    ),
    _SectionRule(
        "payment_question",
        # Calvin follow-up §3.4: broaden beyond "pay/payment/net/invoice/payout" to
        # the money-arrival synonyms creators actually use — "when will the funds
        # hit?", "when does the money land / clear / settle", "deposit", "remit".
        # Without these, "When will the funds hit?" fell through to no_match.
        #   - `fund(s)?|money|deposit|remit` are money NOUNS that fire on their own.
        #   - the arrival-VERB branch (hit/land/clear/settle) is scoped to a money
        #     noun in the same clause so it does NOT steal a shipping "when does the
        #     product arrive" (arrive is deliberately excluded — it is a shipping
        #     verb; "funds hit" is caught by the noun `fund` anyway).
        # Kept deterministic; no value is ever produced from the match.
        re.compile(
            r"paid|payment|net[- ]?\d|invoic|payout"
            r"|\bfunds?\b|\bmoney\b|deposit|remit|settle"
            r"|when.*(get|do).*pay"
            r"|(fund|money|payment|cash|invoice|deposit).*(hit|land|clear)"
            r"|(hit|land|clear).*(fund|money|payment|cash|invoice|account|bank)",
            re.I,
        ),
        ("paymentTerms",),
    ),
    _SectionRule(
        "timeline_question",
        re.compile(r"timeline|deadline|due date|turnaround|when.*(live|post|due)|how long.*(take|until)", re.I),
        ("timeline",),
    ),
    _SectionRule(
        "deliverables_question",
        # A bare content-format noun ("video", "reel", "post") is too greedy — it
        # fires on the usage idiom "use my video / repost my content". Require the
        # noun to be COUNTED (`3 reels`, `how many posts`) or paired with a
        # produce/deliver context verb, mirroring the parser's `_KEYWORD_SIGNALS`
        # deliverables pattern (which requires `\d+\s*(reels?|...)`). The explicit
        # "deliverables"/"format" vocabulary still fires on its own.
        re.compile(
            r"deliverabl|format"
            r"|how many\b.*\b(reels?|stories|story|posts?|videos?|tiktoks?|shorts?)"
            r"|\b\d+\s*(reels?|stories|story|posts?|videos?|tiktoks?|shorts?)\b"
            r"|what.*(create|make|produce|deliver)",
            re.I,
        ),
        ("deliverables",),
    ),
    _SectionRule(
        "shipping_question",
        # Calvin follow-up §3.4: the STRONG shipping signals — an explicit ship /
        # shipping / tracking mention, a shipping-sense deliver(y) (not
        # "deliverables"), sending a product/sample, "when will it arrive", or
        # `address` WITH a shipping co-signal (ship/send/product/sample/deliver/
        # tracking). `deliver(y)?` as a bare stem also matched "deliverables"; it's
        # anchored to the shipping senses (delivery/delivered/delivering). This rule
        # is HIGH confidence.
        re.compile(
            r"ship|shipping|tracking|\bdeliver(y|ed|ing)?\b"
            r"|send.*(product|sample)|when.*arrive"
            r"|\baddress\b.*(ship|send|product|sample|deliver|tracking)"
            r"|(ship|send|product|sample|deliver|tracking).*\baddress\b",
            re.I,
        ),
        ("shipping",),
    ),
    _SectionRule(
        "shipping_address_bare",
        # Calvin follow-up §3.3: a BARE `address` with no shipping co-signal. In
        # negotiation this is as likely a contract/legal address as a shipping one
        # ("what's your address for the contract?"), so it is GREEDY → `low`
        # confidence. On its own it degrades to the caller's full-context fallback
        # rather than emitting a narrow (possibly wrong) shipping-only block; it is
        # only kept as a shipping match when the high-confidence shipping rule above
        # ALSO fires this turn.
        re.compile(r"\baddress\b", re.I),
        ("shipping",),
        True,  # greedy
    ),
    _SectionRule(
        "attribution_question",
        re.compile(r"attribut|cookie|tracking window|referral link|how long.*(sale|click|credit)", re.I),
        ("attributionWindow",),
    ),
)


# Obligation category (snake_case, from commitmentDetection.ts CATEGORY_KEYWORDS)
# → section keys (camelCase). NOT an identity function: `usage_rights` folds
# exclusivity + whitelist vocabulary into itself at the obligation layer
# (CATEGORY_KEYWORDS.usage_rights includes "exclusivity", "whitelist"), so it maps
# to TWO sections — reading both to resolve an ambiguously-worded usage/exclusivity
# commitment is strictly safer than guessing one (§4.1 / §4.4).
CATEGORY_TO_SECTIONS: dict[str, tuple[SectionKey, ...]] = {
    "usage_rights": ("usageRights", "exclusivity"),
    "payment": ("paymentTerms",),
    "shipping": ("shipping",),
    "timeline": ("timeline",),
    "deliverables": ("deliverables",),
}


# Broad-question detector (§4.5). A broad ask returns several sections; the cap
# (§4.8) keeps "everything" from degenerating into the whole-brief dump.
BROAD_QUESTION = re.compile(
    r"\b(everything|all|full|whole|complete|entire|overview|summar\w+|the terms?|the deal|"
    r"what.*(involved|expect))\b",
    re.I,
)

# The "core commercial" set a broad question widens to. `overview` / `shipping`
# are deliberately EXCLUDED — a creator asking "what are the terms?" wants
# commercial terms, not the shipping SOP; those enter only on a specific match.
# Order = priority when the cap bites (§4.8).
BROAD_SECTIONS: tuple[SectionKey, ...] = (
    "deliverables",
    "paymentTerms",
    "usageRights",
    "exclusivity",
    "timeline",
)


# ---------------------------------------------------------------------------
# Result types (§4.6 / §4.7 / §4.10)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Obligation:
    """The structured obligation the agent needs to route (§4.4). Threaded from the
    TS executor as {category, originalText, id}. `category` is snake_case (or None)."""

    original_text: str
    category: Optional[str] = None
    id: Optional[str] = None


@dataclass(frozen=True)
class AvailableSections:
    """The knowledge the router resolves values from (§4.9).

    `fields` — the flat campaign knowledge columns (usageRights / exclusivity /
      paymentTerms / attributionWindow / timeline / deliverables). AUTHORITATIVE,
      present on every campaign even with no brief PDF.
    `brief`  — projected from ParsedBrief.sections (parse_brief_structured). Missing
      per-key when a campaign has no brief / the parse failed / a section is absent.
    """

    fields: dict[str, str] = field(default_factory=dict)
    brief: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SourceRecord:
    """Why a section was selected + where its value resolved from (§4.10).

    Two provenance axes:
      trigger      — WHY it was selected: "message" | "obligation:<id>"
      rule         — the routing rule that fired (topic key / "obligation_category"
                     / "broad_question")
      resolved_from — WHERE the value came from: "campaign_field:<key>" |
                     "brief_section:<key>", or None when requested_but_unavailable.
    """

    section: SectionKey
    rule: str
    trigger: str
    resolved_from: Optional[str] = None


@dataclass(frozen=True)
class SelectedSection:
    """One selected section + its resolved value (or the honest-defer marker)."""

    section: SectionKey
    # "available" → value threaded; "requested_but_unavailable" → honest defer,
    # NO value (invariant #4).
    availability: Literal["available", "requested_but_unavailable"]
    value: Optional[str] = None
    resolved_from: Optional[str] = None


Outcome = Literal["matched", "broad", "no_match"]

# Calvin follow-up §3.3: coarse confidence in the SELECTION (not in any value).
#   "high" — a specific topic matched, a broad question fired, or an obligation
#            drove the pull → the caller trusts the selected sections.
#   "low"  — the ONLY thing that fired was a greedy/over-broad rule (bare
#            `address`) with no corroborating high-confidence match → the caller
#            degrades to the full-context fallback rather than a narrow block.
# no_match carries no confidence (it is its own outcome).
Confidence = Literal["high", "low"]


@dataclass(frozen=True)
class KnowledgeSelection:
    """The retrieval result (§4.6). `no_match` is a first-class outcome — the caller
    distinguishes "confidently nothing relevant" from "matched but value empty"."""

    outcome: Outcome
    sections: tuple[SelectedSection, ...] = ()
    sources: tuple[SourceRecord, ...] = ()
    # Selected-but-absent section keys (subset of `sections`), for observability.
    unavailable: tuple[SectionKey, ...] = ()
    # Sections dropped by the §4.8 cap — logged, never silent-truncated (invariant #7).
    dropped: tuple[SectionKey, ...] = ()
    # Calvin follow-up §3.3: "high" on a matched/broad selection the caller trusts;
    # "low" when only a greedy rule fired (→ full-context fallback). Always "high"
    # for `broad` and for obligation-driven pulls; "low" only when the sole trigger
    # was a greedy rule. Defaults "high" so existing constructors are unaffected.
    confidence: Confidence = "high"


# ---------------------------------------------------------------------------
# Internal selection bookkeeping
# ---------------------------------------------------------------------------


@dataclass
class _Candidate:
    """A section selected before resolution + cap. Carries its provenance so a
    section selected by both message and obligation keeps the higher-priority
    (obligation) provenance."""

    section: SectionKey
    rule: str
    trigger: str
    # True when first selected from an obligation — obligation-sourced sections win
    # the cap (we OWE those answers) and their provenance is preferred (§4.8).
    from_obligation: bool
    # Calvin follow-up §3.3: True when this candidate was selected ONLY via a greedy
    # rule (bare `address`). Cleared the moment a non-greedy selection touches the
    # same section — a corroborated match is high confidence.
    greedy_only: bool = False


def _match_message(text: str) -> list[tuple[SectionKey, str, bool]]:
    """Run every SECTION_MAP entry against `text`; return (section, topic, greedy) for
    each firing entry. Broad-question widening is handled by the caller."""
    hits: list[tuple[SectionKey, str, bool]] = []
    for rule in SECTION_MAP:
        if rule.test.search(text):
            for section in rule.sections:
                hits.append((section, rule.topic, rule.greedy))
    return hits


def _resolve_value(
    section: SectionKey, available: AvailableSections
) -> tuple[Optional[str], Optional[str]]:
    """Resolve a section's value (§4.7). Flat field is authoritative (invariant #1);
    brief section is the fallback source. Returns (value, resolved_from) — both None
    when neither exists → requested_but_unavailable.

    `attributionWindow` / flat-only keys never read from `brief` (they're not parser
    keys); the `available.brief` lookup simply misses for them, which is correct."""
    fields = available.fields
    val = fields.get(section)
    if isinstance(val, str) and val.strip():
        return val.strip(), f"campaign_field:{section}"
    brief_val = available.brief.get(section)
    if isinstance(brief_val, str) and brief_val.strip():
        return brief_val.strip(), f"brief_section:{section}"
    return None, None


def select_knowledge_sections(
    message: str,
    open_obligations: list[Obligation],
    available: AvailableSections,
) -> KnowledgeSelection:
    """Select the campaign-knowledge sections relevant to this turn (§4).

    Pure, deterministic, no model call. Union of:
      • message-derived sections (SECTION_MAP over the normalized latest message),
      • broad-question widening (BROAD_SECTIONS when a broad ask fires and no
        specific section already dominates),
      • obligation-derived sections (CATEGORY_TO_SECTIONS, or SECTION_MAP over the
        obligation's originalText when it has no/unmapped category) — invariant #5.

    Then: cap at MAX_SELECTED_SECTIONS (obligation-sourced first), resolve each
    value (available vs requested_but_unavailable), and return an explicit outcome.
    Zero selected from message AND obligations → `no_match` (never `[]`)."""

    # Share the gates' normalization so the router sees the same text they do
    # (§4.3) — never raw untrusted bytes. Selection is not a security boundary
    # (the gates already ran in /classify); this just keeps behavior consistent.
    norm_message = normalize_untrusted_text(message or "")

    # section key → candidate, dedup keeping the highest-priority provenance.
    candidates: dict[SectionKey, _Candidate] = {}

    def add(
        section: SectionKey,
        rule: str,
        trigger: str,
        from_obligation: bool,
        greedy: bool = False,
    ) -> None:
        existing = candidates.get(section)
        if existing is None:
            candidates[section] = _Candidate(
                section, rule, trigger, from_obligation, greedy_only=greedy
            )
            return
        # Calvin follow-up §3.3: any NON-greedy selection touching this section
        # corroborates it → clear greedy_only regardless of which side wins the
        # provenance contest below (a section is greedy_only iff EVERY selection of
        # it was greedy).
        if not greedy:
            existing.greedy_only = False
        # An obligation-sourced selection outranks a message-sourced one for the
        # cap and for provenance (we owe the obligation answer). Otherwise keep the
        # first (message, in SECTION_MAP order).
        if from_obligation and not existing.from_obligation:
            candidates[section] = _Candidate(
                section,
                rule,
                trigger,
                from_obligation,
                # Preserve corroboration: the merged candidate is greedy_only only
                # if BOTH the incoming and the prior selection were greedy.
                greedy_only=greedy and existing.greedy_only,
            )

    # (1) Message-derived sections.
    message_hits = _match_message(norm_message)
    for section, topic, greedy in message_hits:
        add(section, topic, "message", from_obligation=False, greedy=greedy)

    # (2) Broad-question widening (§4.5). Fires only when a broad ask is present and
    # no *specific* section already dominates — a specific "when do I get paid?"
    # inside a broad-ish sentence shouldn't blow up to the whole commercial set.
    outcome_is_broad = False
    if BROAD_QUESTION.search(norm_message) and not message_hits:
        outcome_is_broad = True
        for section in BROAD_SECTIONS:
            add(section, "broad_question", "message", from_obligation=False)

    # (3) Obligation-derived sections (invariant #5). Non-terminal obligations only
    # (the caller feeds OPEN/DEFERRED/ESCALATED). Category → sections when mapped;
    # else route the obligation's own text through SECTION_MAP. Obligation pulls are
    # never greedy_only — we OWE that answer, so the selection is high confidence.
    for ob in open_obligations:
        trigger = f"obligation:{ob.id}" if ob.id else "obligation"
        cat = (ob.category or "").strip()
        mapped = CATEGORY_TO_SECTIONS.get(cat)
        if mapped:
            for section in mapped:
                add(section, "obligation_category", trigger, from_obligation=True)
        else:
            norm_ob = normalize_untrusted_text(ob.original_text or "")
            for section, topic, _greedy in _match_message(norm_ob):
                add(section, topic, trigger, from_obligation=True)

    # No message topic AND no obligation section → explicit no_match (invariant #3).
    if not candidates:
        return KnowledgeSelection(outcome="no_match")

    # (4) Cap (§4.8). Priority: obligation-sourced first (we owe those), then
    # message/broad in a stable order. Dropped sections are recorded (invariant #7).
    ordered = _apply_cap(candidates)
    kept = ordered[:MAX_SELECTED_SECTIONS]
    dropped = tuple(c.section for c in ordered[MAX_SELECTED_SECTIONS:])

    # (5) Resolve values + build the result (§4.7 / §4.10).
    selected: list[SelectedSection] = []
    sources: list[SourceRecord] = []
    unavailable: list[SectionKey] = []
    for cand in kept:
        value, resolved_from = _resolve_value(cand.section, available)
        if value is not None:
            selected.append(
                SelectedSection(cand.section, "available", value, resolved_from)
            )
        else:
            selected.append(
                SelectedSection(cand.section, "requested_but_unavailable", None, None)
            )
            unavailable.append(cand.section)
        sources.append(
            SourceRecord(cand.section, cand.rule, cand.trigger, resolved_from)
        )

    outcome: Outcome = "broad" if outcome_is_broad else "matched"
    # Calvin follow-up §3.3: the selection is `low` confidence only when EVERY kept
    # candidate fired solely on a greedy rule (bare `address`) — i.e. nothing
    # corroborated it. A broad question is high confidence by construction, and any
    # non-greedy or obligation-sourced candidate makes the whole selection high. The
    # caller degrades a `low` selection to the full-context fallback (§3.2).
    confidence: Confidence = "high"
    if not outcome_is_broad and kept and all(c.greedy_only for c in kept):
        confidence = "low"
    return KnowledgeSelection(
        outcome=outcome,
        sections=tuple(selected),
        sources=tuple(sources),
        unavailable=tuple(unavailable),
        dropped=dropped,
        confidence=confidence,
    )


def _apply_cap(candidates: dict[SectionKey, _Candidate]) -> list[_Candidate]:
    """Order candidates by cap priority (§4.8): obligation-sourced first (we owe
    those answers), then message/broad-sourced. Within each group, preserve a
    stable, deterministic order (SECTION_KEYS order) so the drop set is reproducible
    turn-to-turn and testable."""
    key_order = {k: i for i, k in enumerate(SECTION_KEYS)}
    return sorted(
        candidates.values(),
        key=lambda c: (0 if c.from_obligation else 1, key_order.get(c.section, 99)),
    )

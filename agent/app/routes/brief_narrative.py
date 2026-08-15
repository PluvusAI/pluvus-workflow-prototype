"""PLU-139 §3 — POST /brief-narrative: optional AI intro/summary prose for a
rendered CampaignBrief.

A deliberately narrow sibling to /negotiate, not a reuse of it: this needs
none of that route's multi-turn reasoning or tool calls — one short,
stateless prompt in, two short strings out ({introduction, summary}). The
prompt is scoped tightly enough (tone/framing only, explicitly never asked
for a number, date, or obligation) that the post-generation guard below (a
blunt figure/obligation-verb strip, same shape as summarize.py's money-figure
guard) is a reasonable safeguard — a general-purpose negotiation response
would be much harder to bound this way.

Fail-soft by design: the TS caller (server/src/ai/campaignBriefNarrative.ts)
already has a deterministic default it falls back to on ANY failure (timeout,
non-2xx, malformed body) — so this route degrades to a 200 with `ok: false`
rather than a 5xx wherever possible, and the guard strips rather than
rejects outright, matching summarize.py's own posture.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.llm import get_llm
from app.security import rate_limiter, require_api_key
from app.telemetry import capture_llm_calls, set_active_prompt_version, usage_payload

router = APIRouter()
logger = logging.getLogger(__name__)

_BRIEF_NARRATIVE_PROMPT_VERSION = "brief-narrative-v1.0"

# Same guard shape as summarize.py's _MONEY_RE — a currency figure or percent
# has no business coming from prose here; every material number belongs to
# the deterministic template sections, never the AI narrative.
_MONEY_RE = re.compile(r"(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)")
# Obligation-shaped verbs — the narrative may describe the opportunity, it
# may never itself commit the brand to anything ("we guarantee," "we will
# pay," "you must").
_OBLIGATION_RE = re.compile(
    r"\b(guarantee[sd]?|promise[sd]?|will pay|must|shall|commit(?:s|ted)?)\b",
    re.IGNORECASE,
)


class BriefNarrativeRequest(BaseModel):
    campaignName: str
    brand: str
    campaignTypeLabel: str  # e.g. "paid partnership", "affiliate", "gifted product"
    objective: str | None = None
    productOrOffer: str | None = None
    keyMessages: str | None = None


class BriefNarrativeResponse(BaseModel):
    ok: bool
    introduction: str | None = None
    summary: str | None = None
    version: str = _BRIEF_NARRATIVE_PROMPT_VERSION
    llmUsage: dict | None = None


_BRIEF_NARRATIVE_PROMPT = """Write a short, warm introduction and a one-line summary \
for a campaign brief document a brand is sending to a creator.

Campaign: {campaign_name} ({brand})
Type: {campaign_type_label}
Objective: {objective}
Product/offer: {product_or_offer}
Key messages: {key_messages}

STRICT RULES:
- Do NOT state any dollar amount, percentage, or other figure — compensation \
terms are shown elsewhere in the document verbatim; never restate or imply one.
- Do NOT promise, guarantee, or commit the brand to anything ("we guarantee," \
"you will receive," "we promise"). Describe the opportunity, don't obligate it.
- Do NOT invent facts not present above.
- Keep the introduction to 2-3 sentences and the summary to one sentence.

Respond with EXACTLY two lines, nothing else:
INTRO: <the introduction>
SUMMARY: <the one-line summary>
"""


def _guard(text: str) -> str | None:
    """Reject (return None) if the text contains a figure or an obligation verb —
    a blunt, conservative filter, not an attempt at semantic validation. Unlike
    summarize.py's guard (which strips and keeps going, since a summary is
    mandatory), a brief's AI narrative is OPTIONAL — the caller already has a
    deterministic default, so failing this check should fall back to it rather
    than publish a scrubbed, possibly-mangled sentence into a brand-facing
    document."""
    if _MONEY_RE.search(text) or _OBLIGATION_RE.search(text):
        return None
    return text


def _parse_response(text: str) -> tuple[str, str] | None:
    intro_match = re.search(r"INTRO:\s*(.+)", text)
    summary_match = re.search(r"SUMMARY:\s*(.+)", text)
    if not intro_match or not summary_match:
        return None
    return intro_match.group(1).strip(), summary_match.group(1).strip()


@router.post(
    "/brief-narrative",
    response_model=BriefNarrativeResponse,
    dependencies=[Depends(require_api_key), Depends(rate_limiter("brief-narrative"))],
)
def brief_narrative(req: BriefNarrativeRequest) -> BriefNarrativeResponse:
    prompt = _BRIEF_NARRATIVE_PROMPT.format(
        campaign_name=req.campaignName,
        brand=req.brand,
        campaign_type_label=req.campaignTypeLabel,
        objective=req.objective or "(not specified)",
        product_or_offer=req.productOrOffer or "(not specified)",
        key_messages=req.keyMessages or "(not specified)",
    )
    set_active_prompt_version(_BRIEF_NARRATIVE_PROMPT_VERSION)
    try:
        with capture_llm_calls() as calls:
            result = get_llm(temperature=0.4, role="brief_narrative").invoke(prompt)
        raw = (getattr(result, "content", "") or "").strip()
        parsed = _parse_response(raw)
        if parsed is None:
            logger.warning("brief-narrative: malformed response, falling back")
            return BriefNarrativeResponse(ok=False, llmUsage=usage_payload(calls))

        introduction, summary = parsed
        introduction = _guard(introduction)
        summary = _guard(summary)
        if introduction is None or summary is None:
            logger.warning("brief-narrative: guard rejected response, falling back")
            return BriefNarrativeResponse(ok=False, llmUsage=usage_payload(calls))

        return BriefNarrativeResponse(
            ok=True,
            introduction=introduction,
            summary=summary,
            llmUsage=usage_payload(calls),
        )
    except Exception:
        # Best-effort, same posture as summarize.py: the caller always has a
        # deterministic fallback, so this route never 5xx's the brief render.
        logger.exception("brief-narrative failed; caller will use its default")
        return BriefNarrativeResponse(ok=False, llmUsage=usage_payload([]))
    finally:
        set_active_prompt_version(None)

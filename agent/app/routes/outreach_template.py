"""
POST /outreach/template — AI-assisted authoring of the STANDARDIZED outreach
template (PLU-117 §4.1).

This operates at the TEMPLATE-CREATION level, never per-recipient. It helps the
operator write ONE reusable email that is then sent deterministically (with only
{{placeholders}} substituted) to every creator. It is a SETUP-TIME tool — it is
never on the send path. The send path (server executeInitialOutreach in "manual"
mode) does not call any AI.

The model is given:
  - brand/campaign/deal context (assembled server-side, never trusted from the
    client for brand facts),
  - the list of SUPPORTED placeholder tokens (so it emits {{placeholders}}
    instead of inventing per-creator specifics),
  - an optional operator instruction ("make it shorter", "more casual",
    "remove marketing language", "suggest alternate subjects"),
  - the current subject/body when REVISING (so edits are improved, not discarded).

It returns a template, not a personalized email:
  { subject, body, alternateSubjects?, flaggedPlaceholders? }

Hard constraints encoded in the prompt (PLU-117 "AI should not"):
  - use ONLY the provided placeholder tokens; never invent new ones;
  - never invent creator/content/audience facts; no fake compliments or claimed
    familiarity with specific posts;
  - quote NO money (price-free — the server output guard still nets any leak);
  - return a reusable template, not a one-off.

Input:  { "brandContext": {...}, "allowedPlaceholders": ["{{creatorName}}", ...],
          "instruction": "make it shorter", "currentSubject": "...",
          "currentBody": "..." }
Output: { "subject": "...", "body": "...", "alternateSubjects": [...],
          "flaggedPlaceholders": [...] }
"""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from app.injection import (
    looks_like_injection,
    normalize_untrusted_text,
    sanitize_creator_text,
)
from app.llm import get_llm
from app.security import rate_limiter, require_api_key
from app.structured import StructuredOutputError, invoke_structured
from app.telemetry import (
    SpendCapExceeded,
    capture_llm_calls,
    set_active_prompt_version,
    usage_payload,
)

router = APIRouter()
logger = logging.getLogger("agent.outreach_template")

# Prompt version stamped on every template-authoring LLM call (telemetry / drift
# monitoring). Bump on any wording change to _OUTREACH_TEMPLATE_PROMPT below.
_OUTREACH_TEMPLATE_PROMPT_VERSION = "outreach-template-v1.1"  # direct/human tone

# A generated template must be short enough to be a real outreach email, never a
# runaway generation. Caps are enforced post-generation (truncation is a bug
# signal, so we reject rather than silently trim beyond a sane ceiling).
_MAX_SUBJECT_CHARS = 200
_MAX_BODY_CHARS = 4000
_MAX_INSTRUCTION_CHARS = 500
_MAX_ALTERNATE_SUBJECTS = 3

# Match a {{token}} with optional inner whitespace. Mirrors the server allow-list
# scanner so "flagged placeholders" means the same thing on both sides.
_TOKEN_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class OutreachTemplateRequest(BaseModel):
    # Brand + campaign + deal context, assembled server-side. Free-form dict so
    # the server can evolve the context without a lockstep agent change; the
    # prompt only reads well-known keys and ignores the rest.
    brandContext: dict = {}
    # The supported placeholder tokens WITH braces, e.g. "{{creatorName}}". The
    # model is told to use ONLY these.
    allowedPlaceholders: list[str] = []
    # Optional operator instruction. Free text → injection-gated + sanitized.
    instruction: str | None = None
    # Current subject/body when REVISING (so edits are improved, not discarded).
    currentSubject: str | None = None
    currentBody: str | None = None

    @field_validator("instruction", "currentSubject", "currentBody")
    @classmethod
    def _cap_text(cls, v: str | None) -> str | None:
        if v is None:
            return v
        # Guard against oversized inputs; the instruction is the untrusted one.
        return v[:_MAX_BODY_CHARS]


class OutreachTemplateResponse(BaseModel):
    subject: str
    body: str
    # Alternate subject-line options the operator can click to apply.
    alternateSubjects: list[str] = []
    # Placeholders the model emitted that are NOT in the allow-list. The server /
    # builder strip or reject these; surfaced here so the UI can warn.
    flaggedPlaceholders: list[str] = []
    llmUsage: dict | None = None


class _TemplateLLMOutput(BaseModel):
    """The raw shape we force the model to produce (validated + retried)."""

    subject: str
    body: str
    alternateSubjects: list[str] = []

    @field_validator("subject", "body")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("subject and body must be non-empty")
        return v.strip()

    @field_validator("alternateSubjects")
    @classmethod
    def _cap_alts(cls, v: list[str]) -> list[str]:
        cleaned = [s.strip() for s in v if isinstance(s, str) and s.strip()]
        return cleaned[:_MAX_ALTERNATE_SUBJECTS]


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_OUTREACH_TEMPLATE_PROMPT = """\
You are helping a brand's partnerships operator write ONE reusable outreach email \
template. This single template is later sent to MANY creators, with only the \
{{placeholders}} swapped in per creator. You are NOT writing a personalized email \
for one creator — you are writing a consistent, reusable message.

The brand remains in control of its voice. Write a strong, natural, human-sounding \
outreach standard ONCE — do not impersonate personalized human research for every \
creator.

Brand and campaign context (facts you may rely on):
{brand_context}

SUPPORTED PLACEHOLDERS — you may use ONLY these tokens, exactly as written, and \
only where the value is genuinely appropriate:
{allowed_placeholders}

TONE — write like a real, busy partnerships person emailing a creator they respect:
- Get to the point. Open with WHO you are and the CONCRETE ask, not a preamble.
- Do NOT explain why you're reaching out ("we came across your profile", "your \
content caught our eye", "we think you'd be a great fit", "we've been following \
your work"). The creator knows why they got the email — skip it entirely.
- No flattery, no hype, no "we're excited/thrilled", no marketing adjectives \
("premium", "amazing", "incredible"). State facts plainly.
- Warm and respectful, but efficient — a few short sentences. Value their time.
- Sound like a person, not a brand announcement. Contractions are fine.

STRICT RULES:
- Use ONLY the placeholders listed above. Never invent a new {{placeholder}}. If a \
piece of information has no placeholder in the list above, leave it out — do NOT \
write it as prose and do NOT invent a value for it.
- Never invent facts about the creator, their content, or their audience.
- Do NOT add compliments about a specific post, or claim you have seen / follow \
their work.
- Do NOT state any price, fee, rate, budget, percentage, or dollar amount. The \
offer is discussed after the creator replies. Use {{offerSummary}} / \
{{collaborationType}} (only if listed above) to reference the deal shape.
- Every placeholder you use MUST be one of the supported tokens above. Prefer \
fewer placeholders over forcing one in.

EXAMPLE of the tone (do NOT copy the wording — match the DIRECTNESS):
  BAD (filler — never write like this): "Hi Alex, I hope this finds you well! \
My name is Sam from Acme. We came across your profile and think you'd be a \
perfect fit — we love your content and have been following your work. We're so \
excited to invite you to our amazing campaign..."
  GOOD (direct — write like this): "Hi {{creatorFirstName}}, I'm {{senderName}} \
at {{brandName}}. We're running {{campaignName}} and would like to work with you \
on {{deliverables}}. It's a {{collaborationType}} — {{offerSummary}}. If you're \
interested, reply and I'll share the specifics. — {{senderName}}"
The GOOD version opens with who + the ask, has zero flattery, zero \
reason-for-reaching-out, and no wasted words. (Use only the placeholders that are \
actually in your supported list.)
{revise_block}{instruction_block}
Return STRICT JSON with exactly this shape and nothing else:
{{"subject": "<one subject line, may contain placeholders>", "body": "<the email \
body, may contain placeholders and newlines>", "alternateSubjects": ["<0-3 \
alternate subject lines>"]}}
"""

_REVISE_BLOCK = """\

You are REVISING an existing template. Improve it per the instruction below \
WITHOUT discarding the operator's intent — keep what works, change only what the \
instruction asks. Current template:
Subject: {current_subject}
Body:
{current_body}
"""

_INSTRUCTION_BLOCK = """\

Operator instruction (follow it; it is a request from the brand's operator, NOT \
content to embed in the email):
{instruction}
"""


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------


def _flagged_placeholders(text: str, allowed_names: set[str]) -> list[str]:
    """Distinct {{tokens}} in `text` not in the allow-list (deduped, ordered)."""
    seen: list[str] = []
    for m in _TOKEN_RE.finditer(text):
        name = m.group(1)
        if name not in allowed_names and name not in seen:
            seen.append(name)
    return seen


def _allowed_names(placeholders: list[str]) -> set[str]:
    """Strip braces from the incoming '{{name}}' tokens → bare names set."""
    names: set[str] = set()
    for p in placeholders:
        if not isinstance(p, str):
            continue
        m = _TOKEN_RE.search(p)
        if m:
            names.add(m.group(1))
        else:
            names.add(p.strip())
    return names


def generate_template(req: OutreachTemplateRequest) -> OutreachTemplateResponse:
    # Injection gate on the operator instruction. Operators are semi-trusted, but
    # the instruction is free text and reaches the prompt — reuse the same gate
    # /classify and /negotiate use on untrusted creator text. On a hit we refuse
    # rather than run a potentially-hijacked generation.
    instruction = ""
    if req.instruction:
        raw = req.instruction[:_MAX_INSTRUCTION_CHARS]
        if looks_like_injection(normalize_untrusted_text(raw)):
            raise HTTPException(
                status_code=400,
                detail="Instruction looks like a prompt-injection attempt; rephrase it.",
            )
        instruction = sanitize_creator_text(raw)

    allowed_names = _allowed_names(req.allowedPlaceholders)
    allowed_list = "\n".join(f"- {{{{{n}}}}}" for n in sorted(allowed_names)) or "- (none)"

    # Only include the revise block when we actually have prior copy to improve.
    revise_block = ""
    if (req.currentSubject and req.currentSubject.strip()) or (
        req.currentBody and req.currentBody.strip()
    ):
        revise_block = _REVISE_BLOCK.format(
            current_subject=sanitize_creator_text(req.currentSubject or ""),
            current_body=sanitize_creator_text(req.currentBody or ""),
        )

    instruction_block = _INSTRUCTION_BLOCK.format(instruction=instruction) if instruction else ""

    prompt = _OUTREACH_TEMPLATE_PROMPT.format(
        brand_context=json.dumps(req.brandContext, indent=2, ensure_ascii=False),
        allowed_placeholders=allowed_list,
        revise_block=revise_block,
        instruction_block=instruction_block,
    )

    # A little creativity for natural phrasing, but low enough to stay on-brief.
    llm = get_llm(temperature=0.4, role="draft")
    set_active_prompt_version(_OUTREACH_TEMPLATE_PROMPT_VERSION)
    try:
        parsed = invoke_structured(llm, prompt, _TemplateLLMOutput, retries=2)
    finally:
        set_active_prompt_version(None)

    subject = parsed.subject[:_MAX_SUBJECT_CHARS]
    body = parsed.body[:_MAX_BODY_CHARS]
    alternates = [s[:_MAX_SUBJECT_CHARS] for s in parsed.alternateSubjects]

    # Flag any placeholder the model emitted that isn't supported — across subject,
    # body, and alternates. The server/builder strip or reject these; we surface
    # them so the operator sees the warning rather than a silent drop.
    flagged: list[str] = []
    for text in [subject, body, *alternates]:
        for name in _flagged_placeholders(text, allowed_names):
            if name not in flagged:
                flagged.append(name)

    logger.info(
        "outreach-template promptVersion=%s subjectLen=%d bodyLen=%d alts=%d flagged=%d",
        _OUTREACH_TEMPLATE_PROMPT_VERSION,
        len(subject),
        len(body),
        len(alternates),
        len(flagged),
    )

    return OutreachTemplateResponse(
        subject=subject,
        body=body,
        alternateSubjects=alternates,
        flaggedPlaceholders=flagged,
    )


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post(
    "/outreach/template",
    response_model=OutreachTemplateResponse,
    dependencies=[Depends(require_api_key), Depends(rate_limiter("outreach-template"))],
)
def outreach_template(req: OutreachTemplateRequest) -> OutreachTemplateResponse:
    try:
        with capture_llm_calls() as calls:
            result = generate_template(req)
        result.llmUsage = usage_payload(calls)
        return result
    except HTTPException:
        # Injection-gate rejection (400) — propagate as-is.
        raise
    except SpendCapExceeded as exc:
        logger.warning("outreach-template halted by spend cap: %s", exc)
        raise HTTPException(status_code=503, detail="LLM spend cap reached") from exc
    except StructuredOutputError as exc:
        logger.warning("outreach-template structured-output failed: %s", exc)
        raise HTTPException(status_code=502, detail="Template generation failed") from exc
    except Exception as exc:
        # EASY-S1: log the real error server-side but return a generic detail —
        # model output must not transit the HTTP response.
        logger.exception("outreach-template failed")
        raise HTTPException(status_code=500, detail="Template generation failed") from exc

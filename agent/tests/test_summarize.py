"""PLU-112 — /summarize guard + idempotency tests.

The money-figure guard and the empty-delta no-op are deterministic (no LLM), so
they are unit-testable without a model. The narrative generation itself is exercised
by the live harness, not here.
"""

from app.routes.summarize import (
    SummarizeHistoryEntry,
    SummarizeRequest,
    _guard_summary,
    _render_delta,
    summarize,
)


def test_guard_strips_invented_dollar_figure():
    # $750 is NOT in the source → the guard removes it.
    out = _guard_summary("We offered $750 and they hesitated.", "they hesitated on the fee")
    assert "$750" not in out


def test_guard_strips_invented_percentage():
    out = _guard_summary("They wanted 15% commission.", "they asked about commission")
    assert "15%" not in out


def test_guard_strips_even_a_source_faithful_figure():
    # Regression (live-Ollama finding): the summary is strictly figure-free. Even a
    # figure the creator actually said — here $500 is in the source — is removed,
    # because rates/percentages are owned by events/obligations/memory, never the
    # narrative summary. This is the stricter "no figures at all" contract.
    out = _guard_summary("We held at $500.", "we said $500 is our rate")
    assert "$500" not in out
    assert "$" not in out


def test_guard_strips_every_figure_when_several_appear():
    out = _guard_summary(
        "We started at $400, they wanted $650, and asked for 10% on top.",
        "the creator mentioned $650 and 10%",
    )
    assert "$400" not in out and "$650" not in out and "10%" not in out


def test_guard_collapses_whitespace_left_by_a_removed_figure():
    # Regression (live-Ollama finding): stripping a mid-sentence figure must not
    # leave a visible double-space hole ("offer of  stating") or a space before
    # punctuation.
    out = _guard_summary("They pushed back on the offer of $400 and hesitated.", "src")
    assert "  " not in out  # no double space
    assert " ." not in out and " ," not in out  # no space stranded before punctuation
    assert "$400" not in out


def test_guard_leaves_narrative_without_figures_untouched():
    text = "The creator was enthusiastic and asked for more detail on timing."
    assert _guard_summary(text, "some source") == text


def test_render_delta_sanitizes_creator_and_labels_sides():
    rendered = _render_delta([
        SummarizeHistoryEntry(role="creator", message="hi there"),
        SummarizeHistoryEntry(role="us", message="thanks for the reply"),
    ])
    assert "[creator]" in rendered
    assert "[us]" in rendered


def test_empty_delta_is_a_noop_and_echoes_prior_summary():
    # No new turns → the route returns the prior text WITHOUT calling the model.
    resp = summarize(SummarizeRequest(priorSummary="prior arc", delta=[]))
    assert resp.text == "prior arc"


def test_all_blank_delta_messages_are_a_noop():
    resp = summarize(SummarizeRequest(
        priorSummary="keep me",
        delta=[SummarizeHistoryEntry(role="creator", message="  ")],
    ))
    assert resp.text == "keep me"

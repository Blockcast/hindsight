"""Blockcast (BLO-7608, from 11b41c033): the retain context is capped before the extraction prompt."""

from hindsight_api.engine.retain.fact_extraction import MAX_RETAIN_CONTEXT_CHARS, _build_user_message


def test_retain_fact_prompt_truncates_large_context_before_llm_call():
    message = _build_user_message(
        chunk="short content",
        chunk_index=0,
        total_chunks=1,
        event_date=None,
        context="x" * 200_000,
    )

    assert len(message) < MAX_RETAIN_CONTEXT_CHARS + 1_000
    assert "truncated context: 188000 chars omitted" in message


def test_retain_fact_prompt_keeps_small_context_verbatim():
    message = _build_user_message(
        chunk="short content", chunk_index=0, total_chunks=1, event_date=None, context="ctx-123"
    )

    assert "ctx-123" in message
    assert "truncated context" not in message

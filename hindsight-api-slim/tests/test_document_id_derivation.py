"""
Unit tests for the content-derived document_id helper.

Pure-function tests (no DB / models / LLM) covering the deterministic id used as
the fallback when a caller supplies no explicit document_id. The end-to-end
idempotency behaviour is covered by
tests/test_document_tracking.py::test_no_document_id_is_content_derived_and_idempotent.
"""

import uuid

from hindsight_api.engine.retain.orchestrator import (
    _DOCUMENT_ID_NAMESPACE,
    _derive_document_id,
)


def test_same_content_and_context_yields_same_id():
    a = _derive_document_id([{"content": "Alice works at Google.", "context": "sync"}])
    b = _derive_document_id([{"content": "Alice works at Google.", "context": "sync"}])
    assert a == b


def test_different_content_yields_different_id():
    a = _derive_document_id([{"content": "Alice works at Google.", "context": "sync"}])
    b = _derive_document_id([{"content": "Bob works at Microsoft.", "context": "sync"}])
    assert a != b


def test_different_context_yields_different_id():
    """Namespacing: identical content under a different context is a distinct id."""
    a = _derive_document_id([{"content": "Same body text.", "context": "conversation-1"}])
    b = _derive_document_id([{"content": "Same body text.", "context": "conversation-2"}])
    assert a != b


def test_missing_context_is_stable():
    """Absent context must not raise and must be deterministic."""
    a = _derive_document_id([{"content": "No context here."}])
    b = _derive_document_id([{"content": "No context here."}])
    assert a == b


def test_id_is_a_uuid5_string():
    """Derived id keeps the 36-char uuid shape of the historical uuid4 ids."""
    derived = _derive_document_id([{"content": "Some content.", "context": "ctx"}])
    parsed = uuid.UUID(derived)
    assert parsed.version == 5
    assert str(parsed) == derived


def test_multi_item_batch_combines_all_items():
    """A multi-item batch hashes the combined content, distinct from one item."""
    combined = _derive_document_id(
        [
            {"content": "First part.", "context": "ctx"},
            {"content": "Second part.", "context": "ctx"},
        ]
    )
    single = _derive_document_id([{"content": "First part.", "context": "ctx"}])
    assert combined != single


def test_namespace_constant_is_fixed():
    """Guard against accidental edits to the id namespace (would orphan all ids)."""
    assert _DOCUMENT_ID_NAMESPACE == uuid.UUID("a3f2e1d0-7c4b-5a69-b8e2-1f0c9d6a4b73")

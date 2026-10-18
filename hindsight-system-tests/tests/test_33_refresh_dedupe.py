"""Asking for the same refresh twice runs it once.

A mental-model refresh is expensive — it drives the whole reflect loop — and the
requests arrive from several directions at once: a scheduled sweep, a
consolidation that finished, an impatient caller. Without deduplication a busy
bank queues one refresh per trigger and the worker spends its time recomputing
the same answer, which is how a slow-draining bank accumulated ~45 copies of one
model (#3487).

Worse than the cost: two refreshes of one model racing each other both read the
bank and both write, and the one that finishes second wins regardless of which
read more.
"""

from __future__ import annotations

import pytest

from hindsight_system_tests import reflect_loop
from hindsight_system_tests.payloads import consolidation, extracted, fact

pytestmark = pytest.mark.asyncio

ANSWER = "Alice lives in Berlin."


@pytest.fixture
async def model(client, llm, bank_id, settled) -> str:
    llm.on_step("extract_facts").returns(
        extracted(fact("Alice moved to Berlin", who="Alice", entities=["Alice", "Berlin"]))
    )
    llm.on_step("consolidate").returns(consolidation())
    reflect_loop(llm, answer=ANSWER)

    await client.aretain(bank_id=bank_id, content="Alice moved to Berlin.")
    await settled(bank_id)

    created = await client.mental_models.create_mental_model(
        bank_id, {"name": "Housing", "source_query": "Where does Alice live?"}
    )
    await settled(bank_id)
    return created.mental_model_id


async def _pending_refreshes(client, bank_id) -> int:
    page = await client.operations.list_operations(bank_id, type="refresh_mental_model", status="pending", limit=100)
    return page.total


async def test_two_requests_in_flight_share_one_operation(client, bank_id, model):
    """Back to back, no wait between them. The second joins the first rather than
    queueing a rival — the caller gets an operation id either way, and it is the
    same id.

    The join only holds while the first is still *pending*. An explicit refresh
    deliberately does not fold into one already running — that run may have read
    its inputs before the caller's edit — so if the worker claimed the first in the
    gap, a second operation is the contract, not a leak (BLO-47321)."""
    first = await client.mental_models.refresh_mental_model(bank_id, model)
    second = await client.mental_models.refresh_mental_model(bank_id, model)

    if second.operation_id != first.operation_id:
        status = await client.operations.get_operation_status(bank_id, first.operation_id)
        assert status.status != "pending", "a second refresh was queued beside one that had not started"


async def test_the_bank_does_not_accumulate_a_refresh_per_request(client, bank_id, model, settled):
    """The #3487 shape. Five requests, and the queue must not grow five deep.

    "Queue" is the pending set: at most one unstarted refresh per model, whatever
    the worker's claim latency. Counting *all* operations instead measured how fast
    the worker drained them — a worker that claims within ~20ms turns five requests
    into several runs, each correctly started after the previous left pending
    (BLO-47321)."""
    for _ in range(5):
        await client.mental_models.refresh_mental_model(bank_id, model)
        pending = await _pending_refreshes(client, bank_id)
        assert pending <= 1, f"{pending} refreshes queued for one model"
    await settled(bank_id)


async def test_the_model_still_ends_up_refreshed(client, bank_id, model, settled):
    """Deduplication must not swallow the work — collapsing to zero refreshes
    would look identical from the queue's point of view."""
    for _ in range(3):
        await client.mental_models.refresh_mental_model(bank_id, model)
    await settled(bank_id)

    current = await client.mental_models.get_mental_model(bank_id, model, detail="full")
    assert current.content.strip() == ANSWER
    assert current.is_stale is False

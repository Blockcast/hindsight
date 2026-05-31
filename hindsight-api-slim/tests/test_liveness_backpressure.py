import asyncio

import pytest

from hindsight_api.engine.memory_engine import MemoryEngine
from hindsight_api.engine.providers.openai_compatible_llm import _retry_after_seconds
from hindsight_api.engine.retain.fact_extraction import MAX_RETAIN_CONTEXT_CHARS, _build_user_message


class _SlowAcquire:
    async def __aenter__(self):
        await asyncio.sleep(10)

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _SlowBackend:
    def acquire(self):
        return _SlowAcquire()


class _Response:
    def __init__(self, headers):
        self.headers = headers


class _StatusError:
    def __init__(self, headers):
        self.response = _Response(headers)


@pytest.mark.asyncio
async def test_health_check_degrades_quickly_when_db_acquire_is_stalled(monkeypatch):
    memory = object.__new__(MemoryEngine)
    memory._initialized = True

    async def get_backend():
        return _SlowBackend()

    monkeypatch.setattr(memory, "_get_backend", get_backend)
    monkeypatch.setattr(MemoryEngine, "HEALTH_CHECK_DATABASE_TIMEOUT_SECONDS", 0.01)

    health = await memory.health_check()

    assert health == {
        "status": "healthy",
        "database": "timeout",
        "degraded": True,
        "reason": "database_health_check_timeout",
    }


def test_retain_fact_prompt_truncates_large_context_before_llm_call():
    message = _build_user_message(
        chunk="short content",
        chunk_index=0,
        total_chunks=1,
        event_date=None,
        context="x" * 200_000,
    )

    assert len(message) < MAX_RETAIN_CONTEXT_CHARS + 1_000
    assert "truncated" in message


def test_retry_after_seconds_honors_provider_cooldown_without_exceeding_cap():
    error = _StatusError({"retry-after": "30"})

    assert _retry_after_seconds(error, max_backoff=10) == 10

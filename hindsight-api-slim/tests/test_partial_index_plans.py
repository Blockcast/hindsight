"""
Tests for the two query shapes that lost their index in production (2026-09-03).

1. Bank-scoped ANN retrieval must run under a *custom* plan, so the planner can
   prove the per-bank partial index predicate from the actual ``bank_id`` value.
2. ``fetch_unit_dates`` must cast the *parameter* to uuid[], never the indexed
   ``id`` column, so the primary-key index serves the lookup.

Both are pure unit tests — no database required.
"""

from typing import Any

import pytest

from hindsight_api.engine.db.ops_postgresql import PostgreSQLOps
from hindsight_api.engine.search.retrieval import _fetch_with_per_bank_index_plan


class _RecordingConn:
    """Minimal DatabaseConnection stand-in that records the SQL it is handed."""

    def __init__(self, backend_type: str = "postgresql") -> None:
        self._backend_type = backend_type
        self.executed: list[str] = []
        self.fetched: list[tuple[str, tuple[Any, ...]]] = []
        self.transaction_depth = 0
        self.opened_transaction = False

    @property
    def backend_type(self) -> str:
        return self._backend_type

    def transaction(self):
        conn = self

        class _Ctx:
            async def __aenter__(self):
                conn.transaction_depth += 1
                conn.opened_transaction = True
                return conn

            async def __aexit__(self, *exc):
                conn.transaction_depth -= 1
                return False

        return _Ctx()

    async def execute(self, query: str, *args: Any, timeout: float | None = None) -> str:
        # A SET must land inside the transaction, or SET LOCAL is a silent no-op.
        assert self.transaction_depth > 0, "SET LOCAL issued outside a transaction"
        self.executed.append(query)
        return "SET"

    async def fetch(self, query: str, *args: Any, timeout: float | None = None) -> list:
        self.fetched.append((query, args))
        return []


class _RawAsyncpgConn(_RecordingConn):
    """Raw asyncpg shape: no ``backend_type``, and ``transaction()`` yields a
    Transaction object rather than the connection.

    The recall path passes a raw asyncpg connection (acquire_with_retry accepts a
    raw asyncpg.Pool), so the helper must not touch ``conn.backend_type`` nor use
    whatever ``transaction()`` yields.
    """

    def __init__(self) -> None:
        super().__init__(backend_type="postgresql")
        del self._backend_type  # no such attribute on a raw asyncpg connection

    @property
    def backend_type(self):  # pragma: no cover - must never be reached
        raise AttributeError("'Connection' object has no attribute 'backend_type'")

    def transaction(self):
        conn = self

        class _Tx:
            """asyncpg.Transaction — deliberately has no fetch/execute."""

        class _Ctx:
            async def __aenter__(self):
                conn.transaction_depth += 1
                conn.opened_transaction = True
                return _Tx()

            async def __aexit__(self, *exc):
                conn.transaction_depth -= 1
                return False

        return _Ctx()


# ---------------------------------------------------------------------------
# 1. Bank-scoped ANN retrieval — force_custom_plan
# ---------------------------------------------------------------------------


class TestPerBankIndexPlan:
    @pytest.mark.asyncio
    async def test_postgres_forces_custom_plan_before_fetch(self):
        conn = _RecordingConn("postgresql")

        await _fetch_with_per_bank_index_plan(conn, "SELECT 1 WHERE bank_id = $1", "bank-a")

        assert conn.executed == ["SET LOCAL plan_cache_mode = force_custom_plan"]
        assert conn.opened_transaction, "custom plan must be scoped by a transaction"
        assert conn.fetched == [("SELECT 1 WHERE bank_id = $1", ("bank-a",))]

    @pytest.mark.asyncio
    async def test_set_local_precedes_the_query(self):
        """The SET is worthless after the statement it is meant to plan."""
        conn = _RecordingConn("postgresql")
        order: list[str] = []

        orig_execute, orig_fetch = conn.execute, conn.fetch

        async def tracked_execute(query: str, *a: Any, **kw: Any):
            order.append("set")
            return await orig_execute(query, *a, **kw)

        async def tracked_fetch(query: str, *a: Any, **kw: Any):
            order.append("fetch")
            return await orig_fetch(query, *a, **kw)

        conn.execute, conn.fetch = tracked_execute, tracked_fetch  # type: ignore[method-assign]

        await _fetch_with_per_bank_index_plan(
            conn,
            "SELECT 1",
        )

        assert order == ["set", "fetch"]

    @pytest.mark.asyncio
    async def test_raw_asyncpg_connection_without_backend_type(self):
        """Regression: the recall path passes a raw asyncpg connection, which has
        no ``backend_type``. Reading it unguarded raised AttributeError and broke
        every search."""
        conn = _RawAsyncpgConn()

        await _fetch_with_per_bank_index_plan(conn, "SELECT 1 WHERE bank_id = $1", "bank-a")

        assert conn.executed == ["SET LOCAL plan_cache_mode = force_custom_plan"]
        assert conn.opened_transaction
        assert conn.fetched == [("SELECT 1 WHERE bank_id = $1", ("bank-a",))]

    async def test_transaction_yield_value_is_not_used(self):
        """asyncpg's transaction() yields a Transaction, which has no query
        methods — the helper must run its statements on the connection."""
        conn = _RawAsyncpgConn()

        # Would raise AttributeError on the Transaction if the yielded value were used.
        await _fetch_with_per_bank_index_plan(conn, "SELECT 1")

        assert conn.fetched == [("SELECT 1", ())]

    async def test_transaction_is_closed_after_use(self):
        conn = _RecordingConn("postgresql")

        await _fetch_with_per_bank_index_plan(conn, "SELECT 1")

        assert conn.transaction_depth == 0, "transaction must not be left open"

    async def test_non_postgres_backend_is_untouched(self):
        """plan_cache_mode is a PG GUC; Oracle must not see it."""
        conn = _RecordingConn("oracle")

        await _fetch_with_per_bank_index_plan(conn, "SELECT 1", "bank-a")

        assert conn.executed == []
        assert not conn.opened_transaction
        assert conn.fetched == [("SELECT 1", ("bank-a",))]


# ---------------------------------------------------------------------------
# 2. fetch_unit_dates — cast the parameter, not the column
# ---------------------------------------------------------------------------


class TestFetchUnitDatesUsesPrimaryKeyIndex:
    @pytest.mark.asyncio
    async def test_does_not_cast_the_indexed_column(self):
        conn = _RecordingConn("postgresql")

        await PostgreSQLOps().fetch_unit_dates(conn, "public.memory_units", ["c91d1a94-c335-4c1f-933a-a857dd3e43be"])

        sql = conn.fetched[0][0]
        # `WHERE id::text = ANY($1)` forced a seq scan over ~1M rows.
        assert "id::text = ANY" not in sql
        assert "(id)::text" not in sql
        assert "WHERE id = ANY(" in sql

    @pytest.mark.asyncio
    async def test_casts_the_parameter_to_uuid(self):
        conn = _RecordingConn("postgresql")

        await PostgreSQLOps().fetch_unit_dates(conn, "public.memory_units", ["c91d1a94-c335-4c1f-933a-a857dd3e43be"])

        sql = conn.fetched[0][0]
        assert "::uuid" in sql
        assert "$1::text[]" in sql

    @pytest.mark.asyncio
    async def test_malformed_ids_are_filtered_not_fatal(self):
        """A bare ``$1::uuid[]`` cast would raise on these; the old
        ``id::text`` predicate silently ignored them. Keep ignoring them."""
        conn = _RecordingConn("postgresql")

        await PostgreSQLOps().fetch_unit_dates(
            conn, "public.memory_units", ["not-a-uuid", "{C91D1A94-C335-4C1F-933A-A857DD3E43BE}"]
        )

        sql = conn.fetched[0][0]
        # The regex guard is what makes the cast safe for arbitrary input.
        assert "~" in sql
        assert "[0-9a-f]" in sql

    @pytest.mark.asyncio
    async def test_passes_ids_through_as_a_single_text_array_param(self):
        conn = _RecordingConn("postgresql")
        ids = ["c91d1a94-c335-4c1f-933a-a857dd3e43be", "08742722-fd05-4538-abbe-abb5152b14d2"]

        await PostgreSQLOps().fetch_unit_dates(conn, "public.memory_units", ids)

        assert conn.fetched[0][1] == (ids,)

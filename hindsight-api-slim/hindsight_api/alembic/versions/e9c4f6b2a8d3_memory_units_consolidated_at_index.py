"""Index memory_units' consolidation time so the bank freshness read probes instead of scanning.

``consolidation_freshness`` (``engine/memories/pg/counts.py``) used to answer all
four of its values with one aggregate over every row in the bank. reflect() and
the mental-model refresh pay for it on every call. Measured on production
(BLO-55989, auto_explain 2026-11-12): 471k rows read through
``idx_memory_units_bank_id``, 14-20 s per call, and reflect's ``freshness`` phase
took 18-118 s on a volume the read saturates.

The pending and failed counts and the write watermark each already have an index.
``MAX(consolidated_at)`` had none. This partial index makes it one backward probe.
The predicate ``consolidated_at IS NOT NULL`` must stay word for word in the query.

Built CONCURRENTLY in an ``autocommit_block()``, dropping an invalid leftover of
the same name first, exactly as ``c4e8a1b7d2f6`` does and for the same reasons.

Revision ID: e9c4f6b2a8d3
Revises: d8b3e5a1c7f2
Create Date: 2026-11-12
"""

from collections.abc import Sequence

from alembic import context, op
from sqlalchemy import text

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "e9c4f6b2a8d3"
down_revision: str | Sequence[str] | None = "d8b3e5a1c7f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PG_INDEX_NAME = "idx_memory_units_consolidated_at"


def _pg_schema_prefix() -> str:
    """Schema-qualifier for raw SQL on PG (multi-tenant search_path)."""
    schema = context.config.get_main_option("target_schema")
    return f'"{schema}".' if schema else ""


def _pg_upgrade() -> None:
    bind = op.get_bind()
    target_schema = context.config.get_main_option("target_schema") or None
    schema = _pg_schema_prefix()

    with op.get_context().autocommit_block():
        leftover_invalid = bind.execute(
            text(
                "SELECT NOT i.indisvalid "
                "FROM pg_class c "
                "JOIN pg_index i ON c.oid = i.indexrelid "
                "JOIN pg_namespace n ON c.relnamespace = n.oid "
                "WHERE c.relname = :index_name "
                "  AND n.nspname = COALESCE(:target_schema, current_schema())"
            ),
            {"index_name": _PG_INDEX_NAME, "target_schema": target_schema},
        ).scalar()
        if leftover_invalid:
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {schema}{_PG_INDEX_NAME}")

        op.execute(
            f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {_PG_INDEX_NAME} "
            f"ON {schema}memory_units(bank_id, consolidated_at) WHERE consolidated_at IS NOT NULL"
        )


def _pg_downgrade() -> None:
    schema = _pg_schema_prefix()
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {schema}{_PG_INDEX_NAME}")


def upgrade() -> None:
    # The freshness query this serves is the PostgreSQL store's (engine/memories/pg).
    run_for_dialect(pg=_pg_upgrade, oracle=None)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade, oracle=None)

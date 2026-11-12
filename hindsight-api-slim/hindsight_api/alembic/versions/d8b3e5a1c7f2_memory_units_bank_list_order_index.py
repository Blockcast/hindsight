"""Index memory_units in list_memories' default order so a page reads only that page.

``list_memories`` (``engine/memories/pg/curation.py``) pages a bank with
``WHERE bank_id = $1 ORDER BY mentioned_at DESC NULLS LAST, created_at DESC, id
LIMIT $n OFFSET $m``. The only index it could use was ``idx_memory_units_bank_id``,
so every page read the whole bank from the heap and top-N sorted it. Measured on
production (BLO-55297, auto_explain 2026-11-09): 279,713 heap rows read to return
100, 65-155 s per call on a volume already saturated by those reads.

This composite matches the ORDER BY column for column, so the planner walks the
index from the bank's first entry and stops after LIMIT + OFFSET rows. ``id`` is
last because the ORDER BY uses it to make the order total.

The invalidated archive (``invalidated_memory_units``) is not indexed the same
way: it is cold storage, it already has ``(bank_id, invalidated_at)``, and it
showed up in none of the slow plans.

Built CONCURRENTLY in an ``autocommit_block()``, dropping an invalid leftover of
the same name first, exactly as ``c4e8a1b7d2f6`` does and for the same reasons.

Revision ID: d8b3e5a1c7f2
Revises: c7e2f9a4d1b8
Create Date: 2026-11-09
"""

from collections.abc import Sequence

from alembic import context, op
from sqlalchemy import text

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "d8b3e5a1c7f2"
down_revision: str | Sequence[str] | None = "c7e2f9a4d1b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PG_INDEX_NAME = "idx_memory_units_bank_list_order"


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
            f"ON {schema}memory_units(bank_id, mentioned_at DESC NULLS LAST, created_at DESC, id)"
        )


def _pg_downgrade() -> None:
    schema = _pg_schema_prefix()
    with op.get_context().autocommit_block():
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {schema}{_PG_INDEX_NAME}")


def upgrade() -> None:
    # The paging query this serves is the PostgreSQL store's (engine/memories/pg).
    run_for_dialect(pg=_pg_upgrade, oracle=None)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade, oracle=None)

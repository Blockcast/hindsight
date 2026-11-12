"""Regression for the bank freshness read and its index (``e9c4f6b2a8d3``).

``consolidation_freshness`` used to aggregate every row of a bank in one statement
(471k rows, 14-20 s in production, BLO-55989). It is now four statements, each of
which must be answerable from its own index. Checks the new index shape, that every
freshness statement is planned onto an index rather than a whole-bank read, and the
downgrade round trip. Uses a database of its own.
"""

import re
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

from hindsight_api.engine.memories.pg import counts

pytestmark = pytest.mark.xdist_group("migration-memory-units-consolidated-at-pg0")

_SCRIPT_LOCATION = str(Path(__file__).parent.parent / "hindsight_api" / "alembic")

_REVISION = "e9c4f6b2a8d3"
_PRE_REVISION = "d8b3e5a1c7f2"
_INDEX = "idx_memory_units_consolidated_at"

# The one index each freshness statement must use, in the order they are issued.
_EXPECTED_INDEXES = (
    _INDEX,
    "idx_memory_units_bank_updated_at",
    "idx_memory_units_unconsolidated",
    "idx_memory_units_consolidation_failed",
)


class _RecordingConn:
    """Captures the SQL consolidation_freshness sends, so the test plans the real text."""

    def __init__(self):
        self.statements: list[str] = []

    async def fetchval(self, sql, *args):
        self.statements.append(sql)
        return None

    async def fetchrow(self, sql, *args):
        self.statements.append(sql)
        return None


def _alembic_cfg(db_url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", _SCRIPT_LOCATION)
    cfg.set_main_option("sqlalchemy.url", db_url)
    cfg.set_main_option("prepend_sys_path", ".")
    cfg.set_main_option("path_separator", "os")
    return cfg


def _index_def(conn) -> str | None:
    return conn.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = :n"), {"n": _INDEX}).scalar()


@pytest.fixture(scope="module")
def head_db_url(fresh_db_url):
    command.upgrade(_alembic_cfg(fresh_db_url), "heads")
    return fresh_db_url


def test_index_shape(head_db_url):
    engine = create_engine(head_db_url)
    try:
        with engine.connect() as conn:
            index_def = _index_def(conn)
            assert index_def is not None, "consolidated_at index missing at head"
            assert "(bank_id, consolidated_at)" in index_def, index_def
            assert "consolidated_at IS NOT NULL" in index_def, index_def
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_every_freshness_statement_is_index_backed(head_db_url):
    """No freshness statement may fall back to reading the whole bank.

    Plan choice is data-dependent, so sequential scans are switched off for one
    rolled-back transaction. A statement whose predicate drifts from its partial
    index then plans onto some other bank_id-leading index (a whole-bank read)
    and this fails.
    """
    rec = _RecordingConn()
    await counts.consolidation_freshness(conn=rec, fq_table=lambda t: t, bank_id="b")
    assert len(rec.statements) == 4, rec.statements
    engine = create_engine(head_db_url)
    conn = engine.connect()
    trans = conn.begin()
    try:
        conn.execute(text("SET LOCAL enable_seqscan = off"))
        for sql, expected in zip(rec.statements, _EXPECTED_INDEXES, strict=True):
            plan = "\n".join(r[0] for r in conn.execute(text("EXPLAIN " + sql.replace("$1", ":bank")), {"bank": "b"}))
            used = set(re.findall(r"(?:using|on) (idx_\w+)", plan))
            assert used == {expected}, plan
    finally:
        trans.rollback()
        conn.close()
        engine.dispose()


def test_downgrade_drops_and_upgrade_restores(head_db_url):
    cfg = _alembic_cfg(head_db_url)
    engine = create_engine(head_db_url)
    try:
        command.downgrade(cfg, _PRE_REVISION)
        with engine.connect() as conn:
            assert _index_def(conn) is None
        command.upgrade(cfg, _REVISION)
        with engine.connect() as conn:
            assert _index_def(conn) is not None
    finally:
        command.upgrade(cfg, "heads")
        engine.dispose()

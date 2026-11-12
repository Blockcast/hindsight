"""Regression for the list_memories ordering index (``d8b3e5a1c7f2``).

``list_memories`` pages a bank by ``mentioned_at DESC NULLS LAST, created_at DESC,
id``. With only ``idx_memory_units_bank_id`` to use, each page read the whole bank
and sorted it (280k heap rows for 100 returned, 65-155 s in production,
BLO-55297). Checks the index shape, that the default listing query is served by it
without a sort, and the downgrade round trip. Uses a database of its own.
"""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

pytestmark = pytest.mark.xdist_group("migration-memory-units-bank-list-order-pg0")

_SCRIPT_LOCATION = str(Path(__file__).parent.parent / "hindsight_api" / "alembic")

_REVISION = "d8b3e5a1c7f2"
_PRE_REVISION = "c7e2f9a4d1b8"
_INDEX = "idx_memory_units_bank_list_order"

# list_memories' default page query (engine/memories/pg/curation.py), table unqualified.
_LIST_QUERY = """
    SELECT id FROM memory_units
    WHERE bank_id = :bank
    ORDER BY mentioned_at DESC NULLS LAST, created_at DESC, id
    LIMIT 100 OFFSET 0
"""


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


def test_index_matches_the_listing_order(head_db_url):
    engine = create_engine(head_db_url)
    try:
        with engine.connect() as conn:
            index_def = _index_def(conn)
            assert index_def is not None, "list-order index missing at head"
            assert "(bank_id, mentioned_at DESC NULLS LAST, created_at DESC, id)" in index_def, index_def
    finally:
        engine.dispose()


def test_listing_query_walks_the_index_without_sorting(head_db_url):
    """The planner must be able to serve the page straight off the index.

    Which plan wins is data-dependent, so sorting is switched off for one rolled-back
    transaction: if the index no longer matches the ORDER BY, the plan falls back to a
    Sort node (or a different index) and this fails.
    """
    engine = create_engine(head_db_url)
    conn = engine.connect()
    trans = conn.begin()
    try:
        conn.execute(text("SET LOCAL enable_sort = off"))
        conn.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join(r[0] for r in conn.execute(text(f"EXPLAIN {_LIST_QUERY}"), {"bank": "b"}))
        assert _INDEX in plan, plan
        assert "Sort" not in plan, plan
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

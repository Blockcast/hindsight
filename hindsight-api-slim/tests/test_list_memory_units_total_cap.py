"""``list_memory_units`` counts its total only up to a cap (BLO-55989).

Pins the contract: the count reads one row past the cap, a total past it is
reported as the cap with ``total_is_estimate`` set, and the cap always reaches
past the requested page so "is there a next page" stays exact.
"""

import re

import pytest

from hindsight_api.engine.memories.pg import curation

_CAP = curation._LIST_TOTAL_CAP


class _Conn:
    def __init__(self, matching: int):
        self.matching = matching
        self.count_sql = ""

    async def fetchrow(self, sql, *args):
        self.count_sql = sql
        limit = int(re.search(r"LIMIT (\d+)", sql).group(1))
        return {"total": min(self.matching, limit)}

    async def fetch(self, sql, *args):
        return []


async def _list(matching: int, offset: int = 0, limit: int = 100):
    conn = _Conn(matching)
    out = await curation.list_memory_units(
        conn=conn, ops=None, fq_table=lambda t: t, bank_id="b", limit=limit, offset=offset
    )
    return conn, out


@pytest.mark.asyncio
async def test_exact_below_and_at_cap():
    for n in (0, 150, _CAP):
        conn, out = await _list(n)
        assert (out["total"], out["total_is_estimate"]) == (n, False)
        assert f"LIMIT {_CAP + 1}" in conn.count_sql


@pytest.mark.asyncio
async def test_past_cap_is_flagged_lower_bound():
    _, out = await _list(250_000)
    assert (out["total"], out["total_is_estimate"]) == (_CAP, True)


@pytest.mark.asyncio
async def test_deep_page_still_sees_next_page():
    offset, limit = 20_000, 100
    _, out = await _list(250_000, offset=offset, limit=limit)
    assert out["total_is_estimate"] is True
    assert offset + limit < out["total"]

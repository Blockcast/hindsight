"""Record the native observation search_vector repair rollout.

Observations created or updated by the consolidator landed with a NULL
``search_vector`` under the ``native`` text-search backend: the
single-row INSERT/UPDATE paths in ``consolidator.py`` never populated the
tsvector (only the batch raw-fact path in ``ops_postgresql.insert_facts_batch``
did). Those observations were therefore invisible to the BM25 retrieval arm
until they were re-written by a later consolidation pass. The writer is fixed
in the same change set (all four consolidator sites now call
``to_tsvector($lang, COALESCE(text, ''))``). The admin repair below handles the
historical residue so existing observations become BM25-searchable without a
re-ingest.

Scope mirrors the writer fix exactly:
  * Only the ``native`` backend is touched. The repair gates on the column
    *type*: under ``native`` ``search_vector`` is a regular (non-generated)
    tsvector column; every other backend is skipped.
  * The tsvector is built from the observation's own ``text`` only — matching
    the consolidator INSERT/UPDATE paths.
  * Only ``fact_type = 'observation'`` rows with a NULL ``search_vector`` are
    rewritten. The ``IS NULL`` predicate makes the repair idempotent and
    re-runnable.

The configured ``HINDSIGHT_API_TEXT_SEARCH_EXTENSION_NATIVE_LANGUAGE`` is used
by the admin command so repaired rows are lexically identical to newly-created
observations. It is passed as a typed database parameter, not interpolated.

The historical residue can be hundreds of thousands of rows. Running one
UPDATE per schema from Alembic would hold row locks and WAL pressure for the
whole migration transaction, blocking startup and competing with recall. The
actual repair is therefore an explicit bounded admin operation:
hindsight-admin backfill-observation-search-vector. It commits each small
FOR UPDATE SKIP LOCKED batch, so it can run alongside the live service and
multiple operators can safely resume or share the work.

This migration deliberately performs no data scan or scheduling. The writer fix
makes new observations searchable immediately; the admin operation drains the
historical NULL rows at a pace chosen by the operator.

Oracle slot is intentionally absent: the consolidator INSERT/UPDATE paths that
this repairs are PostgreSQL-specific (``ops_postgresql``), and the native
tsvector ``search_vector`` column only exists on PostgreSQL. There is no Oracle
residue to repair.

Revision ID: c3f7a1b9d2e4
Revises: f4d1c2b3a5e6
Create Date: 2026-06-29
"""

from collections.abc import Sequence

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "c3f7a1b9d2e4"
down_revision: str | Sequence[str] | None = "f4d1c2b3a5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _pg_upgrade() -> None:
    # Data repair is intentionally outside Alembic. See the module docstring.
    # Keeping this slot (rather than making the revision a missing branch) means
    # every schema records that the safe, non-blocking rollout is complete.
    return


def _pg_downgrade() -> None:
    # No-op: backfilled rows are indistinguishable from observations that were
    # populated by the post-fix writer, and reverting either to NULL would
    # re-break BM25 retrieval. The column simply stays populated.
    pass


def upgrade() -> None:
    run_for_dialect(pg=_pg_upgrade)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade)

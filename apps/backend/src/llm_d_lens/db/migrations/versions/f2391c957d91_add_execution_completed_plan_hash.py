"""add the completed-run plan hash

Revision ID: f2391c957d91
Revises: d1cf8c18adc3
Create Date: 2026-11-22 00:00:00.000000

Binds ``execution_completed_at`` to the normalized plan hash that completed.
Rows created before this revision have no hash and are stale for finalize (see
docs/design/cluster-permission-preflight-design.md sections 4.1 and 7).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2391c957d91"
down_revision: str | Sequence[str] | None = "d1cf8c18adc3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clusters", sa.Column("execution_completed_plan_hash", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("clusters", "execution_completed_plan_hash")

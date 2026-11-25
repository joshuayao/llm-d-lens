"""add the cluster provisioning plan and execution lock columns

Revision ID: de5cc4aaefa8
Revises: e0716e45ba8f
Create Date: 2026-11-21 00:00:00.000000

Stores the normalized provisioning plan on the draft/active cluster and the
cross-worker execution lock used by the permission-guarded create flow (see
docs/design/cluster-permission-preflight-design.md sections 4.1 and 7).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "de5cc4aaefa8"
down_revision: str | Sequence[str] | None = "e0716e45ba8f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_COLUMNS = (
    "provisioning_plan",
    "execution_token",
    "execution_started_at",
    "execution_heartbeat_at",
    "execution_cancel_requested",
    "execution_steps",
    "execution_completed_at",
)


def upgrade() -> None:
    op.add_column(
        "clusters",
        sa.Column(
            "provisioning_plan",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
    )
    op.add_column("clusters", sa.Column("execution_token", sa.String(length=64), nullable=True))
    op.add_column("clusters", sa.Column("execution_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("clusters", sa.Column("execution_heartbeat_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "clusters",
        sa.Column("execution_cancel_requested", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "clusters",
        sa.Column(
            "execution_steps",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
    )
    op.add_column("clusters", sa.Column("execution_completed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    for column in reversed(_NEW_COLUMNS):
        op.drop_column("clusters", column)

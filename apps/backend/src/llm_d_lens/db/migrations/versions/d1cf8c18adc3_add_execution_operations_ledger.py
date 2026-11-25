"""add the operation-level execution ledger

Revision ID: d1cf8c18adc3
Revises: de5cc4aaefa8
Create Date: 2026-11-22 00:00:00.000000

Stores ``{operation_id: status}`` for the current plan next to the legacy
``execution_steps`` column (see
docs/design/cluster-permission-preflight-design.md sections 7 and 18). The old
step column stays until the step-level model is retired in M5.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d1cf8c18adc3"
down_revision: str | Sequence[str] | None = "de5cc4aaefa8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "clusters",
        sa.Column(
            "execution_operations",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("clusters", "execution_operations")

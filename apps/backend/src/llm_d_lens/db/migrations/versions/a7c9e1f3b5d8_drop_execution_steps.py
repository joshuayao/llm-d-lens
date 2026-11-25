"""drop the retired step-level execution ledger

Revision ID: a7c9e1f3b5d8
Revises: f2391c957d91
Create Date: 2026-11-22 00:00:00.000000

Old draft rows may still contain ``execution_steps``. Dropping the column does
not delete the cluster or its active completion columns; a draft that relied on
the step ledger must re-run the permission check and execute its operations.
``execution_operations``, ``execution_completed_at`` and
``execution_completed_plan_hash`` are preserved.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a7c9e1f3b5d8"
down_revision: str | Sequence[str] | None = "f2391c957d91"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("clusters") as batch:
        batch.drop_column("execution_steps")


def downgrade() -> None:
    with op.batch_alter_table("clusters") as batch:
        batch.add_column(
            sa.Column(
                "execution_steps",
                sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
                nullable=True,
            )
        )

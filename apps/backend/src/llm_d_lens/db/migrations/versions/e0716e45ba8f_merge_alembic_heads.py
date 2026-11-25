"""merge the three pre-existing Alembic heads

Revision ID: e0716e45ba8f
Revises: 814f033eb959, 8bf2a6c1d903, e6b8d0f2a4c7
Create Date: 2026-11-21 00:00:00.000000

"""

from collections.abc import Sequence

revision: str = "e0716e45ba8f"
down_revision: str | Sequence[str] | None = ("814f033eb959", "8bf2a6c1d903", "e6b8d0f2a4c7")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Merge the deployment-plan, public-benchmark and AI-provider branches."""
    pass


def downgrade() -> None:
    """Split back into the three original heads."""
    pass

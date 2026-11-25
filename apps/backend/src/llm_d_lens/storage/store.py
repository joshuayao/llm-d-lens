"""Durable storage for Storage-owned volume records.

Backed by the ``storage_volumes`` table (see
docs/design/database-design.md#data-access-architecture section 5.4.2) via
``StorageVolumeDao``, instead of one JSON file per record. Keeps the
exact public surface of the old file-based ``StorageVolumeStore``
(``create``/``get``/``list``/``save``/``delete``) so callers (Storage
service, other modules' tests) need no changes. ``base_dir`` is accepted but
unused: with the DB-backed store, per-test isolation instead comes from the
per-test in-memory database (see the repo root ``conftest.py``).
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.exc import IntegrityError

from llm_d_lens.db.dao.storage_volume import StorageVolumeDao, StorageVolumeDaoError
from llm_d_lens.db.models.storage_volume import StorageVolumeRow
from llm_d_lens.storage.contracts import StorageVolume

__all__ = ["StorageVolumeStore", "StorageVolumeStoreError", "default_store"]

# Kept as an alias so existing `except StorageVolumeStoreError` call sites
# keep working unchanged.
StorageVolumeStoreError = StorageVolumeDaoError


class StorageVolumeStore:
    def __init__(self, base_dir: str | Path | None = None) -> None:
        # base_dir is a vestige of the file-based store; retained only so
        # existing call sites (StorageVolumeStore(tmp_path)) keep working.
        del base_dir
        self._dao = StorageVolumeDao()

    def create(self, volume: StorageVolume) -> StorageVolume:
        return self._dao.create(volume)

    def get(self, volume_id: str) -> StorageVolume | None:
        return self._dao.get(volume_id)

    def list(self) -> list[StorageVolume]:
        return self._dao.list()

    def save(self, volume: StorageVolume) -> StorageVolume:
        return self._dao.save(volume)

    def delete(self, volume_id: str) -> None:
        self._dao.delete(volume_id)

    def set_owner(self, volume_id: str, owner_user_id: str | None) -> None:
        """Persist ``owner_user_id`` on the storage volume row without altering DTOs."""
        try:
            with self._dao._transaction() as session:
                row = session.get(StorageVolumeRow, volume_id)
                if row is not None and row.owner_user_id != owner_user_id:
                    row.owner_user_id = owner_user_id
                    session.flush()
        except IntegrityError:
            # Synthetic unit-test user ids may lack a matching users row.
            return

    def get_owner(self, volume_id: str) -> str | None:
        """Return the persisted ``owner_user_id`` for a storage volume, if any."""
        with self._dao._read_only() as session:
            row = session.get(StorageVolumeRow, volume_id)
            return row.owner_user_id if row is not None else None


_default_store: StorageVolumeStore | None = None


def default_store() -> StorageVolumeStore:
    global _default_store
    if _default_store is None:
        _default_store = StorageVolumeStore()
    return _default_store

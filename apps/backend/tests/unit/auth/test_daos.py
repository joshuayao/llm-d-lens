"""DAO-layer tests for the auth tables (design section 4)."""

from __future__ import annotations

from datetime import timedelta

from llm_d_lens.auth.records import (
    AuditLogRecord,
    GroupRecord,
    GroupRoleBindingRecord,
    IdentityGroupMappingRecord,
    IdentityProviderRecord,
    RoleRecord,
    SessionRecord,
    UserGroupRecord,
    UserRecord,
    UserRoleBindingRecord,
    utcnow,
)
from llm_d_lens.db.dao.audit_log import AuditLogDao
from llm_d_lens.db.dao.cluster import ClusterDao
from llm_d_lens.db.dao.group import GroupDao, GroupRoleBindingDao, UserGroupDao
from llm_d_lens.db.dao.identity_provider import IdentityGroupMappingDao, IdentityProviderDao
from llm_d_lens.db.dao.role import RoleDao, RolePermissionDao, UserRoleBindingDao
from llm_d_lens.db.dao.session import SessionDao
from llm_d_lens.db.dao.user import UserDao


def _cluster() -> str:
    return ClusterDao().create("auth-test", "", "apiVersion: v1\nkind: Config").id


def test_user_crud_and_case_insensitive_lookup():
    dao = UserDao()
    user = dao.create(UserRecord(username="Alice", display_name="Alice A"))
    assert dao.get(user.id).username == "Alice"
    assert dao.get_by_username("alice").id == user.id
    assert dao.get_by_username("missing") is None

    user.display_name = "Alice B"
    user.status = "disabled"
    saved = dao.save(user)
    assert saved.display_name == "Alice B"
    assert [u.id for u in dao.list(status="disabled")] == [user.id]
    assert [u.id for u in dao.list(query="alice")] == [user.id]

    dao.bump_principal_version(user.id)
    assert dao.get(user.id).principal_version == user.principal_version + 1

    dao.delete(user.id)
    assert dao.get(user.id) is None


def test_user_external_lookup_and_login_mark():
    dao = UserDao()
    dao.create(UserRecord(username="bob", auth_source="ldap", provider_id=None, external_id="uid=bob,dc=x"))
    found = dao.get_by_username("bob")
    # provider_id is null here; lookup by external needs a real provider, so create one.
    assert found.external_id == "uid=bob,dc=x"
    dao.mark_login(found.id)
    reloaded = dao.get(found.id)
    assert reloaded.last_login_at is not None
    assert reloaded.failed_login_count == 0


def test_roles_permissions_and_user_bindings():
    roles = RoleDao()
    role = roles.create(RoleRecord(name="custom-reviewer", description="review"))
    assert roles.get_by_name("CUSTOM-REVIEWER").id == role.id

    permissions = RolePermissionDao()
    permissions.set_for_role(role.id, {"deployment:run:read", "model-service:group:share"})
    assert {p.permission for p in permissions.list_for_role(role.id)} == {
        "deployment:run:read",
        "model-service:group:share",
    }
    permissions.set_for_role(role.id, {"deployment:run:read"})
    assert {p.permission for p in permissions.list_for_role(role.id)} == {"deployment:run:read"}
    assert permissions.permissions_for_roles([role.id])[role.id] == frozenset({"deployment:run:read"})

    user = UserDao().create(UserRecord(username="carol"))
    bindings = UserRoleBindingDao()
    cluster_id = _cluster()
    binding = bindings.create(
        UserRoleBindingRecord(user_id=user.id, role_id=role.id, scope_type="cluster", scope_cluster_id=cluster_id)
    )
    assert [b.id for b in bindings.list_for_user(user.id)] == [binding.id]
    bindings.delete(binding.id)
    assert bindings.list_for_user(user.id) == []


def test_groups_membership_and_bindings():
    groups = GroupDao()
    group = groups.create(GroupRecord(name="team-a"))
    assert groups.get_by_name("TEAM-A").id == group.id
    assert groups.get(group.id).authz_version == 1
    groups.bump_authz_version(group.id)
    assert groups.get(group.id).authz_version == 2

    user = UserDao().create(UserRecord(username="dave"))
    members = UserGroupDao()
    members.add(UserGroupRecord(user_id=user.id, group_id=group.id, source="manual"))
    assert [m.user_id for m in members.list_for_group(group.id)] == [user.id]
    members.remove(user.id, group.id)
    assert members.list_for_group(group.id) == []

    members.set_members(group.id, {user.id})
    assert {m.user_id for m in members.list_for_group(group.id)} == {user.id}

    role = RoleDao().create(RoleRecord(name="team-role"))
    bindings = GroupRoleBindingDao()
    cluster_id = _cluster()
    record = bindings.create(
        GroupRoleBindingRecord(group_id=group.id, role_id=role.id, scope_type="cluster", scope_cluster_id=cluster_id)
    )
    assert [b.id for b in bindings.list_for_group(group.id)] == [record.id]
    assert GroupRoleBindingDao().list_all()[0].id == record.id
    bindings.delete(record.id)


def test_sessions_lifecycle_and_sweep():
    user = UserDao().create(UserRecord(username="erin"))
    dao = SessionDao()
    now = utcnow()
    active = dao.create(
        SessionRecord(
            user_id=user.id,
            token_hash="a" * 64,
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(hours=12),
            idle_expires_at=now + timedelta(hours=8),
        )
    )
    assert dao.get_by_token_hash("a" * 64).id == active.id
    assert dao.count_active_for_user(user.id) == 1

    dao.touch(active.id, idle_expires_at=now + timedelta(hours=9), last_seen_at=now)
    assert dao.get(active.id).idle_expires_at > now

    dao.revoke(active.id)
    assert dao.list_for_user(user.id) == []
    assert len(dao.list_for_user(user.id, include_revoked=True)) == 1
    assert dao.list_all() == []
    assert [row.id for row in dao.list_all(include_revoked=True)] == [active.id]

    expired = dao.create(
        SessionRecord(
            user_id=user.id,
            token_hash="b" * 64,
            created_at=now,
            last_seen_at=now,
            expires_at=now - timedelta(minutes=1),
            idle_expires_at=now - timedelta(minutes=1),
        )
    )
    deleted = dao.sweep(now=now + timedelta(minutes=1), revoked_retention_seconds=0)
    assert deleted == 2
    assert dao.get(expired.id) is None


def test_session_per_user_cap():
    user = UserDao().create(UserRecord(username="frank"))
    dao = SessionDao()
    now = utcnow()
    for index in range(3):
        dao.create(
            SessionRecord(
                user_id=user.id,
                token_hash=f"{index:064d}",
                created_at=now + timedelta(seconds=index),
                last_seen_at=now,
                expires_at=now + timedelta(hours=12),
                idle_expires_at=now + timedelta(hours=8),
            )
        )
    dao.trim_user_sessions(user.id, max_keep=1)
    assert dao.count_active_for_user(user.id) == 1


def test_revoke_all_sessions():
    user = UserDao().create(UserRecord(username="gina"))
    dao = SessionDao()
    now = utcnow()
    for index in range(2):
        dao.create(
            SessionRecord(
                user_id=user.id,
                token_hash=f"{index:064d}",
                created_at=now,
                last_seen_at=now,
                expires_at=now + timedelta(hours=12),
                idle_expires_at=now + timedelta(hours=8),
            )
        )
    dao.revoke_user_sessions(user.id)
    assert dao.count_active_for_user(user.id) == 0


def test_identity_provider_and_mappings():
    providers = IdentityProviderDao()
    provider = providers.create(
        IdentityProviderRecord(type="ldap", name="corp-ldap", enabled=True, config={"server_url": "ldaps://x"})
    )
    assert providers.get_by_name("corp-ldap").id == provider.id
    assert [p.id for p in providers.list_enabled()] == [provider.id]

    provider.is_default = True
    assert providers.save(provider).is_default is True

    group = GroupDao().create(GroupRecord(name="ldap-team"))
    mappings = IdentityGroupMappingDao()
    mapping = mappings.create(
        IdentityGroupMappingRecord(provider_id=provider.id, external_group="cn=team", group_id=group.id)
    )
    assert [m.id for m in mappings.list_for_provider(provider.id)] == [mapping.id]
    mappings.delete(mapping.id)
    assert mappings.list_for_provider(provider.id) == []


def test_audit_log_append_list_and_retention():
    dao = AuditLogDao()
    now = utcnow()
    old = dao.append(
        AuditLogRecord(event_type="login", actor_username="u", created_at=now - timedelta(days=400), result="success")
    )
    dao.append(AuditLogRecord(event_type="mutation", actor_username="u", created_at=now, result="success"))
    assert len(dao.list(event_type="mutation")) == 1
    assert len(dao.list()) == 2

    deleted = dao.delete_before(dao.retention_cutoff(180))
    assert deleted == 1
    assert dao.list()[0].id != old.id


def test_audit_log_dao_append_clamps_all_string_columns_and_preserves_truncated_detail():
    from sqlalchemy import String

    from llm_d_lens.db.base import audit_string_column_limits
    from llm_d_lens.db.models.audit_log import AuditLogRow

    dao = AuditLogDao()
    expected_columns = {
        column.name: column.type.length
        for column in AuditLogRow.__table__.columns
        if isinstance(column.type, String) and column.type.length is not None
    }
    assert audit_string_column_limits() == expected_columns

    oversized = {name: f"{name}-" + ("x" * (length + 25)) for name, length in expected_columns.items()}
    oversized["actor_user_id"] = "external-idp-subject-" + ("z" * 30)
    saved = dao.append(
        AuditLogRecord(
            **oversized,
            detail={"password": "super-secret-value", "note": "kept"},
        )
    )

    for name, max_len in expected_columns.items():
        value = getattr(saved, name)
        if name == "actor_user_id":
            assert value is None
        else:
            assert isinstance(value, str)
            assert len(value) == max_len
            assert value == oversized[name][:max_len]
        assert saved.detail["truncatedFields"][name] == oversized[name]

    assert saved.detail["password"] == "[REDACTED]"  # noqa: S105
    assert saved.detail["note"] == "kept"

    # A valid <=36-char actor_user_id is preserved unchanged.
    actor = UserDao().create(UserRecord(username="valid-actor"))
    with_valid_actor = dao.append(
        AuditLogRecord(event_type="auth.valid", actor_user_id=actor.id, actor_username=actor.username)
    )
    assert with_valid_actor.actor_user_id == actor.id

    # When detail is None and truncation occurs, detail is initialized to hold truncatedFields.
    truncated_without_detail = dao.append(
        AuditLogRecord(
            event_type="auth.test",
            actor_username="alice",
            permission="p" * 150,
            detail=None,
        )
    )
    assert len(truncated_without_detail.permission) == 100
    assert truncated_without_detail.detail == {"truncatedFields": {"permission": "p" * 150}}

    # When detail is None and nothing is truncated, nullable columns stay None and detail stays None.
    clean = dao.append(AuditLogRecord(event_type="auth.clean", actor_username="bob", detail=None))
    assert clean.detail is None
    assert clean.permission is None
    assert clean.actor_user_id is None
    assert clean.target_name is None
    assert clean.user_agent is None


def test_automatic_orm_audit_before_flush_clamps_all_fields_and_preserves_target_and_user_agent():
    from llm_d_lens.auth.context import AuditContext, _audit_context
    from llm_d_lens.db.base import audit_string_column_limits

    limits = audit_string_column_limits()
    oversized_actor_user_id = "external-idp-subject-" + ("a" * 30)
    oversized_target_id = "grp-" + ("i" * (limits["target_id"] + 20))
    oversized_name = "team-" + ("n" * (limits["target_name"] + 40))
    oversized_ua = "Mozilla/5.0 " + ("u" * (limits["user_agent"] + 40))
    oversized_perm = " | ".join(
        [
            "model-service:gateway:reconcile",
            "model-service:gateway:manage",
            "model-service:member:manage",
            "model-service:group:manage",
            "model-service:group:toggle",
            "model-service:group:remove",
        ]
    )
    assert len(oversized_perm) == 179

    ctx = AuditContext(
        request_id="req-" + ("r" * 80),
        trace_id="trc-" + ("t" * 80),
        parent_request_id="prt-" + ("p" * 80),
        actor_user_id=oversized_actor_user_id,
        actor_username="actor-" + ("u" * 170),
        source="source-" + ("s" * 20),
        method="PATCH_LONG",
        path="/api/" + ("x" * 520),
        ip="127.0.0.1-" + ("0" * 70),
        user_agent=oversized_ua,
        permission=oversized_perm,
        event_type="evt-" + ("e" * 110),
        action="act-" + ("c" * 20),
        cluster_id="cls-" + ("k" * 40),
        required_permissions=tuple(oversized_perm.split(" | ")),
    )
    token = _audit_context.set(ctx)
    try:
        GroupDao().create(GroupRecord(id=oversized_target_id, name=oversized_name, description="desc"))
    finally:
        _audit_context.reset(token)

    rows = AuditLogDao().list(limit=10)
    assert len(rows) == 1
    row = rows[0]

    for col_name, max_len in limits.items():
        val = getattr(row, col_name)
        if col_name == "actor_user_id":
            assert val is None
        else:
            assert val is not None
            assert len(val) <= max_len

    assert len(row.permission) == 100
    assert len(row.target_name) == 256
    assert len(row.user_agent) == 512
    assert row.detail["truncatedFields"]["actor_user_id"] == oversized_actor_user_id
    assert row.detail["truncatedFields"]["permission"] == oversized_perm
    assert row.detail["truncatedFields"]["target_name"] == oversized_name
    assert row.detail["truncatedFields"]["target_id"] == oversized_target_id
    assert row.detail["truncatedFields"]["user_agent"] == oversized_ua
    assert row.detail["truncatedFields"]["path"] == ctx.path
    assert row.detail["truncatedFields"]["actor_username"] == ctx.actor_username
    assert row.detail["requiredPermissions"] == oversized_perm.split(" | ")

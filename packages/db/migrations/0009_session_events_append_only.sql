-- The event log is append-only (docs/adr/0020): the app role may read and insert session events,
-- but not change or remove one, its own workspace's included. 0004 granted it UPDATE and DELETE
-- along with the other tenant tables; this takes them back. Removing a session, a member, a user,
-- or a workspace still removes its events, because ON DELETE CASCADE runs as the table's owner,
-- not as the role that deleted the parent row. TRUNCATE was never granted.
REVOKE UPDATE, DELETE ON TABLE session_events FROM earshot_app;

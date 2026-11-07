-- A session has one role. A saved session whose two roles differ has no single
-- role to keep, so it signs out.
DELETE FROM host_sessions WHERE real_role <> role;
ALTER TABLE host_sessions DROP COLUMN real_role;

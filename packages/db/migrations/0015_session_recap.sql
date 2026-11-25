-- The debrief's recap (Phase 5 WP10, docs/adr/0037): `recap.created` as the session projection keeps
-- it, written by `rebuildProjections` like every other summary column. drizzle-kit generated it
-- from src/schema. Nullable: sessions that ended before the recap existed have none, and a
-- session's recap arrives after its end, in the same flush as its seal or before it.
ALTER TABLE "sessions" ADD COLUMN "recap" jsonb;

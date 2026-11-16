-- Better Auth's database-backed rate limiter (rateLimit: { storage: "database" }). Workers share
-- no memory across isolates, so the counters live here. Like Better Auth's other tables this one
-- belongs to the owner: no row-level security, and deliberately no grant to earshot_app.
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);

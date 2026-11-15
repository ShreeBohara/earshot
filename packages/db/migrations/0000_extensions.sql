-- pgvector stores the 512-dimension halfvec embeddings used for entity linking (Phase 4);
-- pg_trgm backs fuzzy name matching. drizzle-kit doesn't generate extension statements.
-- Each statement needs its own breakpoint: the migrator runs one prepared statement per chunk.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('owner'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text DEFAULT 'default' NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"dek_iv" "bytea" NOT NULL,
	"last4" text NOT NULL,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_workspace_id_provider_label_unique" UNIQUE("workspace_id","provider","label"),
	CONSTRAINT "credentials_last4_check" CHECK (char_length("credentials"."last4") <= 4)
);
--> statement-breakpoint
CREATE TABLE "crm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"auth_type" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"dek_iv" "bytea" NOT NULL,
	"api_version" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_connections_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "crm_connections_provider_check" CHECK ("crm_connections"."provider" in ('hubspot', 'twenty', 'attio'))
);
--> statement-breakpoint
CREATE TABLE "crm_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"phonetic_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"embedding" halfvec(512),
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_entities_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "crm_entities_external_key_unique" UNIQUE NULLS NOT DISTINCT("workspace_id","connection_id","kind","external_id"),
	CONSTRAINT "crm_entities_kind_check" CHECK ("crm_entities"."kind" in ('company', 'contact', 'deal'))
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"counterpart" text,
	"text" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"crm_task_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitments_owner_check" CHECK ("commitments"."owner" in ('rep', 'prospect')),
	CONSTRAINT "commitments_status_check" CHECK ("commitments"."status" in ('open', 'kept', 'missed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "facts_validity_check" CHECK ("facts"."valid_to" is null or "facts"."valid_to" > "facts"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"target_entity_id" uuid,
	"fields" jsonb NOT NULL,
	"risk_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"edit_diff" jsonb,
	"reviewer_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('proposed', 'approved', 'edited', 'rejected', 'synced', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "sync_jobs_attempts_check" CHECK ("sync_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq"),
	CONSTRAINT "session_events_id_unique" UNIQUE("id"),
	CONSTRAINT "session_events_seq_check" CHECK ("session_events"."seq" >= 0),
	CONSTRAINT "session_events_schema_version_check" CHECK ("session_events"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"engine" text NOT NULL,
	"providers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "sessions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "sessions_mode_check" CHECK ("sessions"."mode" in ('debrief', 'conversation', 'local'))
);
--> statement-breakpoint
CREATE TABLE "utterances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"witness" text NOT NULL,
	"text" text NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"started_ms" integer NOT NULL,
	"ended_ms" integer NOT NULL,
	CONSTRAINT "utterances_session_id_witness_seq_unique" UNIQUE("session_id","witness","seq"),
	CONSTRAINT "utterances_seq_check" CHECK ("utterances"."seq" >= 0),
	CONSTRAINT "utterances_witness_check" CHECK ("utterances"."witness" in ('biased', 'unbiased'))
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_connections" ADD CONSTRAINT "crm_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_entities" ADD CONSTRAINT "crm_entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_entities" ADD CONSTRAINT "crm_entities_connection_fk" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "public"."crm_connections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_entity_fk" FOREIGN KEY ("workspace_id","entity_id") REFERENCES "public"."crm_entities"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_proposal_fk" FOREIGN KEY ("workspace_id","proposal_id") REFERENCES "public"."proposals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utterances" ADD CONSTRAINT "utterances_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_workspace_id_at_idx" ON "audit_log" USING btree ("workspace_id","at");--> statement-breakpoint
CREATE INDEX "crm_entities_name_trgm_idx" ON "crm_entities" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "crm_entities_embedding_hnsw_idx" ON "crm_entities" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "commitments_workspace_id_status_due_at_idx" ON "commitments" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "facts_workspace_id_entity_id_key_idx" ON "facts" USING btree ("workspace_id","entity_id","key");--> statement-breakpoint
CREATE INDEX "proposals_workspace_id_session_id_idx" ON "proposals" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "proposals_workspace_id_status_idx" ON "proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "proposals_workspace_id_target_entity_id_idx" ON "proposals" USING btree ("workspace_id","target_entity_id");--> statement-breakpoint
CREATE INDEX "sync_jobs_workspace_id_proposal_id_idx" ON "sync_jobs" USING btree ("workspace_id","proposal_id");--> statement-breakpoint
CREATE INDEX "session_events_workspace_id_session_id_idx" ON "session_events" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "sessions_workspace_id_started_at_idx" ON "sessions" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "utterances_workspace_id_session_id_idx" ON "utterances" USING btree ("workspace_id","session_id");
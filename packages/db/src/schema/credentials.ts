import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { envelopeColumns } from "./columns";
import { workspaceId } from "./workspaces";

/**
 * The optional server vault for AI provider keys, off by default (docs/adr/0009). Only the
 * envelope-encrypted key and its last four characters are stored.
 */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: workspaceId(),
    provider: text().notNull(),
    label: text().notNull().default("default"),
    ...envelopeColumns(),
    last4: text().notNull(),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("credentials_workspace_id_provider_label_unique").on(t.workspaceId, t.provider, t.label),
    // A guard rail: this column can never hold more of a key than its last four characters.
    check("credentials_last4_check", sql`char_length(${t.last4}) <= 4`),
  ],
);

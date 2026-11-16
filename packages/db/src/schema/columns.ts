import { customType, timestamp } from "drizzle-orm/pg-core";

/**
 * Raw bytes, for ciphertexts, IVs, and wrapped data keys. Drizzle 0.45 has no built-in
 * `bytea` column. PGlite returns a Uint8Array and Neon's drivers a Buffer (also a Uint8Array);
 * the hex-string branch covers drivers that return Postgres's text form (`\x0a1b…`).
 */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | string }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    if (typeof value !== "string") return value;
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  },
});

/**
 * An envelope-encrypted secret (docs/adr/0009): the AES-256-GCM ciphertext and its IV, plus
 * the per-secret data key wrapped by the master key (a Worker secret) and that wrap's IV.
 */
export function envelopeColumns() {
  return {
    ciphertext: bytea().notNull(),
    iv: bytea().notNull(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    dekIv: bytea("dek_iv").notNull(),
  };
}

/** `created_at` and an `updated_at` that Drizzle bumps on every update. */
export function timestamps() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}

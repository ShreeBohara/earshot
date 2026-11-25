// What the conformance suite needs from a CRM besides its adapter (Phase 6 spec §4.2; docs/adr/0041):
// a context to call it through, fixtures made as a CRM user would make them, records read back raw,
// edits and deletes behind Earshot's back, and, where the CRM allows, a way to make its next answer
// an error. MemoryCrm and the demo CRM have one each; a live CRM's (Twenty in Docker, WP4) makes its
// fixtures through the CRM's own API and cleans up after. Types only: Worker-safe.
import type { CrmObject, ExternalRef, FieldValue } from "@earshot/core";
import type { CrmContext, CrmStage, CrmValue } from "../adapter";

/** A record the suite asks the harness to make, in Earshot's terms, as a CRM user would. */
export type Fixture =
  | { readonly object: "company"; readonly name: string }
  | {
      readonly object: "contact";
      readonly name: string;
      readonly title: string;
      readonly email: string;
      readonly phone: string;
      readonly company: ExternalRef | null;
    }
  | {
      readonly object: "deal";
      readonly name: string;
      readonly stage: CrmStage;
      readonly amount: number;
      readonly closeDate: string;
      readonly company: ExternalRef | null;
    };

/**
 * A record's values as Earshot's mirror holds them: what a card shows the reviewer, and so what a
 * live check compares (a deal's `stage`, `amount`, and `closeDate`; a contact's `title`, `email`,
 * and `phone`), in the mirror's form (a stage by its label, or by its id where the mirror keeps
 * ids, as the demo CRM's does: `ConformanceHarness.stageForm`).
 */
export type MirrorValues = Readonly<Record<string, FieldValue>>;

/** A record the harness made: the CRM's record, and its values as the mirror holds them. */
export interface Made {
  readonly ref: ExternalRef;
  readonly seen: MirrorValues;
}

/** A record as the CRM holds it: its properties by the CRM's own names, in the form adapters send. */
export interface RawRecord {
  readonly ref: ExternalRef;
  readonly properties: Readonly<Record<string, CrmValue>>;
}

/** A field the suite changes behind Earshot's back, in Earshot's terms (a stage by its id). */
export interface FixtureEdit {
  readonly field: "name" | "stage" | "amount" | "closeDate" | "title" | "email" | "phone";
  readonly value: FieldValue;
}

/** An answer the harness can make the CRM give the adapter's next call. */
export type HarnessAnswer =
  /** A 429, in the CRM's own form, with its retry advice where the CRM gives any. */
  | "rate_limited"
  /** An error whose body quotes the request's credential back, as a careless CRM might. */
  | "echo_credential";

/** A CRM, as the conformance suite drives it around the adapter under test. */
export interface ConformanceHarness {
  /** Readies the CRM for a run: an empty CRM in memory, a live workspace cleaned. */
  setup?(): Promise<void>;
  /** After a run: removes what it made, closes what it opened. */
  teardown?(): Promise<void>;
  /** The context the adapter's calls go through: the connection, and a `fetch` adding the credential. */
  context(): CrmContext;
  /**
   * The credential that context adds, which nothing the adapter previews or throws may hold; null
   * for a CRM that takes none (the demo CRM).
   */
  readonly secret: string | null;
  /** A context whose credential the CRM refuses; absent for a CRM that takes none. */
  refusedContext?(): CrmContext;
  /** How the mirror holds a deal's stage: by its label (as real CRMs' mirrors do), or by its id. */
  readonly stageForm: "label" | "id";
  /** Makes a record as a CRM user would, outside the adapter. */
  make(fixture: Fixture): Promise<Made>;
  /** A record as the CRM holds it; null when it's gone. */
  read(ref: ExternalRef): Promise<RawRecord | null>;
  /** Every record of a kind holding a marker, in a property, as its id, or in an activity's line. */
  find(object: CrmObject, marker: string): Promise<RawRecord[]>;
  /** The records a record is linked to. */
  associations(ref: ExternalRef): Promise<ExternalRef[]>;
  /** Changes a record's field behind Earshot's back; answers its values as the mirror now holds them. */
  edit(ref: ExternalRef, edit: FixtureEdit): Promise<MirrorValues>;
  /** Deletes a record behind Earshot's back. */
  remove(ref: ExternalRef): Promise<void>;
  /** Makes the CRM's answer to the adapter's next call this one; absent where the CRM can't. */
  respond?(answer: HarnessAnswer): void;
  /**
   * A value the CRM refuses for a field of a linked contact or deal, so writing it fails
   * `validation` naming that field; absent where the harness knows none.
   */
  readonly refusedValue?: {
    readonly field: "title" | "email" | "phone" | "amount" | "closeDate";
    readonly value: FieldValue;
  };
}

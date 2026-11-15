# @earshot/demo-crm

A fictional CRM for Earshot's demos and benchmarks: 60 companies, 150 contacts, 40 deals, and a few hundred notes, tasks, and meetings. Everything is invented. Domains use the reserved `.example` TLD and phone numbers sit in the fictional `555-01xx` range.

It exists for two jobs:

- **The public replay demo.** A recorded debrief needs a believable CRM to resolve names against.
- **The Phase 4 entity-linking benchmark.** Earshot's hardest problem is mapping a misheard name ("Atmas") to the right record ("Atmos Industrial"). The dataset is built so that guess is often a close call.

## Using it

```ts
import {
  companies,
  contacts,
  deals,
  activities,
  confusables,
  toEntityRows,
} from "@earshot/demo-crm";
```

The five datasets are validated with Zod when the module loads, and the types (`Company`, `Contact`, `Deal`, `Activity`, `ConfusableGroup`) are inferred from the same schemas. `toEntityRows()` flattens companies, contacts, deals, and activities into `{ kind, externalId, name, aliases, properties }` rows, the shape of the future `crm_entities` table. Raw JSON is also available as `@earshot/demo-crm/data/*.json`.

## Regenerating

```sh
pnpm --filter @earshot/demo-crm generate
```

`scripts/generate.ts` writes `data/*.json`. The output is committed, so consumers need no build step. The generator is deterministic: a fixed-seed mulberry32 PRNG, and every date is relative to the anchor `2026-11-01T00:00:00Z`, never the clock. A test re-runs the generator and fails if the committed files differ, so after editing `scripts/seed.ts` or `scripts/build.ts`, regenerate and commit the data.

`data/` is excluded from Biome through this package's `biome.json`, because the generator's JSON formatting is the source of truth.

## How the confusable groups are designed

The names to match live in `scripts/seed.ts`; the PRNG only adds ids, cities, sizes, deals, and activity text. `data/confusables.json` lists each group as `{ id, kind, confusion, memberIds }`. Companies and contacts each have groups of two or three, and every group is one of four types:

| Type           | What makes it hard                                                  | Example                                                                        |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `spelling`     | Same sound, different letters; a transcript can't tell them apart.  | Acme / Akme / Acmi Dynamics; Kathryn / Katherine / Catherine Moore             |
| `phonetic`     | Different words that sound alike.                                   | Atmos Industrial / Atlas Freight / Atmas Group; Dana Lee / Dana Li / Donna Lee |
| `shared-stem`  | A common leading word; only the tail disambiguates.                 | Northwind Labs / Logistics / Foods                                             |
| `abbreviation` | A short form that fits more than one account. Both carry the alias. | MSC: Meridian Supply Co / Midland Steel Corp                                   |

Design choices that matter for the benchmark:

- **Company and contact groups overlap on purpose.** Dana Lee, Dana Li, and Donna Lee work at Acme, Akme, and Acmi, so a model has to get both names right.
- **Aliases are honest, not unique.** Each company gets its first word as an alias (`Northwind` is an alias of all three Northwind accounts); abbreviations are shared. A linker that treats an alias as a key will fail, as it should.
- **Easy negatives are included.** 18 accounts have no look-alike.
- **Ids hide the structure.** Ids are assigned after a seeded shuffle, so neighboring ids are not neighbors in meaning.
- **Names are original and generic.** "Acme" is a placeholder; real companies and well-known fictional brands are avoided.

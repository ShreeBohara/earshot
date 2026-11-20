// Linker v1's ablation table (spec WP4 step 8): v1 as committed, then v1 refit on calibration
// without each signal (src/linking/fit.ts), each scored on a split with the witness off. A row
// shows what the linker loses without the signal, at thresholds chosen for it the same way.
import type { EntityRef } from "@earshot/core";
import { LINKER_PARAMS_V1, type LinkerParams } from "@earshot/understanding/link";
import { ABLATIONS, fitLinker, WITNESS_ONLY_CLASSES } from "./fit";
import { linkerV1, linkingCase } from "./linkers";
import { isWrongLink, type LinkingMetrics, linkingMetrics, score } from "./metrics";
import type { ConfusableItem } from "./schema";

export interface AblationRow {
  readonly name: string;
  readonly label: string;
  /** What the variant takes away; empty for v1 itself. */
  readonly removed: string;
  readonly params: LinkerParams;
  /** Whether its threshold search met the limits on calibration. */
  readonly feasible: boolean;
  /** Biased-only metrics on the rows' split. */
  readonly metrics: LinkingMetrics;
  /** Wrong links outside the classes only a second witness can resolve (E2, G). */
  readonly ownWrongLinks: number;
}

function committedFeasible(): boolean {
  const search = LINKER_PARAMS_V1.provenance?.fit.thresholdSearch;
  return typeof search === "object" && search !== null && "feasible" in search
    ? search.feasible === true
    : true;
}

/**
 * v1 and its ablations on the items `keep` selects (a split). Every variant is fit on the
 * calibration split, whatever the rows are.
 */
export function ablationTable(
  items: readonly ConfusableItem[],
  entities: readonly EntityRef[],
  keep: (item: ConfusableItem) => boolean,
): AblationRow[] {
  const cases = items.map(linkingCase);
  const variants = [
    {
      name: "v1",
      label: "v1, every signal",
      removed: "",
      params: LINKER_PARAMS_V1,
      feasible: committedFeasible(),
    },
    ...ABLATIONS.map((ablation) => {
      const fitted = fitLinker(items, entities, ablation.config);
      return {
        name: ablation.name,
        label: ablation.label,
        removed: ablation.removed,
        params: fitted.params,
        feasible: fitted.outOfFold.feasible,
      };
    }),
  ];
  return variants.map((variant) => {
    const linker = linkerV1(variant.params, { name: variant.name, baseline: null });
    const rows = score(items, linker.predict(cases, entities)).filter((row) => keep(row.item));
    return {
      ...variant,
      metrics: linkingMetrics(rows, "biased", false),
      ownWrongLinks: rows.filter(
        (row) =>
          !WITNESS_ONLY_CLASSES.includes(row.item.class) &&
          isWrongLink(row.prediction.biased, row.item.gold),
      ).length,
    };
  });
}

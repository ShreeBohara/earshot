// Fits linker v1 on confusable.v1's calibration split and writes its frozen parameters (spec WP4
// steps 4 and 7):
//
//   pnpm --filter @earshot/evals linker:fit [--check]
//
// It writes packages/understanding/src/link/params.v1.json: the feature list, the weights and
// bias, the candidate sources, the thresholds, the calibration split's SHA-256, and the date.
// Review the diff, then commit it. The fit never reads the test split (src/linking/fit.ts).
//
// `--check` refits and compares with the committed file instead of writing it: it exits 1 when
// the weights, thresholds, or calibration hash differ (the date may).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  LINKER_PARAMS_V1,
  type LinkerParams,
  type LinkerProvenance,
} from "@earshot/understanding/link";
import {
  CONFUSABLE_SET_FILE,
  CONFUSABLE_SET_VERSION,
  FIT_LIMITS,
  FOLDS,
  fitLinker,
  LAMBDA,
  LINKING_ENTITIES,
  parseConfusableSet,
  WITNESS_ONLY_CLASSES,
} from "../src/linking";
import { parseArgs, run } from "./args";

const PARAMS_FILE = new URL("../../understanding/src/link/params.v1.json", import.meta.url);

/** SHA-256 of the calibration split's lines, in file order, each with its newline. */
function calibrationSha256(setText: string): string {
  const lines = setText
    .split("\n")
    .filter((line) => line.trim() !== "" && JSON.parse(line).split === "calibration");
  return createHash("sha256")
    .update(lines.map((line) => `${line}\n`).join(""))
    .digest("hex");
}

/**
 * JSON as Biome formats it, so a refit leaves `pnpm check` green: two-space indents, objects
 * expanded, and an array of plain values on one line when that line fits in 100 columns.
 */
function formatJson(value: unknown, indent = "", prefix = ""): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const plain = value.every((item) => item === null || typeof item !== "object");
    const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    if (plain && indent.length + prefix.length + inline.length + 1 <= 100) return inline;
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${formatJson(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const inner = `${indent}  `;
    const lines = entries.map(([key, item]) => {
      const head = `${JSON.stringify(key)}: `;
      return `${inner}${head}${formatJson(item, inner, head)}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** The parameters as the file holds them: what `link` reads, then where it came from. */
function fileShape(params: LinkerParams, provenance: LinkerProvenance) {
  return {
    version: params.version,
    features: params.features,
    weights: params.weights,
    bias: params.bias,
    sources: params.sources,
    thresholds: params.thresholds,
    provenance,
  };
}

run(() => {
  const args = parseArgs(process.argv.slice(2), ["check"]);
  const text = readFileSync(new URL(`../${CONFUSABLE_SET_FILE}`, import.meta.url), "utf8");
  const items = parseConfusableSet(text);
  const fitted = fitLinker(items, LINKING_ENTITIES);
  const sha256 = calibrationSha256(text);
  const provenance: LinkerProvenance = {
    fittedAt: new Date().toISOString().slice(0, 10),
    calibration: {
      set: CONFUSABLE_SET_VERSION,
      split: "calibration",
      sha256,
      items: fitted.items,
      excludedClasses: WITNESS_ONLY_CLASSES,
      rows: fitted.rows,
      positives: fitted.positives,
    },
    fit: {
      model: "L2 logistic regression, Newton's method, standardized features",
      lambda: LAMBDA,
      iterations: fitted.iterations,
      converged: fitted.converged,
      candidateRecall: fitted.candidateRecall,
      thresholdSearch: {
        on: `${FOLDS}-fold out-of-fold probabilities, stratified by class`,
        limits: FIT_LIMITS,
        witnessOnlyClassesAs: "ask",
        points: fitted.outOfFold.points,
        feasiblePoints: fitted.outOfFold.feasiblePoints,
        feasible: fitted.outOfFold.feasible,
        items: fitted.outOfFold.items,
        decided: fitted.outOfFold.decided,
        coverage: fitted.outOfFold.coverage,
        wrongLinks: fitted.outOfFold.wrongLinks,
        wrongAccountRate: fitted.outOfFold.wrongAccountRate,
        newWhenExisting: fitted.outOfFold.newWhenExisting,
        newWhenExistingRate: fitted.outOfFold.newWhenExistingRate,
      },
    },
  };

  if (args.flags.has("check")) {
    const committed = LINKER_PARAMS_V1;
    const problems: string[] = [];
    if (committed.provenance?.calibration.sha256 !== sha256) {
      problems.push("the calibration split's hash differs from the one the params were fit on");
    }
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(committed.features, fitted.params.features)) problems.push("features differ");
    if (!same(committed.sources, fitted.params.sources)) problems.push("sources differ");
    if (!same(committed.thresholds, fitted.params.thresholds)) problems.push("thresholds differ");
    for (const feature of fitted.params.features) {
      const now = fitted.params.weights[feature] ?? Number.NaN;
      const then = committed.weights[feature] ?? Number.NaN;
      if (!(Math.abs(now - then) <= 1e-9)) problems.push(`the ${feature} weight differs`);
    }
    if (!(Math.abs(committed.bias - fitted.params.bias) <= 1e-9)) problems.push("the bias differs");
    if (problems.length > 0) {
      throw new Error(
        `params.v1.json doesn't match a fresh fit: ${problems.join("; ")}. Run linker:fit.`,
      );
    }
    console.log("params.v1.json matches a fresh fit on calibration.");
    return;
  }

  writeFileSync(PARAMS_FILE, `${formatJson(fileShape(fitted.params, provenance))}\n`);
  const { thresholds } = fitted.params;
  const search = fitted.outOfFold;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(
    [
      "Wrote packages/understanding/src/link/params.v1.json. Review the diff, then commit it.",
      `Fit on ${fitted.items} calibration mentions (${WITNESS_ONLY_CLASSES.join(" and ")} left out), ${fitted.rows} candidate rows, ${fitted.positives} positive; gold among the candidates for ${fitted.candidateRecall.found} of ${fitted.candidateRecall.of}.`,
      `Thresholds: τ_link ${thresholds.tauLink}, δ ${thresholds.delta}, τ_new ${thresholds.tauNew} (${search.feasiblePoints} of ${search.points} grid points within the limits).`,
      `Out of fold on calibration: coverage ${pct(search.coverage)} (${search.decided}/${search.items}), wrong-account ${pct(search.wrongAccountRate)} (${search.wrongLinks}), new-when-existing ${pct(search.newWhenExistingRate)} (${search.newWhenExisting}).`,
    ].join("\n"),
  );
});

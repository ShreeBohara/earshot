import { describe, expect, it } from "vitest";
import { planCleanup, prNumbers } from "./janitor";

const workers = [
  "earshot-web",
  "earshot-edge",
  "earshot-edge-pr-3",
  "earshot-web-pr-3",
  "earshot-web-pr-4",
  "earshot-edge-pr-4",
  "someone-elses-worker-pr-3",
];
const branches = [
  { id: "br-1", name: "production" },
  { id: "br-2", name: "dev" },
  { id: "br-3", name: "preview/pr-3" },
  { id: "br-4", name: "preview/pr-4" },
  { id: "br-5", name: "dev/shree" },
];

describe("prNumbers", () => {
  it("finds every PR that owns a preview resource", () => {
    expect(
      prNumbers(
        workers,
        branches.map((b) => b.name),
      ),
    ).toEqual([3, 4]);
  });
});

describe("planCleanup", () => {
  const plan = planCleanup(workers, branches, (pr) => pr === 4);

  it("deletes only resources of closed PRs", () => {
    expect(plan.workers).toEqual(["earshot-web-pr-3", "earshot-edge-pr-3"]);
    expect(plan.branches).toEqual([{ id: "br-3", name: "preview/pr-3" }]);
  });

  it("deletes the web Worker before the edge Worker it binds to", () => {
    expect(plan.workers.indexOf("earshot-web-pr-3")).toBeLessThan(
      plan.workers.indexOf("earshot-edge-pr-3"),
    );
  });

  it("never touches production, dev, personal branches, or other Workers", () => {
    const touched = [...plan.workers, ...plan.branches.map((b) => b.name)];
    for (const name of ["earshot-web", "earshot-edge", "production", "dev", "dev/shree"]) {
      expect(touched).not.toContain(name);
    }
    expect(touched).not.toContain("someone-elses-worker-pr-3");
  });
});

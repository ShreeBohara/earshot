// The dry run (Phase 6 spec decision 18): a request described once, previewed with the credential
// as `Bearer •••` and sent as the same request; placeholders for earlier writes; checks in words.
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PREVIEW,
  checkSentences,
  outcomeRef,
  placeholderId,
  previewOf,
  previewRef,
  type RenderContext,
  type RequestSpec,
  requestOf,
  resolvePreview,
  urlOf,
  type WritePlan,
} from "../src";

const CTX: RenderContext = {
  connection: { id: null, accountId: "acct-1", apiBase: "https://crm.example.test/" },
};

const SPEC: RequestSpec = {
  method: "POST",
  path: "/v1/objects/note",
  headers: { Accept: "application/json" },
  body: { properties: { body: "Met Dana." }, associations: [{ to: { id: placeholderId(0) } }] },
};

const PLAN: Pick<WritePlan, "writes"> = {
  writes: [
    {
      index: 0,
      op: "create",
      object: "company",
      marker: "es_aaaaaaaaaaaaaaaaaaaa",
      ref: null,
      properties: { name: "Acme" },
      associate: [],
    },
  ],
};

describe("the preview and the request", () => {
  it("joins the API base and the path without doubling the slash", () => {
    expect(urlOf(SPEC, CTX)).toBe("https://crm.example.test/v1/objects/note");
    expect(urlOf({ path: "/x" }, { connection: { ...CTX.connection, apiBase: "demo:" } })).toBe(
      "demo:/x",
    );
  });

  it("previews the request with the credential as Bearer •••, and lower-case headers", () => {
    expect(previewOf(SPEC, CTX, { credential: true })).toEqual({
      method: "POST",
      url: "https://crm.example.test/v1/objects/note",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: CREDENTIAL_PREVIEW,
      },
      body: SPEC.body,
    });
    expect(previewOf({ method: "GET", path: "/v1/me" }, CTX, { credential: false })).toEqual({
      method: "GET",
      url: "https://crm.example.test/v1/me",
      headers: {},
      body: null,
    });
  });

  it("sends exactly what it previews, without a credential, which the context adds", async () => {
    const request = requestOf(SPEC, CTX);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://crm.example.test/v1/objects/note");
    expect(Object.fromEntries(request.headers)).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(await request.json()).toEqual(SPEC.body);
    expect(requestOf({ method: "DELETE", path: "/v1/x" }, CTX).body).toBeNull();
  });
});

describe("placeholders", () => {
  it("show an earlier write's record until it has run, and its outcome after", () => {
    expect(previewRef({ write: 0 }, PLAN)).toEqual({
      object: "company",
      id: "(write-0)",
      url: null,
    });
    const linked = { object: "deal", id: "d_1", url: null } as const;
    expect(previewRef(linked, PLAN)).toBe(linked);
    expect(() => previewRef({ write: 3 }, PLAN)).toThrow(RangeError);
    const done = [
      { index: 0, op: "created", ref: { object: "company", id: "c_9", url: null } },
    ] as const;
    expect(outcomeRef({ write: 0 }, done)).toEqual(done[0].ref);
    expect(() => outcomeRef({ write: 1 }, done)).toThrow(RangeError);
  });

  it("resolve in the URL, encoded, and in the body as they are", () => {
    const preview = previewOf(
      {
        method: "PUT",
        path: `/v1/companies/${placeholderId(0)}/notes`,
        body: { on: placeholderId(0) },
      },
      CTX,
      { credential: false },
    );
    const done = [
      { index: 0, op: "created", ref: { object: "company", id: "added:9", url: null } },
    ] as const;
    expect(resolvePreview(preview, done)).toEqual({
      method: "PUT",
      url: "https://crm.example.test/v1/companies/added%3A9/notes",
      headers: { "content-type": "application/json" },
      body: { on: "added:9" },
    });
  });
});

describe("checkSentences", () => {
  it("says each live check in words: a stage by its label, an amount as money, none as empty", () => {
    const ref = { object: "deal", id: "d_1", url: null } as const;
    expect(
      checkSentences(
        [
          { ref, field: "stage", crmField: "dealstage", seen: "Discovery" },
          { ref, field: "stage", crmField: "stage", seen: "qualifiedtobuy" },
          { ref, field: "amount", crmField: "amount", seen: 48_000 },
          { ref, field: "amount", crmField: "amount", seen: 1_250.5 },
          { ref, field: "closeDate", crmField: "closedate", seen: "2026-12-15" },
          { ref, field: "phone", crmField: "phone", seen: null },
          { ref, field: "industry", crmField: "industry", seen: "Robotics" },
        ],
        {
          stages: [{ stageId: "qualifiedtobuy", pipelineId: "default", label: "Qualified to buy" }],
        },
      ),
    ).toEqual([
      "Checks that the stage is still Discovery",
      "Checks that the stage is still Qualified to buy",
      "Checks that the amount is still $48,000",
      "Checks that the amount is still $1,250.50",
      "Checks that the close date is still 2026-12-15",
      "Checks that the phone number is still empty",
      "Checks that the industry is still Robotics",
    ]);
  });
});

// @vitest-environment jsdom
// Integration tests: the real app, reducer, domain and orchestrator, with only fetch, confirm and
// Blob URLs stubbed at the browser boundary.
import Papa from "papaparse";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSuggestResponse, errorEnvelope } from "../../e2e/canonicalModel";
import { replayAudit } from "../domain/auditReplay";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AccordApp } from "./AccordApp";
import {
  button,
  checkbox,
  chooseFiles,
  click,
  count,
  csvFile,
  details,
  mount,
  pageText,
  queryButton,
  rowWith,
  select,
  settle,
  stubFetch,
  stubObjectUrls,
  type,
} from "./testkit";

// The checked-in fixtures, exactly as the page passes them to the app.
const fixture = (name: string) => readFileSync(path.join(process.cwd(), "..", "fixtures", "inventory", name), "utf8");
const SOURCE_A = fixture("source-a.csv");
const SOURCE_B = fixture("source-b.csv");
const samples = { A: { name: "source-a.csv", text: SOURCE_A }, B: { name: "source-b.csv", text: SOURCE_B } };
let app: ReturnType<typeof mount> | null = null;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  app = mount(<AccordApp samples={samples} />);
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  app?.unmount();
  app = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const parse = (csv: string) => Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;

function mapCanonical(sharedUnit = true) {
  for (const side of ["A", "B"] as const) {
    select(`map-${side}-productId`, "c0");
    select(`map-${side}-name`, "c1");
    select(`map-${side}-quantity`, "c2");
  }
  if (sharedUnit) checkbox("Both quantity columns use the same unit").click();
}

async function toReview() {
  await click(button("Try sample data"));
  await click(button("Continue to mapping"));
  mapCanonical();
  await click(button("Confirm mappings"));
}

const stage = () => document.querySelector('[aria-current="step"]')?.textContent;

async function runCanonicalAi() {
  const calls = stubFetch({ "/api/suggest": (body) => ({ status: 200, body: canonicalSuggestResponse(body) }) });
  await click(button("Run AI suggestions"));
  return calls;
}

describe("import", () => {
  it("loads the sample through the normal import path and shows file facts", async () => {
    expect(pageText()).toContain("Choose two CSV exports, or explore the sample.");
    expect(button("2. Mapping").disabled).toBe(true);
    await click(button("Try sample data"));
    expect(pageText()).toContain("source-a.csv");
    expect(pageText()).toContain(`${new TextEncoder().encode(SOURCE_B).length} bytes`);
    expect(pageText()).toMatch(/Records4Columns3/);
    expect(pageText()).toMatch(/Records5Columns3/);
    expect(button("2. Mapping").disabled).toBe(false);
  });

  it("imports two user files, including the same file on both sides", async () => {
    chooseFiles("A", csvFile("same.csv", SOURCE_A));
    chooseFiles("B", csvFile("same.csv", SOURCE_A));
    await settle();
    expect(pageText().match(/Valid CSV/g)).toHaveLength(2);
    await click(button("Continue to mapping"));
    mapCanonical();
    await click(button("Confirm mappings"));
    expect(stage()).toBe("3. Review");
    expect(count("Matched pairs")).toBe(2);
  });

  it("shows a scoped parse error for invalid or unsupported files", async () => {
    chooseFiles("A", csvFile("image.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])));
    chooseFiles("B", csvFile("bad.csv", "a,b\n1,2,3\n"));
    await settle();
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts.some((t) => t?.startsWith("Could not import this file"))).toBe(true);
    expect(pageText()).not.toContain("Valid CSV");
  });

  it("keeps only the newest of two overlapping imports for a side", async () => {
    chooseFiles("A", csvFile("first.csv", SOURCE_A));
    chooseFiles("A", csvFile("second.csv", SOURCE_B));
    await settle();
    expect(pageText()).toContain("second.csv");
    expect(pageText()).not.toContain("first.csv");
  });

  it("asks before replacing a source once work exists, and cancelling keeps the work", async () => {
    await toReview();
    await runCanonicalAi();
    await click(button("1. Import"));
    confirmSpy.mockReturnValue(false);
    chooseFiles("A", csvFile("other.csv", SOURCE_A));
    await settle();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(pageText()).toContain("source-a.csv");
    expect(button("3. Review").disabled).toBe(false);

    confirmSpy.mockReturnValue(true);
    chooseFiles("A", csvFile("other.csv", SOURCE_A));
    await settle();
    expect(pageText()).toContain("other.csv");
    expect(button("3. Review").disabled).toBe(true);
  });
});

describe("mapping", () => {
  beforeEach(async () => {
    await click(button("Try sample data"));
    await click(button("Continue to mapping"));
  });

  it("requires name and quantity, and disables a column already used on that side", () => {
    expect(pageText()).toContain("Select the product-name and quantity columns to continue.");
    expect(pageText().match(/Required\./g)).toHaveLength(4);
    expect(button("Confirm mappings").disabled).toBe(true);
    select("map-A-name", "c1");
    const option = document.querySelector<HTMLOptionElement>('#map-A-quantity option[value="c1"]')!;
    expect(option.disabled).toBe(true);
    expect(document.querySelector<HTMLOptionElement>('#map-B-quantity option[value="c1"]')!.disabled).toBe(false);
  });

  it("lists columns by index and header with real example values", () => {
    const options = [...document.querySelectorAll("#map-A-name option")].map((o) => o.textContent);
    expect(options).toContain("#2 item: Stainless steel flask 750ml, Organic cotton tote natural, Ceramic mug white");
  });

  it("confirms without a product ID mapping, which only disables exact matching", async () => {
    for (const side of ["A", "B"] as const) {
      select(`map-${side}-name`, "c1");
      select(`map-${side}-quantity`, "c2");
    }
    expect(button("Confirm mappings").disabled).toBe(false);
    await click(button("Confirm mappings"));
    expect(count("Matched pairs")).toBe(0);
  });

  it("gates quantity differences on the shared-unit confirmation, hidden once a unit is mapped", async () => {
    mapCanonical(false);
    select("map-A-unit", "c0");
    expect(pageText()).not.toContain("Both quantity columns use the same unit");
    expect(pageText()).toContain("Only one source maps a unit column");
    select("map-A-unit", "");
    expect(pageText()).toContain("Both quantity columns use the same unit");
    select("map-A-productId", "c0");
    await click(button("Confirm mappings"));
    expect(count("Quantity differences")).toBe(0);
    expect(rowWith("P03").textContent).toContain("Confirm comparable units");
  });

  it("keeps the draft and manual mapping when AI mapping fails", async () => {
    select("map-A-name", "c1");
    stubFetch({ "/api/map": (body) => ({ status: 503, body: errorEnvelope("NOT_CONFIGURED", body) }) });
    await click(button("Suggest mappings with AI"));
    expect(pageText()).toContain("AI mapping suggestions are unavailable: AI suggestions are not configured on the API server.");
    expect(pageText()).not.toContain("provider detail");
    expect((document.getElementById("map-A-name") as HTMLSelectElement).value).toBe("c1");
    expect(queryButton("Apply suggested draft")).toBeNull();
    mapCanonical();
    expect(button("Confirm mappings").disabled).toBe(false);
  });

  it("shows an AI mapping as a draft that changes nothing until applied", async () => {
    const calls = stubFetch({
      "/api/map": (body) => {
        const req = JSON.parse(body);
        const side = { mapping: { productId: "c0", name: "c1", quantity: "c2", unit: null }, explanations: { productId: "Codes.", name: "Values resemble product names.", quantity: "Counts.", unit: "None." } };
        return { status: 200, body: JSON.stringify({ requestId: req.requestId, generation: req.generation, A: side, B: side, warnings: [], meta: { provider: "test-double", model: "m", promptVersion: 1, durationMs: 1, attempts: 1, usage: null } }) };
      },
    });
    await click(button("Suggest mappings with AI"));
    expect(JSON.parse(calls[0].body).datasets[1].samples).toHaveLength(5);
    expect(pageText()).toContain("Values resemble product names.");
    expect((document.getElementById("map-A-name") as HTMLSelectElement).value).toBe("");
    await click(button("Apply suggested draft"));
    expect((document.getElementById("map-A-name") as HTMLSelectElement).value).toBe("c1");
    expect(stage()).toBe("2. Mapping");
  });

  it("rejects a confirmation whose draft changed while hashing", async () => {
    mapCanonical();
    act(() => button("Confirm mappings").click());
    select("map-B-productId", "");
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("changed while confirming");
    expect(stage()).toBe("2. Mapping");
  });
});

describe("review and decisions", () => {
  beforeEach(toReview);

  it("shows exact-ID matches and the P03 quantity delta", () => {
    expect(stage()).toBe("3. Review");
    expect(count("Matched pairs")).toBe(2);
    expect(count("Quantity differences")).toBe(1);
    expect(count("Unresolved in A")).toBe(2);
    expect(count("Unresolved in B")).toBe(3);
    const p03 = rowWith("Ceramic mug white");
    expect(p03.textContent).toContain("Matched by product ID");
    expect(p03.textContent).toContain("Quantity differs");
    expect([...p03.cells].map((c) => c.textContent)[5]).toBe("-1");
  });

  it("accepts a suggestion and leaves the ambiguous travel cup unresolved with real evidence", async () => {
    const calls = await runCanonicalAi();
    expect(calls).toHaveLength(1);
    expect(pageText()).toContain("Status: Complete");
    expect(count("Needs review")).toBe(1);
    await details("Organic cotton tote natural");
    expect(pageText()).toContain("Suggested interpretation: Both describe a natural cotton bag.");
    expect(pageText()).toContain("Source B, description: “Natural cotton shopping bag”");
    expect(pageText()).not.toMatch(/confidence/i);
    await click(button("Accept pair"));
    expect(count("Matched pairs")).toBe(3);
    expect(rowWith("Organic cotton tote natural").textContent).toContain("Approved suggestion");
    expect(rowWith("Travel cup blue").textContent).toContain("Unresolved: ambiguous");
  });

  it("rejects, undoes and defers through the workflow", async () => {
    await runCanonicalAi();
    await details("Organic cotton tote natural");
    await click(button("Reject suggestion"));
    expect(rowWith("Organic cotton tote natural").textContent).toContain("Unresolved: rejected");
    await click(button(/^Undo rejection of Natural cotton shopping bag/));
    expect(rowWith("Organic cotton tote natural").textContent).toContain("needs your review");
    await click(button("Leave unresolved"));
    expect(rowWith("Organic cotton tote natural").textContent).toContain("needs your review");
    await details("Travel cup blue");
    await click(button("Leave unresolved"));
    expect(rowWith("Travel cup blue").textContent).toContain("Unresolved: left by you");
  });

  it("excludes and restores an exact-ID match", async () => {
    await details("Stainless steel flask");
    await click(button("Exclude ID match"));
    expect(count("Matched pairs")).toBe(1);
    expect(rowWith("Stainless steel flask").textContent).toContain("Unresolved: rejected");
    await click(button(/^Restore ID match with S\/S bottle/));
    expect(rowWith("Stainless steel flask").textContent).toContain("Matched by product ID");
  });

  it("pairs manually from every eligible record, including zero-overlap ones, and undoes it", async () => {
    await details("Travel cup blue");
    const picker = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(pageText()).toContain("(3 eligible)");
    expect(queryButton(/^Pair with S\/S bottle/)).toBeNull();
    type(picker, "500");
    expect(queryButton(/^Pair with Travel tumbler blue 350ml/)).toBeNull();
    await click(button(/^Pair with Travel tumbler blue 500ml/));
    expect(rowWith("Travel cup blue").textContent).toContain("Manual match");
    await click(button("Undo match"));
    expect(rowWith("Travel cup blue").textContent).toContain("Unresolved");
    await click(button(/^Pair with Natural cotton shopping bag/));
    expect(count("Matched pairs")).toBe(3);
  });

  it("allows human decisions while an analysis request is in flight, then cancels", async () => {
    let release: (() => void) | null = null;
    stubFetch({ "/api/suggest": (body) => new Promise((r) => (release = () => r({ status: 200, body: canonicalSuggestResponse(body) }))) });
    await click(button("Run AI suggestions"));
    expect(pageText()).toContain("Status: Running");
    await details("Organic cotton tote natural");
    await click(button(/^Pair with Natural cotton shopping bag/));
    expect(count("Matched pairs")).toBe(3);
    expect(button("Continue to export").disabled).toBe(true);
    await click(button("Cancel analysis"));
    expect(pageText()).toContain("Status: Cancelled");
    (release as unknown as () => void)();
    await settle();
    expect(count("Matched pairs")).toBe(3);
    expect(count("Needs review")).toBe(0);
    expect(rowWith("Travel cup blue").textContent).toContain("analysis cancelled");
    expect(button("Continue to export").disabled).toBe(false);
  });

  it("surfaces a rejected decision as a typed alert without changing state", async () => {
    await details("Ceramic mug white");
    // Two clicks before React re-renders: the second targets a pair that no longer exists.
    const exclude = button("Exclude ID match");
    act(() => {
      exclude.click();
      exclude.click();
    });
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Only a current product-ID match can be excluded.");
    expect(count("Matched pairs")).toBe(1);
  });
});

describe("conflicting and duplicate identifiers", () => {
  it("never offers quarantined or conflicting records in the manual picker", async () => {
    chooseFiles("A", csvFile("a.csv", "sku,item,qty\nD1,Blue mug,1\nX1,Red mug,2\n,Green mug,3\n"));
    chooseFiles("B", csvFile("b.csv", "code,desc,stock\nD1,Blue mug,1\nD1,Blue mug copy,1\nY9,Red mug,2\n,Green mug,3\n"));
    await settle();
    await click(button("Continue to mapping"));
    mapCanonical();
    await click(button("Confirm mappings"));
    await click(button("Identifier conflicts"));
    expect(rowWith("Blue mug [D1]").textContent).toContain("Identifier conflict: duplicate ID");
    await details("Blue mug [D1]");
    expect(pageText()).toContain("No Source B record can be paired with this record.");
    await click(button("All"));
    await details("Red mug [X1]");
    expect(queryButton(/^Pair with Red mug \[Y9\]/)).toBeNull();
    expect(queryButton(/^Pair with Blue mug/)).toBeNull();
    expect(queryButton(/^Pair with Green mug/)).not.toBeNull();
  });
});

describe("AI failures", () => {
  beforeEach(toReview);

  it("shows UPSTREAM_ERROR, keeps exact matches and manual review, and still exports", async () => {
    const urls = stubObjectUrls();
    stubFetch({ "/api/suggest": (body) => ({ status: 502, body: errorEnvelope("UPSTREAM_ERROR", body) }) });
    await click(button("Run AI suggestions"));
    expect(pageText()).toContain("Status: Failed");
    expect(pageText()).toContain("The AI provider returned an error. (UPSTREAM_ERROR)");
    expect(pageText()).toContain("AI suggestions are unavailable. Exact matches and manual review still work.");
    expect(pageText()).not.toContain("provider detail");
    expect(pageText()).toContain("Last request: provider not reported, model not reported, result failed.");
    expect(count("Matched pairs")).toBe(2);
    await details("Organic cotton tote natural");
    await click(button(/^Pair with Natural cotton shopping bag/));
    expect(count("Matched pairs")).toBe(3);
    await click(button("Continue to export"));
    expect(pageText()).toContain("AI analysis was incomplete (failed)");
    await click(button("Prepare export"));
    const audit = JSON.parse(await [...urls.live.values()][2].text());
    expect(audit.analysis.status).toBe("failed");
    expect(audit.acceptedPairs.map((p: { method: string }) => p.method)).toEqual(["exact_id", "exact_id", "manual"]);
    expect(audit.modelRuns).toHaveLength(1);
    expect(audit.modelRuns[0]).toMatchObject({ provider: "", model: "", result: "failed" });
  });

  it("treats a malformed response as a failure without inventing suggestions", async () => {
    stubFetch({ "/api/suggest": () => ({ status: 200, body: "<html>proxy error</html>" }) });
    await click(button("Run AI suggestions"));
    expect(pageText()).toContain("The analysis API returned an unreadable response.");
    expect(count("Needs review")).toBe(0);
  });
});

describe("partial analysis", () => {
  it("reports a failed batch as partial and keeps the batch that succeeded", async () => {
    const a = ["sku,item,qty", ...Array.from({ length: 7 }, (_, i) => `,Widget model ${i},${i}`)].join("\n") + "\n";
    const b = ["code,desc,stock", ...Array.from({ length: 6 }, (_, i) => `,Widget model ${i} grey,${i}`)].join("\n") + "\n";
    chooseFiles("A", csvFile("a.csv", a));
    chooseFiles("B", csvFile("b.csv", b));
    await settle();
    await click(button("Continue to mapping"));
    mapCanonical();
    await click(button("Confirm mappings"));
    let n = 0;
    stubFetch({
      "/api/suggest": (body) => {
        if (++n === 1) return { status: 502, body: errorEnvelope("MODEL_INVALID_OUTPUT", body) };
        const req = JSON.parse(body);
        const proposals = req.rows.map((r: { left: { rowId: string; fields: unknown[] }; candidates: Array<{ rowId: string; fields: unknown[] }> }) => ({
          leftId: r.left.rowId,
          rightId: null,
          outcome: "abstain",
          reasonCode: "insufficient_evidence",
          evidence: [r.left.fields[0]],
          explanation: "Not enough evidence.",
          generation: req.generation,
          configurationHash: req.configurationHash,
        }));
        return { status: 200, body: JSON.stringify({ requestId: req.requestId, generation: req.generation, configurationHash: req.configurationHash, proposals, meta: { provider: "test-double", model: "m", promptVersion: 1, durationMs: 1, attempts: 1, usage: null } }) };
      },
    });
    await click(button("Run AI suggestions"));
    expect(pageText()).toContain("Status: Partial");
    expect(pageText()).toContain("2 of 7 selected records analyzed, 5 failed");
    expect(pageText()).toContain("The model could not produce a verified suggestion for these records.");
  });
});

describe("export", () => {
  it("downloads three artifacts from one snapshot with the canonical counts and a replayable audit", async () => {
    const urls = stubObjectUrls();
    await toReview();
    await runCanonicalAi();
    await details("Organic cotton tote natural");
    await click(button("Accept pair"));
    await click(button("Continue to export"));
    expect(pageText()).toContain("3 matched pairs. 1 unresolved record in A, 2 in B.");
    await click(button("Prepare export"));

    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[download]")];
    expect(links.map((l) => [l.getAttribute("download"), l.getAttribute("type")])).toEqual([
      ["matches.csv", "text/csv;charset=utf-8"],
      ["unresolved.csv", "text/csv;charset=utf-8"],
      ["audit.json", "application/json"],
    ]);
    expect(urls.api.createObjectURL).toHaveBeenCalledTimes(3);
    const blobs = links.map((l) => urls.live.get(l.getAttribute("href")!)!);
    expect(blobs.map((b) => b.type)).toEqual(["text/csv;charset=utf-8", "text/csv;charset=utf-8", "application/json"]);
    const [matches, unresolved, auditText] = await Promise.all(blobs.map((b) => b.text()));

    const m = parse(matches);
    expect(m).toHaveLength(3);
    expect(m.find((r) => r.left_product_id === "P03")).toMatchObject({ delta_b_minus_a: "-1", quantity_status: "different" });
    expect(m.map((r) => r.match_method)).toEqual(["exact_id", "ai_reviewed", "exact_id"]);
    const u = parse(unresolved);
    expect(u.map((r) => [r.source, r.reason_code])).toEqual([
      ["A", "ambiguous"],
      ["B", "unpaired"],
      ["B", "unpaired"],
    ]);

    const audit = JSON.parse(auditText);
    expect(audit.modelRuns).toEqual([expect.objectContaining({ provider: "test-double", model: "deterministic-canonical", result: "valid" })]);
    const replay = await replayAudit(audit);
    expect(replay.ok && replay.value.files["matches.csv"]).toBe(matches);
    expect(replay.ok && replay.value.files["unresolved.csv"]).toBe(unresolved);
  });

  it("escapes formula-like cells in CSV while the audit keeps the raw value", async () => {
    const urls = stubObjectUrls();
    chooseFiles("A", csvFile("a.csv", "sku,item,qty\nP1,=HYPERLINK(1),1\n"));
    chooseFiles("B", csvFile("b.csv", "code,desc,stock\nP1,Mug,1\n"));
    await settle();
    await click(button("Continue to mapping"));
    mapCanonical();
    await click(button("Confirm mappings"));
    await click(button("Continue to export"));
    await click(button("Prepare export"));
    const [matches, , audit] = await Promise.all([...urls.live.values()].map((b) => b.text()));
    expect(parse(matches)[0].left_name).toBe("'=HYPERLINK(1)");
    expect(JSON.parse(audit).datasets[0].rows[0].cells[1]).toBe("=HYPERLINK(1)");
  });

  it("removes and revokes the downloads when the workflow resets", async () => {
    const urls = stubObjectUrls();
    await toReview();
    await click(button("Continue to export"));
    await click(button("Prepare export"));
    expect(document.querySelectorAll("a[download]")).toHaveLength(3);
    await click(button("Start over"));
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(urls.revoked).toHaveLength(3);
    expect(urls.live.size).toBe(0);
  });
});


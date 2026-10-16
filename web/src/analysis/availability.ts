import type { Dataset } from "../domain/types";

// The built-in sample's dataset ids (SHA-256 of fixtures/inventory/source-{a,b}.csv), the only data
// the hosted gateway forwards. gatewaySample.test.ts keeps them equal to gateway/src/sample.json.
export const HOSTED_SAMPLE_IDS = { A: "8dbb636ca54bdbf76c9d2ad92fcfba0c49c348af11b453d0f1ad19f42adcb5c8", B: "b4ce8ee01b3273c97e8deb7640ce06cfc5181c3cf046aac7f8409ee03cccef58" } as const;

export type AiAvailability = "available" | "off" | "sample-only";

// Local and Docker: always. Static build (next.config.ts): only with a gateway (ACCORD_API_BASE), and
// only for the built-in sample, so a user's own files never leave the browser.
// A function, not a constant, so tests can stub the inlined env values.
export function aiAvailability(datasets: { A: Dataset; B: Dataset } | null): AiAvailability {
  if (process.env.ACCORD_DEPLOY_TARGET !== "cloudflare-static") return "available";
  if (!process.env.ACCORD_API_BASE) return "off";
  return datasets?.A.id === HOSTED_SAMPLE_IDS.A && datasets.B.id === HOSTED_SAMPLE_IDS.B ? "available" : "sample-only";
}

// Empty locally (same origin, proxied by next.config.ts); the gateway origin in a hosted static build.
export const apiUrl = (path: `/api/${string}`) => `${process.env.ACCORD_API_BASE ?? ""}${path}`;

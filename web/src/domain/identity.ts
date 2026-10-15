import type { RowId, Side } from "./types";

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// §4.2: side disambiguates identical files loaded as A and B.
export function rowIdOf(side: Side, datasetId: string, dataRecordIndex: number): RowId {
  return `${side}:${datasetId}:${dataRecordIndex}`;
}

// JavaScript has no String.prototype.caseFold. Upper-then-lower approximates Unicode full
// case folding (e.g. "ß" and "SS" both become "ss") without locale-specific rules.
export function caseFold(s: string): string {
  return s.toUpperCase().toLowerCase();
}

// §4.3: trim only; never parse as a number, strip punctuation or drop leading zeros.
export function normalizeId(raw: string, caseSensitive: boolean): string {
  const trimmed = raw.trim();
  return caseSensitive ? trimmed : caseFold(trimmed);
}

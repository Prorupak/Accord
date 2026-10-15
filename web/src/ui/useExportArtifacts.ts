"use client";

// Browser lifecycle around prepareExport: one snapshot per explicit prepare, three Blob URLs made
// from that snapshot, and revocation whenever the snapshot stops being current. The URLs live in
// component state only, never in workflow state or storage.
import { useCallback, useEffect, useRef, useState } from "react";
import { isSnapshotCurrent, prepareExport, type ExportMeta, type ExportSnapshot } from "../domain/exportSnapshot";
import type { Violation } from "../domain/invariants";
import type { ReconciliationState } from "../domain/reconcile";

export const ARTIFACTS = [
  { name: "matches.csv", type: "text/csv;charset=utf-8" },
  { name: "unresolved.csv", type: "text/csv;charset=utf-8" },
  { name: "audit.json", type: "application/json" },
] as const;

export type ArtifactName = (typeof ARTIFACTS)[number]["name"];
export type ArtifactUrls = Record<ArtifactName, string>;
type UrlApi = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export const revokeAll = (urls: ArtifactUrls, api: UrlApi = URL) => Object.values(urls).forEach((u) => api.revokeObjectURL(u));

// All three or none: a failure part-way revokes the URLs already created.
export function createArtifactUrls(snapshot: ExportSnapshot, api: UrlApi = URL): ArtifactUrls | null {
  const made: Partial<ArtifactUrls> = {};
  try {
    for (const a of ARTIFACTS) made[a.name] = api.createObjectURL(new Blob([snapshot.files[a.name]], { type: a.type }));
    return made as ArtifactUrls;
  } catch {
    Object.values(made).forEach((u) => api.revokeObjectURL(u));
    return null;
  }
}

type Entry = { context: ReconciliationState["context"]; snapshot: ExportSnapshot; urls: ArtifactUrls };

export type PrepareResult = { ok: true } | { ok: false; violations: Violation[] } | { ok: false; violations: null };

// Context identity catches a reload of the same file reconfirmed to an equal hash and revision.
const isCurrent = (entry: Entry | null, rec: ReconciliationState | null): entry is Entry =>
  entry !== null && rec !== null && entry.context === rec.context && isSnapshotCurrent(rec, entry.snapshot);

export function useExportArtifacts(rec: ReconciliationState | null) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const current = isCurrent(entry, rec) ? entry : null;

  // Read by click handlers and the unmount cleanup, which must see the latest commit.
  const latest = useRef({ entry, rec });
  useEffect(() => {
    latest.current = { entry, rec };
  });

  useEffect(() => {
    if (entry && !current) revokeAll(entry.urls);
  }, [entry, current]);

  useEffect(
    () => () => {
      const e = latest.current.entry;
      if (e) revokeAll(e.urls);
    },
    [],
  );

  const prepare = useCallback(
    (meta: ExportMeta): PrepareResult => {
      if (!rec) return { ok: false, violations: null };
      const r = prepareExport(rec, meta);
      if (!r.ok) return { ok: false, violations: r.violations };
      const urls = createArtifactUrls(r.snapshot);
      if (!urls) return { ok: false, violations: null };
      const previous = latest.current.entry;
      if (previous) revokeAll(previous.urls);
      setEntry({ context: rec.context, snapshot: r.snapshot, urls });
      return { ok: true };
    },
    [rec],
  );

  // Guards the gap between a state change and the render that hides the links.
  const isStillCurrent = useCallback(() => isCurrent(latest.current.entry, latest.current.rec), []);

  return { artifacts: current, prepare, isStillCurrent };
}

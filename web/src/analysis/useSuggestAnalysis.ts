"use client";

// React adapter for the suggestion runner. It owns no workflow state: it dispatches
// analysis/started on explicit user intent, waits for React to commit the run, then executes that
// committed run exactly once. Request building, transport and validation live outside React.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import type { ModelRun } from "../domain/exportSnapshot";
import * as select from "../workflow/selectors";
import type { RunRef, WorkflowAction, WorkflowState } from "../workflow/types";
import type { AnalysisFailure } from "./contract";
import { fetchTransport, startSuggestRun, type Execution, type RunDeps } from "./runner";

export type SuggestAnalysisOptions = Partial<Pick<RunDeps, "transport" | "newId" | "now" | "runDeadlineMs">>;

const keyOf = (r: RunRef) => `${r.generation}:${r.configurationHash}`;

export function useSuggestAnalysis(
  workflow: { state: WorkflowState; dispatch: Dispatch<WorkflowAction> },
  options: SuggestAnalysisOptions = {},
) {
  const { state, dispatch } = workflow;
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  const execution = useRef<Execution | null>(null);
  // Set between dispatching analysis/started and the commit that reflects it.
  const pendingStart = useRef(false);
  const cancelBeforeCommit = useRef(false);
  const [records, setRecords] = useState<ReadonlyArray<{ configurationHash: string; run: ModelRun }>>([]);
  const [failures, setFailures] = useState<readonly AnalysisFailure[]>([]);

  // Declared first so the run effect below always reads this commit's state.
  useEffect(() => {
    stateRef.current = state;
    optionsRef.current = options;
    pendingStart.current = false;
  });

  const run = select.activeRun(state);
  const runKey = run ? keyOf(run) : null;

  useEffect(() => {
    // The run this execution belongs to ended or was replaced elsewhere (reconfiguration, source
    // replaced): stop waiting on it. Its dispatches are stale and the reducer ignores them.
    const current = execution.current;
    if (current && keyOf(current.ref) !== runKey) {
      execution.current = null;
      current.cancel();
    }
    const committed = select.activeRun(stateRef.current);
    if (!committed || execution.current) return;
    if (cancelBeforeCommit.current) {
      cancelBeforeCommit.current = false;
      dispatch({ type: "analysis/cancelled", generation: committed.generation, configurationHash: committed.configurationHash });
      return;
    }
    const o = optionsRef.current;
    const exec = startSuggestRun(
      committed,
      { getState: () => stateRef.current, dispatch },
      {
        transport: o.transport ?? fetchTransport,
        newId: o.newId ?? (() => crypto.randomUUID()),
        now: o.now ?? (() => performance.now()),
        runDeadlineMs: o.runDeadlineMs,
        onRecord: (r) => setRecords((xs) => [...xs, { configurationHash: committed.configurationHash, run: r }]),
        onFailure: (f) => setFailures((xs) => [...xs, f]),
      },
    );
    execution.current = exec;
    void exec.done.then(() => {
      if (execution.current === exec) execution.current = null;
    });
  }, [runKey, dispatch]);

  // Leaving the screen cancels the run; validated results already applied are kept.
  useEffect(
    () => () => {
      const current = execution.current;
      execution.current = null;
      current?.cancel();
    },
    [],
  );

  // Returns false when ignored: a run is active, starting, or still being torn down.
  const start = useCallback((): boolean => {
    if (pendingStart.current || execution.current || select.activeRun(stateRef.current)) return false;
    pendingStart.current = true;
    cancelBeforeCommit.current = false;
    setFailures([]);
    dispatch({ type: "analysis/started" });
    return true;
  }, [dispatch]);

  // Idempotent; safe at any point of the run's life.
  const cancel = useCallback(() => {
    const current = execution.current;
    if (current) {
      execution.current = null;
      current.cancel();
      return;
    }
    const active = select.activeRun(stateRef.current);
    if (active) dispatch({ type: "analysis/cancelled", generation: active.generation, configurationHash: active.configurationHash });
    else if (pendingStart.current) cancelBeforeCommit.current = true;
  }, [dispatch]);

  const configurationHash = state.reconciliation?.context.configurationHash ?? null;
  const modelRuns = useMemo(
    () => records.filter((r) => r.configurationHash === configurationHash).map((r) => r.run),
    [records, configurationHash],
  );

  return {
    start,
    cancel,
    status: select.analysisStatus(state),
    progress: select.analysisProgress(state),
    canStart: select.canStartAnalysis(state),
    // For audit.json modelRuns (ExportMeta); only requests made under the current configuration.
    modelRuns,
    // Failures of the latest run, newest last. Messages are fixed client text.
    failures,
  };
}

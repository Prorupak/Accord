// Executes one committed analysis run: at most four sequential /api/suggest requests, one in
// flight at a time, every result validated against the request that was sent and then handed to
// the workflow reducer, which stays the authority on what is applied (spec §8.2, §9).
import { candidatesFor } from "../domain/candidates";
import type { ModelRun } from "../domain/exportSnapshot";
import { isStaleResult } from "../workflow/selectors";
import type { RunRef, WorkflowAction, WorkflowState } from "../workflow/types";
import { failure, SUGGEST_LIMITS, type AnalysisFailure, type InferenceMeta } from "./contract";
import { buildSuggestRequest } from "./request";
import { readSuggestResponse, type HttpResult, type ReadResult } from "./response";

export type Transport = (body: string, signal: AbortSignal) => Promise<HttpResult>;

// Same-origin; next.config.ts rewrites /api/* to the FastAPI server. No client retries: the
// server owns the provider retry and repair budget.
export const fetchTransport: Transport = async (body, signal) => {
  const res = await fetch("/api/suggest", { method: "POST", headers: { "content-type": "application/json" }, body, signal });
  return { status: res.status, body: await res.text() };
};

export type RunIO = {
  // The latest committed workflow state. It may lag a dispatch just made; the reducer rechecks.
  readonly getState: () => WorkflowState;
  readonly dispatch: (action: WorkflowAction) => void;
};

export type RunDeps = {
  readonly transport: Transport;
  readonly newId: () => string;
  readonly now: () => number;
  readonly runDeadlineMs?: number;
  readonly onRecord?: (run: ModelRun) => void;
  readonly onFailure?: (f: AnalysisFailure) => void;
};

// completed / failed / deadline: this runner settled the run. cancelled: cancel() was called.
// superseded: the run stopped being current elsewhere (reconfiguration, source replaced).
export type RunOutcome = "completed" | "failed" | "deadline" | "cancelled" | "superseded";

export type Execution = { readonly ref: RunRef; readonly cancel: () => void; readonly done: Promise<RunOutcome> };

export function startSuggestRun(run: RunRef & { selectedRowIds: readonly string[] }, io: RunIO, deps: RunDeps): Execution {
  const ref: RunRef = { generation: run.generation, configurationHash: run.configurationHash };
  const controller = new AbortController();
  let cancelled = false;
  let deadlineHit = false;
  let settled = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    controller.abort("deadline");
  }, deps.runDeadlineMs ?? SUGGEST_LIMITS.runDeadlineMs);

  // Idempotent. Aborting stops our wait and any later application of the result; it does not
  // guarantee the provider stopped work it already began (§8.2). The reducer ignores the
  // cancellation if the run already ended, and its generation change rejects late events.
  const cancel = () => {
    if (settled || cancelled) return;
    cancelled = true;
    controller.abort("cancelled");
    io.dispatch({ type: "analysis/cancelled", ...ref });
  };

  const halted = (): RunOutcome | null =>
    cancelled ? "cancelled" : isStaleResult(io.getState(), ref) ? "superseded" : deadlineHit ? "deadline" : null;

  const report = (f: AnalysisFailure) => deps.onFailure?.(f);

  async function loop(): Promise<RunOutcome> {
    const selected = run.selectedRowIds.slice(0, SUGGEST_LIMITS.maxRowsPerPass);
    const chunks: string[][] = [];
    for (let i = 0; i < selected.length && chunks.length < SUGGEST_LIMITS.maxRequestsPerPass; i += SUGGEST_LIMITS.maxSuggestRows)
      chunks.push(selected.slice(i, i + SUGGEST_LIMITS.maxSuggestRows));

    for (const chunk of chunks) {
      const stop = halted();
      if (stop === "deadline") {
        report(failure("CLIENT_DEADLINE", null, []));
        io.dispatch({ type: "analysis/completed", ...ref });
      }
      if (stop) return stop;

      // Only rows that still need inference: a human may have paired the row or its candidates
      // since the run started. Skipped rows keep their own reason (see analysis/completed).
      const rec = io.getState().reconciliation!;
      const rowIds = chunk.filter((id) => candidatesFor(rec, id).length > 0);
      if (rowIds.length === 0) continue;

      const requestId = deps.newId();
      const built = buildSuggestRequest(rec, rowIds, requestId);
      if (!built.ok) {
        report(built.error);
        io.dispatch({ type: "analysis/batchFailed", ...ref, rowIds });
        if (built.error.scope === "run") {
          io.dispatch({ type: "analysis/failed", ...ref, message: built.error.message });
          return "failed";
        }
        continue;
      }

      const startedAt = deps.now();
      let result: ReadResult;
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        result = readSuggestResponse(built.value.request, await deps.transport(built.value.body, controller.signal));
      } catch {
        const code = cancelled ? "CANCELLED" : deadlineHit ? "CLIENT_DEADLINE" : "NETWORK";
        result = { ok: false, error: failure(code, requestId, rowIds), meta: null };
      }

      const after = halted();
      const status = after === "cancelled" || after === "superseded" ? "cancelled" : result.ok ? "valid" : "failed";
      deps.onRecord?.(modelRun(requestId, result.meta, Math.max(0, Math.round(deps.now() - startedAt)), status));
      if (after === "cancelled" || after === "superseded") return after;

      if (result.ok) {
        io.dispatch({ type: "analysis/batchReceived", batch: result.batch, rowIds });
        continue;
      }
      report(result.error);
      // An attempted request without a verified result: its rows failed, never "analyzed".
      io.dispatch({ type: "analysis/batchFailed", ...ref, rowIds });
      if (result.error.code === "CLIENT_DEADLINE") {
        io.dispatch({ type: "analysis/completed", ...ref });
        return "deadline";
      }
      if (result.error.scope === "run") {
        io.dispatch({ type: "analysis/failed", ...ref, message: result.error.message });
        return "failed";
      }
    }

    const stop = halted();
    if (stop === "cancelled" || stop === "superseded") return stop;
    io.dispatch({ type: "analysis/completed", ...ref });
    return stop ?? "completed";
  }

  const done = (async () => {
    try {
      return await loop();
    } catch {
      // A bug here must not leave the run spinning; existing results are preserved.
      if (!cancelled && !isStaleResult(io.getState(), ref))
        io.dispatch({ type: "analysis/failed", ...ref, message: "Analysis stopped because of an unexpected error." });
      return "failed" as const;
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  })();

  return { ref, cancel, done };
}

// §7.5: only what the server reported. Without metadata (error or no response) provider, model
// and prompt version are empty and tokens null; nothing is estimated.
function modelRun(requestId: string, meta: InferenceMeta | null, durationMs: number, result: ModelRun["result"]): ModelRun {
  return {
    requestId,
    provider: meta?.provider ?? "",
    model: meta?.model ?? "",
    promptVersion: meta ? String(meta.promptVersion) : "",
    durationMs,
    inputTokens: meta?.usage?.inputTokens ?? null,
    outputTokens: meta?.usage?.outputTokens ?? null,
    result,
  };
}

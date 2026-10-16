"use client";

// The one React owner of workflow state. IDs, timestamps and import tokens are created here, at
// the dispatch boundary, so the reducer stays deterministic. No network, timers or downloads.
import { useCallback, useMemo, useReducer } from "react";
import type { DecisionAction, RowId, Side } from "../domain/types";
import { parseSource, prepareConfirmation, type Confirmation } from "./boundary";
import * as select from "./selectors";
import { initialWorkflowState, workflowReducer } from "./workflowReducer";

type ConfirmAction = Extract<Confirmation, { ok: true }>["action"];

export function useAccordWorkflow() {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);

  const view = useMemo(
    () => ({
      mappingErrors: select.mappingErrors(state),
      canConfirmMappings: select.canConfirmMappings(state),
      canStartAnalysis: select.canStartAnalysis(state),
      canExport: select.canExport(state),
      counts: select.counts(state),
      analysisStatus: select.analysisStatus(state),
      analysisProgress: select.analysisProgress(state),
      activeRun: select.activeRun(state),
      hasRecoverableError: select.hasRecoverableError(state),
    }),
    [state],
  );

  const chooseFile = useCallback(async (side: Side, file: File) => {
    const token = crypto.randomUUID();
    dispatch({ type: "import/started", side, token });
    dispatch(await parseSource(side, token, file.name, new Uint8Array(await file.arrayBuffer())));
  }, []);

  // Uses the state of the render that called it; the reducer rejects the result if the sources
  // or draft changed while hashing. `approve` sees the prepared action first and may decline it,
  // e.g. after asking the user whether existing decisions may be discarded.
  const confirmMappings = useCallback(
    async (approve?: (action: ConfirmAction) => boolean) => {
      const r = await prepareConfirmation(state);
      if (r.ok && (!approve || approve(r.action))) dispatch(r.action);
      return r;
    },
    [state],
  );

  // Returns the decision ID so a caller can retry the same intent idempotently.
  const decide = useCallback(
    (action: DecisionAction, leftId: RowId, rightId: RowId | null, proposalId: string | null = null) => {
      const id = crypto.randomUUID();
      dispatch({
        type: "decision/requested",
        decision: {
          id,
          action,
          leftId,
          rightId,
          proposalId,
          configurationHash: state.reconciliation?.context.configurationHash ?? "",
          at: new Date().toISOString(),
        },
      });
      return id;
    },
    [state.reconciliation],
  );

  return { state, dispatch, view, chooseFile, confirmMappings, decide };
}

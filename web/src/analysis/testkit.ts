// Test-only: a transport whose every call the test resolves, rejects or abandons by hand, and a
// minimal {getState, dispatch} over the real workflow reducer.
import { activeRun } from "../workflow/selectors";
import { confirmed } from "../workflow/testkit";
import type { WorkflowAction, WorkflowState } from "../workflow/types";
import { workflowReducer } from "../workflow/workflowReducer";
import type { InferenceMeta, SuggestRequest, SuggestResponse } from "./contract";
import type { HttpResult } from "./response";
import type { Transport } from "./runner";

export type Call = {
  readonly body: string;
  readonly request: SuggestRequest;
  readonly signal: AbortSignal;
  resolve(r: HttpResult): void;
  reject(e: unknown): void;
};

// `ignoreAbort` models a request whose response still arrives after the abort.
export function fakeTransport(opts: { ignoreAbort?: boolean } = {}) {
  const calls: Call[] = [];
  let open = 0;
  let maxOpen = 0;
  let waiters: Array<() => void> = [];
  const transport: Transport = (body, signal) =>
    new Promise<HttpResult>((resolve, reject) => {
      let done = false;
      const settle = (f: () => void) => {
        if (done) return;
        done = true;
        open--;
        f();
      };
      const call: Call = { body, request: JSON.parse(body), signal, resolve: (r) => settle(() => resolve(r)), reject: (e) => settle(() => reject(e)) };
      open++;
      maxOpen = Math.max(maxOpen, open);
      if (!opts.ignoreAbort) {
        if (signal.aborted) call.reject(signal.reason);
        else signal.addEventListener("abort", () => call.reject(signal.reason), { once: true });
      }
      calls.push(call);
      const ready = waiters;
      waiters = [];
      ready.forEach((w) => w());
    });
  // Resolves once the nth call (1-based) has been made.
  const call = async (n: number): Promise<Call> => {
    while (calls.length < n) await new Promise<void>((r) => waiters.push(r));
    return calls[n - 1];
  };
  return {
    transport,
    calls,
    call,
    get maxOpen() {
      return maxOpen;
    },
  };
}

export const META: InferenceMeta = {
  provider: "openrouter",
  model: "test/model-1",
  promptVersion: 1,
  durationMs: 12,
  attempts: 1,
  usage: { inputTokens: 100, outputTokens: 20 },
};

type Row = SuggestRequest["rows"][number];
type Result = Omit<SuggestResponse["proposals"][number], "generation" | "configurationHash">;

export const suggestFirst = (row: Row): Result => ({
  leftId: row.left.rowId,
  rightId: row.candidates[0].rowId,
  outcome: "suggest",
  reasonCode: "semantic_equivalence",
  evidence: [row.left.fields[0], row.candidates[0].fields[0]],
  explanation: "Same product.",
});

export const abstain = (row: Row): Result => ({
  leftId: row.left.rowId,
  rightId: null,
  outcome: "abstain",
  reasonCode: "insufficient_evidence",
  evidence: [row.left.fields[0]],
  explanation: "Not enough evidence.",
});

export function responseBody(request: SuggestRequest, pick: (row: Row) => Result = suggestFirst, meta: InferenceMeta = META): SuggestResponse {
  const { requestId, generation, configurationHash } = request;
  return { requestId, generation, configurationHash, proposals: request.rows.map((r) => ({ ...pick(r), generation, configurationHash })), meta };
}

export const ok = (request: SuggestRequest, pick?: (row: Row) => Result, meta?: InferenceMeta): HttpResult => ({
  status: 200,
  body: JSON.stringify(responseBody(request, pick, meta)),
});

export const apiError = (status: number, code: string, request: SuggestRequest | null, extra: Record<string, unknown> = {}): HttpResult => ({
  status,
  body: JSON.stringify({ error: { code, message: "server text", retryable: false, requestId: request?.requestId ?? "", ...extra } }),
});

export function store(initial: WorkflowState) {
  let state = initial;
  const actions: WorkflowAction[] = [];
  return {
    getState: () => state,
    dispatch: (a: WorkflowAction) => {
      actions.push(a);
      state = workflowReducer(state, a);
    },
    actions,
  };
}

// `n` Source A rows that all share name words with `m` Source B rows; no product IDs, so nothing
// pairs exactly and every A row has min(m, 5) candidates.
export function widgets(n: number, m = 6) {
  const a = ["sku,item,qty", ...Array.from({ length: n }, (_, i) => `,Widget model ${i},${i}`)].join("\n");
  const b = ["code,desc,stock", ...Array.from({ length: m }, (_, i) => `,Widget model ${i} grey,${i}`)].join("\n");
  return { a: `${a}\n`, b: `${b}\n` };
}

export async function runningStore(a?: string, b?: string) {
  const s = store(await confirmed(a, b));
  s.dispatch({ type: "analysis/started" });
  const run = activeRun(s.getState());
  if (!run) throw new Error("run did not start");
  return { ...s, run };
}

export const ids = () => {
  let n = 0;
  return () => `req-${++n}`;
};

import { getAuth } from "../../../../src/server/auth";

// Node.js runtime: the default, and `export const runtime` is rejected under cacheComponents.

const NO_STORE = { "cache-control": "private, no-store" };

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

// Better Auth owns every path, method and response under /api/auth. This only adds the
// not-configured state and keeps database or library failures out of response bodies.
async function handle(request: Request): Promise<Response> {
  const auth = getAuth();
  if (!auth) return error(503, "NOT_CONFIGURED", "Accounts are not configured on this server.");
  let response: Response;
  try {
    response = await auth.handler(request);
  } catch {
    return error(503, "STORAGE_UNAVAILABLE", "Accounts are temporarily unavailable.");
  }
  if (response.status >= 500) return error(503, "STORAGE_UNAVAILABLE", "Accounts are temporarily unavailable.");
  response.headers.set("cache-control", NO_STORE["cache-control"]);
  return response;
}

export { handle as GET, handle as POST };

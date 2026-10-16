// Dev-only console trace of AI traffic. The browser console is local to the user, so response
// bodies (which contain cell values) may appear here, unlike server logs (spec §12.2).
export function debugLog(...args: unknown[]): void {
  if (process.env.NODE_ENV === "development") console.debug("[accord]", ...args);
}

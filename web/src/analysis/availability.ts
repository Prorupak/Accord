// The static Cloudflare build (next.config.ts) has no inference API, so AI actions are not offered.
// A function, not a constant, so tests can stub the inlined env value.
export const aiAvailable = () => process.env.ACCORD_DEPLOY_TARGET !== "cloudflare-static";

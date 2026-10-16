import type { Env as GatewayEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends GatewayEnv {}
  }
}

// Schema-generation input for the Better Auth CLI only; never imported by the app, mounts no routes.
// Regenerate (pinned CLI, not a dependency): pnpm dlx auth@1.7.10 generate --config prisma/better-auth.schema.ts --adapter prisma --dialect postgresql --output prisma/schema.prisma --yes
import { betterAuth } from "better-auth";

export const auth = betterAuth({ emailAndPassword: { enabled: true } });

"""Cloudflare Python Worker entry (private; reached only through the gateway's service binding).

Local and Docker keep using uvicorn (`python -m app`); this file is only the Workers adapter.
"""

import os

from _cloudflare.allow_entropy import allow_bad_entropy_calls
from workers import WorkerEntrypoint, asgi

# openai.lib.bedrock draws os.urandom(32) at import for a Bedrock signing key Accord never uses;
# Workers refuses entropy while snapshotting startup. Allow exactly that one call.
# shortcut: private runtime API; drop it once workers-runtime-sdk patches openai itself.
with allow_bad_entropy_calls(1):
    import openai  # noqa: F401

from app.main import app  # noqa: E402

# Worker vars/secrets arrive on `self.env`, not os.environ, which pydantic-settings reads.
_SETTINGS = ("OPENROUTER_API_KEY", "OPENROUTER_MODEL", "API_PORT", "API_INTERNAL_HOST")


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        for name in _SETTINGS:
            value = getattr(self.env, name, None)
            if isinstance(value, str) and name not in os.environ:
                os.environ[name] = value
        return await asgi.fetch(app, request, self.env, self.ctx)

import uvicorn

from .config import get_settings

settings = get_settings()
uvicorn.run(
    "app.main:app",
    host=settings.api_host,
    port=settings.api_port,
    reload=True,
    proxy_headers=False,
)

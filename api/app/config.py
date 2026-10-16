from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

API_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=API_DIR / ".env", extra="ignore")

    openrouter_api_key: SecretStr | None = None
    openrouter_model: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    frontend_origin: str = "http://localhost:3000"
    # One extra trusted Host name for a container network (Compose sets "api"). A bare label only.
    api_internal_host: str | None = Field(default=None, pattern=r"^[a-z0-9-]+$")
    # Dev only: logs raw model output, which contains cell values. Off by default (spec §12.2).
    log_model_output: bool = False

    @property
    def is_configured(self) -> bool:
        key = self.openrouter_api_key.get_secret_value() if self.openrouter_api_key else ""
        return bool(key.strip() and (self.openrouter_model or "").strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()

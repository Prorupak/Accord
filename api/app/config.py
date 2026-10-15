from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
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

    @property
    def is_configured(self) -> bool:
        key = self.openrouter_api_key.get_secret_value() if self.openrouter_api_key else ""
        return bool(key.strip() and (self.openrouter_model or "").strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()

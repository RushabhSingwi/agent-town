"""Settings, read from the environment (or backend/.env). Every knob the app has lives here."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-only-secret-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="AGENTTOWN_", extra="ignore")

    # sqlite for local dev; point at Postgres in production:
    #   AGENTTOWN_DATABASE_URL=postgresql+psycopg://user:pass@host/agenttown
    database_url: str = "sqlite:///./agenttown.db"

    # Encrypts MCP credentials at rest. Changing it makes stored credentials unreadable.
    secret_key: str = DEV_SECRET

    session_days: int = 30
    # True behind HTTPS so the session cookie is never sent in clear text.
    cookie_secure: bool = False

    # Checking an MCP server means this server makes an HTTP request to a URL a user typed.
    # Off by default so nobody can point it at 127.0.0.1 / 10.x / cloud metadata (SSRF).
    # Turn on for local development against a server on your machine.
    allow_private_mcp_hosts: bool = False


@lru_cache
def settings() -> Settings:
    return Settings()

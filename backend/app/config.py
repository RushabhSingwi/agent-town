"""Settings, read from the environment (or backend/.env). Every knob the app has lives here."""

import os
from functools import lru_cache

from pydantic import field_validator
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

    # Let users store a *subscription* token (Claude `setup-token`, Codex auth.json) as well as an
    # API key. Each run uses only its owner's token, in that owner's own sandbox. The provider's
    # terms are between the user and the provider; the UI says so when they add one.
    allow_subscription_tokens: bool = True

    # Where agents run: "local" (a subprocess on this machine: development only, NOT isolated)
    # or "modal" (a Modal Sandbox per run; needs `uv sync --group modal` and MODAL_TOKEN_ID/SECRET).
    sandbox_provider: str = "local"
    # How a sandbox reaches this API. Must be reachable from inside the sandbox (public in production).
    # On Render it defaults to the service's own https URL, which Render sets as RENDER_EXTERNAL_URL.
    public_url: str = os.environ.get("RENDER_EXTERNAL_URL") or "http://127.0.0.1:8000"
    # A run with nobody talking to it stops after this; a run never lives longer than run_max_hours.
    run_idle_minutes: int = 15
    run_max_hours: int = 4

    @field_validator("database_url")
    @classmethod
    def _psycopg(cls, v: str) -> str:
        """Hosts (Render, Heroku…) hand out postgres:// URLs; SQLAlchemy needs the driver named."""
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg://" + v[len(prefix):]
        return v


@lru_cache
def settings() -> Settings:
    return Settings()

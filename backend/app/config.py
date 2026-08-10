from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_JWT_SECRET = "dev-only-change-me-presence-v0-secret-key"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # "dev" (default, local) or "prod". Prod refuses to boot on the default JWT
    # secret and disables the OpenAPI docs endpoints.
    app_env: str = "dev"
    jwt_secret: str = _DEV_JWT_SECRET
    jwt_expire_minutes: int = 60 * 24 * 7
    # Comma-separated. Use * for same-origin + local preview, or list explicit origins.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:4173,http://localhost:4173"
    users_file: str = "users.json"
    invites_file: str = "invites.json"
    # Metered TURN (dashboard.metered.ca): app subdomain + credential-scoped API key
    # from TURN Server → Add Credential. Both empty = STUN-only fallback.
    turn_app_name: str = ""
    turn_api_key: str = ""
    # Optional raw JSON array of users (Fly secret). Seeds users_file only when
    # that file is missing — never overwrites invite signups on disk/volume.
    users_json: str = ""
    # Empty = auto-detect ../frontend/dist relative to backend/
    static_dir: str = ""

    @property
    def is_dev(self) -> bool:
        return self.app_env.strip().lower() != "prod"

    def validate_prod_secrets(self) -> None:
        """Refuse to run in prod with a missing/known JWT secret (forgeable tokens)."""
        if self.is_dev:
            return
        if not self.jwt_secret.strip() or self.jwt_secret == _DEV_JWT_SECRET:
            raise RuntimeError(
                "APP_ENV=prod requires an explicit JWT_SECRET "
                "(e.g. fly secrets set JWT_SECRET=\"$(openssl rand -hex 32)\")"
            )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def users_path(self) -> Path:
        path = Path(self.users_file)
        if not path.is_absolute():
            path = Path(__file__).resolve().parent.parent / path
        return path

    def invites_path(self) -> Path:
        path = Path(self.invites_file)
        if not path.is_absolute():
            path = Path(__file__).resolve().parent.parent / path
        return path

    def resolved_static_dir(self) -> Path | None:
        if self.static_dir:
            path = Path(self.static_dir)
        else:
            # backend/app/config.py → backend/ → repo/frontend/dist
            path = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
        if not path.is_absolute():
            path = Path(__file__).resolve().parent.parent / path
        return path if path.is_dir() else None


settings = Settings()

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    jwt_secret: str = "dev-only-change-me-presence-v0-secret-key"
    jwt_expire_minutes: int = 60 * 24 * 7
    # Comma-separated. Use * for same-origin + local preview, or list explicit origins.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:4173,http://localhost:4173"
    users_file: str = "users.json"
    # Optional raw JSON array of users (Fly secret). Wins over users_file when set.
    users_json: str = ""
    # Empty = auto-detect ../frontend/dist relative to backend/
    static_dir: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def users_path(self) -> Path:
        path = Path(self.users_file)
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

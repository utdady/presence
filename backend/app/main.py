from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import invites as invite_store
from app import users as user_store
from app.config import settings
from app.routes import router

# Fail fast: never boot prod with the known dev JWT secret (tokens would be forgeable).
settings.validate_prod_secrets()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    user_store.load_users()
    invite_store.load_invites()
    yield


app = FastAPI(
    title="Presence",
    version="0.1.0",
    lifespan=lifespan,
    # Don't expose the API schema/explorer in prod.
    docs_url="/docs" if settings.is_dev else None,
    redoc_url="/redoc" if settings.is_dev else None,
    openapi_url="/openapi.json" if settings.is_dev else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list if "*" not in settings.cors_origin_list else ["*"],
    allow_credentials="*" not in settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)

# 'unsafe-inline' script-src: theme-bootstrap inline script in index.html.
# 'wasm-unsafe-eval': libsodium-wrappers compiles its WASM module at runtime
# (Chrome/Safari); full 'unsafe-eval' is intentionally NOT allowed.
_CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self' wss: https:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ]
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", _CSP)
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(self), microphone=(self), geolocation=(), payment=()",
    )
    if not settings.is_dev:
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
        )
    return response


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _html_response(path: Path) -> FileResponse:
    # Never let browsers/SW keep a stale shell (and its CSP) across deploys.
    return FileResponse(
        path,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


def _mount_spa(static_dir: Path) -> None:
    assets = static_dir / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        candidate = (static_dir / full_path).resolve()
        try:
            candidate.relative_to(static_dir.resolve())
        except ValueError:
            return _html_response(static_dir / "index.html")
        if full_path and candidate.is_file():
            if candidate.suffix.lower() in {".html", ".htm"}:
                return _html_response(candidate)
            return FileResponse(candidate)
        return _html_response(static_dir / "index.html")


_static = settings.resolved_static_dir()
if _static is not None:
    _mount_spa(_static)

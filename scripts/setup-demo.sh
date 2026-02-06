#!/usr/bin/env bash
# Grove Demo Project Setup Script
# Creates a realistic demo project for screenshots and demos
set -euo pipefail

# ============================================================================
# Config
# ============================================================================
DEMO_DIR="$HOME/grove-demo"
GROVE_DIR="$HOME/.grove"

echo "🌳 Grove Demo Setup"
echo "===================="
echo "Project: $DEMO_DIR"
echo ""

# Clean up existing demo
if [ -d "$DEMO_DIR" ]; then
    echo "⚠️  Removing existing demo project..."
    # Kill any tmux sessions for this project
    tmux list-sessions 2>/dev/null | grep "grove-" | cut -d: -f1 | while read -r s; do
        tmux kill-session -t "$s" 2>/dev/null || true
    done
    rm -rf "$DEMO_DIR"
fi

# ============================================================================
# Step 1: Calculate project hash (FNV-1a)
# ============================================================================
PROJECT_HASH=$(python3 -c "
path = '$DEMO_DIR'
h = 0xcbf29ce484222325
for b in path.encode():
    h ^= b
    h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
print(f'{h:016x}')
")
echo "📦 Project hash: $PROJECT_HASH"

PROJ_DATA_DIR="$GROVE_DIR/projects/$PROJECT_HASH"
WORKTREE_DIR="$GROVE_DIR/worktrees/$PROJECT_HASH"

# Clean up old grove data for this hash
rm -rf "$PROJ_DATA_DIR" "$WORKTREE_DIR"

# ============================================================================
# Step 2: Create the demo Git repo with realistic code
# ============================================================================
echo ""
echo "📁 Creating demo project: Pulse - Real-time Analytics Engine..."

mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"
git init -b main --quiet

# Set git config for demo commits
git config user.name "Alex Chen"
git config user.email "alex@pulse-analytics.dev"

# --- Initial commit: project scaffolding ---
mkdir -p src/{routes,models,middleware,services} tests docs
cat > README.md << 'DOCEOF'
# Pulse

Real-time analytics engine for modern applications. Track events, build dashboards, query metrics — all with sub-second latency.

## Quick Start

```bash
pip install pulse-analytics
pulse serve --port 8080
```

## Architecture

- **Ingest API**: High-throughput event ingestion via HTTP/WebSocket
- **Query Engine**: ClickHouse-backed OLAP queries
- **Dashboard**: Real-time streaming dashboards
- **Webhooks**: Event-driven notifications
DOCEOF

cat > pyproject.toml << 'DOCEOF'
[project]
name = "pulse-analytics"
version = "0.8.2"
description = "Real-time analytics engine"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.109.0",
    "uvicorn[standard]>=0.27.0",
    "clickhouse-connect>=0.7.0",
    "redis>=5.0.0",
    "pydantic>=2.5.0",
    "structlog>=24.1.0",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "httpx>=0.26", "ruff>=0.2.0"]
DOCEOF

cat > src/__init__.py << 'DOCEOF'
"""Pulse Analytics Engine"""
__version__ = "0.8.2"
DOCEOF

cat > src/main.py << 'DOCEOF'
"""Pulse - Real-time Analytics Engine"""
import structlog
from fastapi import FastAPI
from contextlib import asynccontextmanager

from .routes import auth, events, dashboards, health
from .middleware.rate_limit import RateLimitMiddleware
from .middleware.auth import AuthMiddleware
from .services.clickhouse import ClickHousePool

logger = structlog.get_logger()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("pulse.starting", version="0.8.2")
    app.state.ch_pool = await ClickHousePool.create()
    yield
    await app.state.ch_pool.close()
    logger.info("pulse.shutdown")

app = FastAPI(title="Pulse", version="0.8.2", lifespan=lifespan)

app.add_middleware(RateLimitMiddleware, requests_per_minute=600)
app.add_middleware(AuthMiddleware)

app.include_router(health.router, prefix="/health", tags=["health"])
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(events.router, prefix="/api/v1/events", tags=["events"])
app.include_router(dashboards.router, prefix="/api/v1/dashboards", tags=["dashboards"])
DOCEOF

cat > src/config.py << 'DOCEOF'
"""Application configuration."""
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str = "clickhouse://localhost:9000/pulse"
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str = "change-me-in-production"
    jwt_expiry_hours: int = 24
    cors_origins: list[str] = ["http://localhost:3000"]
    rate_limit_rpm: int = 600
    webhook_timeout: int = 30

    class Config:
        env_prefix = "PULSE_"

settings = Settings()
DOCEOF

cat > src/routes/__init__.py << 'DOCEOF'
DOCEOF

cat > src/routes/health.py << 'DOCEOF'
"""Health check endpoints."""
from fastapi import APIRouter, Response

router = APIRouter()

@router.get("/")
async def health_check():
    return {"status": "healthy", "version": "0.8.2"}

@router.get("/ready")
async def readiness_check():
    return {"status": "ready"}
DOCEOF

cat > src/routes/auth.py << 'DOCEOF'
"""Authentication endpoints."""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, EmailStr
from ..services.auth import AuthService, get_auth_service

router = APIRouter()

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int

@router.post("/login", response_model=TokenResponse)
async def login(req: LoginRequest, auth: AuthService = Depends(get_auth_service)):
    user = await auth.authenticate(req.email, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = auth.create_token(user)
    return TokenResponse(access_token=token, expires_in=86400)

@router.post("/logout")
async def logout(auth: AuthService = Depends(get_auth_service)):
    await auth.revoke_current_token()
    return {"status": "logged_out"}
DOCEOF

cat > src/routes/events.py << 'DOCEOF'
"""Event ingestion endpoints."""
from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from datetime import datetime
from ..services.ingest import IngestService

router = APIRouter()

class Event(BaseModel):
    name: str
    properties: dict = {}
    timestamp: datetime | None = None
    user_id: str | None = None

class BatchEvents(BaseModel):
    events: list[Event]

@router.post("/track")
async def track_event(event: Event, bg: BackgroundTasks):
    bg.add_task(IngestService.process_event, event)
    return {"status": "accepted"}

@router.post("/batch")
async def track_batch(batch: BatchEvents, bg: BackgroundTasks):
    bg.add_task(IngestService.process_batch, batch.events)
    return {"status": "accepted", "count": len(batch.events)}
DOCEOF

cat > src/routes/dashboards.py << 'DOCEOF'
"""Dashboard query endpoints."""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from datetime import datetime, timedelta

router = APIRouter()

class TimeRange(BaseModel):
    start: datetime
    end: datetime = datetime.utcnow()
    granularity: str = "hour"

class MetricResult(BaseModel):
    timestamps: list[datetime]
    values: list[float]
    total: float

@router.get("/metrics/{metric_name}")
async def query_metric(
    metric_name: str,
    start: datetime = Query(...),
    end: datetime = Query(default=None),
    granularity: str = Query(default="hour"),
):
    """Query a metric over time."""
    pass  # TODO: implement

@router.get("/funnel")
async def funnel_analysis(steps: list[str] = Query(...)):
    """Multi-step funnel analysis."""
    pass  # TODO: implement
DOCEOF

cat > src/models/__init__.py << 'DOCEOF'
DOCEOF

cat > src/models/user.py << 'DOCEOF'
"""User model."""
from pydantic import BaseModel, EmailStr
from datetime import datetime

class User(BaseModel):
    id: str
    email: EmailStr
    name: str
    org_id: str
    role: str = "member"
    created_at: datetime
    last_login: datetime | None = None
DOCEOF

cat > src/models/deployment.py << 'DOCEOF'
"""Event and dashboard models."""
from pydantic import BaseModel
from datetime import datetime

class StoredEvent(BaseModel):
    id: str
    name: str
    properties: dict
    user_id: str | None
    timestamp: datetime
    ingested_at: datetime

class Dashboard(BaseModel):
    id: str
    name: str
    org_id: str
    widgets: list[dict]
    created_by: str
    created_at: datetime
    updated_at: datetime
DOCEOF

cat > src/middleware/__init__.py << 'DOCEOF'
DOCEOF

cat > src/middleware/auth.py << 'DOCEOF'
"""Authentication middleware."""
import jwt
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from ..config import settings

PUBLIC_PATHS = {"/health", "/health/ready", "/docs", "/openapi.json"}

class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        auth_header = request.headers.get("authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            return JSONResponse(status_code=401, content={"detail": "Missing token"})

        token = auth_header.split(" ", 1)[1]
        try:
            payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
            request.state.user_id = payload["sub"]
            request.state.org_id = payload["org"]
        except jwt.InvalidTokenError:
            return JSONResponse(status_code=401, content={"detail": "Invalid token"})

        return await call_next(request)
DOCEOF

cat > src/middleware/rate_limit.py << 'DOCEOF'
"""Rate limiting middleware using sliding window."""
import time
from collections import defaultdict
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, requests_per_minute: int = 600):
        super().__init__(app)
        self.rpm = requests_per_minute
        self.window = 60
        self._requests: dict[str, list[float]] = defaultdict(list)

    def _get_client_id(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _is_rate_limited(self, client_id: str) -> bool:
        now = time.monotonic()
        window_start = now - self.window
        # Clean old entries
        self._requests[client_id] = [
            t for t in self._requests[client_id] if t > window_start
        ]
        if len(self._requests[client_id]) >= self.rpm:
            return True
        self._requests[client_id].append(now)
        return False

    async def dispatch(self, request: Request, call_next):
        client_id = self._get_client_id(request)
        if self._is_rate_limited(client_id):
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded"},
                headers={"Retry-After": "60"},
            )
        return await call_next(request)
DOCEOF

cat > src/services/__init__.py << 'DOCEOF'
DOCEOF

cat > src/services/auth.py << 'DOCEOF'
"""Authentication service."""
import jwt
import bcrypt
from datetime import datetime, timedelta
from ..config import settings
from ..models.user import User

class AuthService:
    async def authenticate(self, email: str, password: str) -> User | None:
        """Verify credentials and return user."""
        # TODO: query database
        pass

    def create_token(self, user: User) -> str:
        payload = {
            "sub": user.id,
            "org": user.org_id,
            "email": user.email,
            "exp": datetime.utcnow() + timedelta(hours=settings.jwt_expiry_hours),
        }
        return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")

    async def revoke_current_token(self):
        """Add token to blacklist in Redis."""
        pass

async def get_auth_service() -> AuthService:
    return AuthService()
DOCEOF

cat > src/services/ingest.py << 'DOCEOF'
"""Event ingestion service."""
import structlog
from datetime import datetime, timezone

logger = structlog.get_logger()

class IngestService:
    @staticmethod
    async def process_event(event) -> None:
        logger.info("event.ingested", name=event.name, user=event.user_id)
        # TODO: write to ClickHouse

    @staticmethod
    async def process_batch(events: list) -> None:
        logger.info("batch.ingested", count=len(events))
        # TODO: batch insert to ClickHouse
DOCEOF

cat > src/services/clickhouse.py << 'DOCEOF'
"""ClickHouse connection pool."""
from ..config import settings

class ClickHousePool:
    @classmethod
    async def create(cls):
        pool = cls()
        # TODO: initialize connection pool
        return pool

    async def close(self):
        pass

    async def execute(self, query: str, params: dict = None):
        pass
DOCEOF

cat > tests/__init__.py << 'DOCEOF'
DOCEOF

cat > tests/test_auth.py << 'DOCEOF'
"""Auth endpoint tests."""
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_login_success(client: AsyncClient):
    resp = await client.post("/api/v1/auth/login", json={
        "email": "test@example.com",
        "password": "secret123",
    })
    assert resp.status_code == 200
    assert "access_token" in resp.json()

@pytest.mark.asyncio
async def test_login_invalid_password(client: AsyncClient):
    resp = await client.post("/api/v1/auth/login", json={
        "email": "test@example.com",
        "password": "wrong",
    })
    assert resp.status_code == 401
DOCEOF

cat > tests/test_events.py << 'DOCEOF'
"""Event ingestion tests."""
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_track_single_event(client: AsyncClient):
    resp = await client.post("/api/v1/events/track", json={
        "name": "page_view",
        "properties": {"path": "/home"},
        "user_id": "user-123",
    })
    assert resp.status_code == 200

@pytest.mark.asyncio
async def test_track_batch_events(client: AsyncClient):
    resp = await client.post("/api/v1/events/batch", json={
        "events": [
            {"name": "click", "properties": {"button": "signup"}},
            {"name": "page_view", "properties": {"path": "/pricing"}},
        ]
    })
    assert resp.status_code == 200
    assert resp.json()["count"] == 2
DOCEOF

cat > docker-compose.yml << 'DOCEOF'
version: "3.9"
services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.1
    ports: ["9000:9000", "8123:8123"]
    volumes: ["ch_data:/var/lib/clickhouse"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  pulse:
    build: .
    ports: ["8080:8080"]
    depends_on: [clickhouse, redis]
    environment:
      PULSE_DATABASE_URL: clickhouse://clickhouse:9000/pulse
      PULSE_REDIS_URL: redis://redis:6379/0

volumes:
  ch_data:
DOCEOF

cat > .gitignore << 'DOCEOF'
__pycache__/
*.pyc
.env
.venv/
dist/
*.egg-info/
.pytest_cache/
.ruff_cache/
DOCEOF

git add -A && git commit -m "Initial project setup: FastAPI + ClickHouse analytics engine" --quiet --date="2026-01-20T10:00:00+08:00"

# --- Commit 2: Add event ingestion pipeline ---
cat > src/services/ingest.py << 'DOCEOF'
"""Event ingestion service with batching and validation."""
import structlog
from datetime import datetime, timezone
from uuid import uuid4

logger = structlog.get_logger()

MAX_BATCH_SIZE = 10_000
MAX_PROPERTY_SIZE = 50

class IngestError(Exception):
    pass

class IngestService:
    @staticmethod
    def _validate_event(event) -> None:
        if not event.name or len(event.name) > 256:
            raise IngestError("Event name must be 1-256 characters")
        if len(event.properties) > MAX_PROPERTY_SIZE:
            raise IngestError(f"Too many properties (max {MAX_PROPERTY_SIZE})")

    @staticmethod
    async def process_event(event) -> str:
        IngestService._validate_event(event)
        event_id = str(uuid4())
        ts = event.timestamp or datetime.now(timezone.utc)
        logger.info("event.ingested", id=event_id, name=event.name, user=event.user_id)
        return event_id

    @staticmethod
    async def process_batch(events: list) -> int:
        if len(events) > MAX_BATCH_SIZE:
            raise IngestError(f"Batch too large (max {MAX_BATCH_SIZE})")
        for e in events:
            IngestService._validate_event(e)
        logger.info("batch.ingested", count=len(events))
        return len(events)
DOCEOF

git add -A && git commit -m "feat: add event validation and batch processing pipeline" --quiet --date="2026-01-22T14:30:00+08:00"

# --- Commit 3: Add monitoring and observability ---
cat > src/routes/health.py << 'DOCEOF'
"""Health check and monitoring endpoints."""
import time
from fastapi import APIRouter, Response

router = APIRouter()

_start_time = time.time()

@router.get("/")
async def health_check():
    return {"status": "healthy", "version": "0.8.2"}

@router.get("/ready")
async def readiness_check():
    return {"status": "ready"}

@router.get("/metrics")
async def prometheus_metrics():
    uptime = time.time() - _start_time
    metrics = [
        f"pulse_uptime_seconds {uptime:.2f}",
        "pulse_events_total 0",
        "pulse_query_latency_p99 0",
    ]
    return Response(content="\n".join(metrics), media_type="text/plain")
DOCEOF

git add -A && git commit -m "feat: add Prometheus metrics endpoint" --quiet --date="2026-01-24T09:15:00+08:00"

# --- Commit 4: Add error handling and logging ---
cat > src/middleware/error_handler.py << 'DOCEOF'
"""Global error handling middleware."""
import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = structlog.get_logger()

class ErrorHandlerMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            response = await call_next(request)
            return response
        except Exception as exc:
            logger.error("unhandled_error", error=str(exc), path=request.url.path)
            return JSONResponse(
                status_code=500,
                content={"detail": "Internal server error", "request_id": request.state.request_id},
            )
DOCEOF

git add -A && git commit -m "feat: add global error handler with structured logging" --quiet --date="2026-01-26T16:45:00+08:00"

# --- Commit 5: Update dependencies ---
cat > requirements.txt << 'DOCEOF'
fastapi==0.109.2
uvicorn[standard]==0.27.1
clickhouse-connect==0.7.5
redis==5.0.1
pydantic==2.6.0
pydantic-settings==2.1.0
structlog==24.1.0
PyJWT==2.8.0
bcrypt==4.1.2
httpx==0.26.0
DOCEOF

git add -A && git commit -m "chore: pin dependency versions in requirements.txt" --quiet --date="2026-01-28T11:20:00+08:00"

# --- Commit 6: CI config ---
mkdir -p .github/workflows
cat > .github/workflows/ci.yml << 'DOCEOF'
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e ".[dev]"
      - run: ruff check src/
      - run: pytest tests/ -v
DOCEOF

git add -A && git commit -m "ci: add GitHub Actions workflow for linting and tests" --quiet --date="2026-01-29T08:00:00+08:00"

# --- Commit 7: Add rate limiter with Redis backend ---
cat > src/services/redis_pool.py << 'DOCEOF'
"""Redis connection management."""
import redis.asyncio as redis
from ..config import settings

_pool: redis.Redis | None = None

async def get_redis() -> redis.Redis:
    global _pool
    if _pool is None:
        _pool = redis.from_url(settings.redis_url, decode_responses=True)
    return _pool

async def close_redis():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
DOCEOF

git add -A && git commit -m "feat: add Redis connection pool for rate limiting and caching" --quiet --date="2026-01-30T13:00:00+08:00"

# --- Commit 8: Refactor config to use env profiles ---
cat >> src/config.py << 'DOCEOF'

class DevSettings(Settings):
    class Config:
        env_prefix = "PULSE_"
        env_file = ".env"

class ProdSettings(Settings):
    jwt_expiry_hours: int = 4
    rate_limit_rpm: int = 300
DOCEOF

git add -A && git commit -m "refactor: split config into dev/prod profiles" --quiet --date="2026-02-01T10:30:00+08:00"

echo "✅ Main branch: $(git log --oneline | wc -l | tr -d ' ') commits"

# ============================================================================
# Step 3: Create branches with their own commits
# ============================================================================
echo ""
echo "🌿 Creating task branches..."

# --- Branch 1: add-oauth (targeting main) ---
git checkout -b grove/add-oauth-a1b2c3 --quiet

cat > src/routes/oauth.py << 'DOCEOF'
"""OAuth provider integration."""
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from enum import Enum

router = APIRouter()

class OAuthProvider(str, Enum):
    GOOGLE = "google"
    GITHUB = "github"
    MICROSOFT = "microsoft"

class OAuthCallbackResponse(BaseModel):
    access_token: str
    provider: str
    email: str

@router.get("/authorize/{provider}")
async def oauth_authorize(provider: OAuthProvider, redirect_uri: str = Query(...)):
    """Generate OAuth authorization URL."""
    auth_urls = {
        OAuthProvider.GOOGLE: "https://accounts.google.com/o/oauth2/v2/auth",
        OAuthProvider.GITHUB: "https://github.com/login/oauth/authorize",
        OAuthProvider.MICROSOFT: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    }
    return {"url": auth_urls[provider], "state": "generated-csrf-token"}

@router.post("/callback/{provider}", response_model=OAuthCallbackResponse)
async def oauth_callback(provider: OAuthProvider, code: str = Query(...)):
    """Handle OAuth callback and exchange code for token."""
    # TODO: exchange code with provider
    raise HTTPException(501, "OAuth callback not yet implemented")
DOCEOF

cat > src/services/oauth_providers.py << 'DOCEOF'
"""OAuth provider implementations."""
import httpx
from dataclasses import dataclass

@dataclass
class OAuthUserInfo:
    email: str
    name: str
    avatar_url: str | None
    provider_id: str

class GoogleOAuth:
    TOKEN_URL = "https://oauth2.googleapis.com/token"
    USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"

    async def exchange_code(self, code: str, redirect_uri: str) -> str:
        async with httpx.AsyncClient() as client:
            resp = await client.post(self.TOKEN_URL, data={
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            })
            return resp.json()["access_token"]

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        async with httpx.AsyncClient() as client:
            resp = await client.get(self.USERINFO_URL, headers={
                "Authorization": f"Bearer {access_token}"
            })
            data = resp.json()
            return OAuthUserInfo(
                email=data["email"],
                name=data["name"],
                avatar_url=data.get("picture"),
                provider_id=data["id"],
            )

class GitHubOAuth:
    TOKEN_URL = "https://github.com/login/oauth/access_token"
    USERINFO_URL = "https://api.github.com/user"

    async def exchange_code(self, code: str, redirect_uri: str) -> str:
        async with httpx.AsyncClient() as client:
            resp = await client.post(self.TOKEN_URL, data={
                "code": code,
                "redirect_uri": redirect_uri,
            }, headers={"Accept": "application/json"})
            return resp.json()["access_token"]

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        async with httpx.AsyncClient() as client:
            resp = await client.get(self.USERINFO_URL, headers={
                "Authorization": f"Bearer {access_token}"
            })
            data = resp.json()
            return OAuthUserInfo(
                email=data.get("email", ""),
                name=data["login"],
                avatar_url=data.get("avatar_url"),
                provider_id=str(data["id"]),
            )
DOCEOF

cat > tests/test_oauth.py << 'DOCEOF'
"""OAuth integration tests."""
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_oauth_authorize_google(client: AsyncClient):
    resp = await client.get("/api/v1/auth/oauth/authorize/google?redirect_uri=http://localhost:3000/callback")
    assert resp.status_code == 200
    assert "url" in resp.json()

@pytest.mark.asyncio
async def test_oauth_authorize_invalid_provider(client: AsyncClient):
    resp = await client.get("/api/v1/auth/oauth/authorize/invalid?redirect_uri=http://localhost:3000/callback")
    assert resp.status_code == 422
DOCEOF

git add -A && git commit -m "feat: add OAuth routes and provider implementations" --quiet --date="2026-02-03T09:00:00+08:00"

# Second commit on this branch
cat > src/services/oauth_session.py << 'DOCEOF'
"""OAuth session management."""
from datetime import datetime, timedelta
from ..services.redis_pool import get_redis

class OAuthSessionManager:
    """Manages OAuth CSRF state tokens in Redis."""
    STATE_TTL = timedelta(minutes=10)

    async def create_state(self, provider: str, redirect_uri: str) -> str:
        import secrets
        state = secrets.token_urlsafe(32)
        redis = await get_redis()
        await redis.setex(
            f"oauth:state:{state}",
            int(self.STATE_TTL.total_seconds()),
            f"{provider}:{redirect_uri}",
        )
        return state

    async def validate_state(self, state: str) -> tuple[str, str] | None:
        redis = await get_redis()
        data = await redis.getdel(f"oauth:state:{state}")
        if not data:
            return None
        provider, redirect_uri = data.split(":", 1)
        return provider, redirect_uri
DOCEOF

git add -A && git commit -m "feat: add Redis-backed CSRF state for OAuth flow" --quiet --date="2026-02-03T14:20:00+08:00"

# Third commit
cat >> src/routes/oauth.py << 'DOCEOF'

@router.get("/providers")
async def list_providers():
    """List available OAuth providers."""
    return {
        "providers": [
            {"id": "google", "name": "Google", "icon": "google"},
            {"id": "github", "name": "GitHub", "icon": "github"},
            {"id": "microsoft", "name": "Microsoft", "icon": "microsoft"},
        ]
    }
DOCEOF

git add -A && git commit -m "feat: add provider listing endpoint" --quiet --date="2026-02-04T10:00:00+08:00"

# Fourth commit
cat > tests/test_oauth_session.py << 'DOCEOF'
"""OAuth session tests."""
import pytest
from src.services.oauth_session import OAuthSessionManager

@pytest.mark.asyncio
async def test_create_and_validate_state():
    mgr = OAuthSessionManager()
    state = await mgr.create_state("google", "http://localhost:3000/cb")
    result = await mgr.validate_state(state)
    assert result == ("google", "http://localhost:3000/cb")

@pytest.mark.asyncio
async def test_state_single_use():
    mgr = OAuthSessionManager()
    state = await mgr.create_state("github", "http://localhost:3000/cb")
    await mgr.validate_state(state)
    assert await mgr.validate_state(state) is None
DOCEOF

git add -A && git commit -m "test: add OAuth session CSRF token tests" --quiet --date="2026-02-04T16:30:00+08:00"

git checkout main --quiet

# --- Branch 2: fix-ws-leak (targeting main) ---
git checkout -b fix/ws-memory-leak-c3d4e5 --quiet

cat > src/services/websocket.py << 'DOCEOF'
"""WebSocket connection manager with proper cleanup."""
import asyncio
import weakref
import structlog
from fastapi import WebSocket

logger = structlog.get_logger()

class ConnectionManager:
    """Manages WebSocket connections with automatic cleanup."""

    def __init__(self):
        self._connections: dict[str, set[WebSocket]] = {}
        self._cleanup_task: asyncio.Task | None = None

    async def connect(self, channel: str, ws: WebSocket):
        await ws.accept()
        if channel not in self._connections:
            self._connections[channel] = set()
        self._connections[channel].add(ws)
        logger.info("ws.connected", channel=channel, total=len(self._connections[channel]))

    async def disconnect(self, channel: str, ws: WebSocket):
        if channel in self._connections:
            self._connections[channel].discard(ws)
            if not self._connections[channel]:
                del self._connections[channel]
        logger.info("ws.disconnected", channel=channel)

    async def broadcast(self, channel: str, message: dict):
        if channel not in self._connections:
            return
        dead = []
        for ws in self._connections[channel]:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections[channel].discard(ws)

    async def start_cleanup(self):
        """Periodic cleanup of stale connections."""
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self):
        while True:
            await asyncio.sleep(30)
            for channel in list(self._connections.keys()):
                stale = [ws for ws in self._connections[channel]
                         if ws.client_state.name == "DISCONNECTED"]
                for ws in stale:
                    self._connections[channel].discard(ws)
                if not self._connections[channel]:
                    del self._connections[channel]
            logger.debug("ws.cleanup", channels=len(self._connections))
DOCEOF

# Fix the rate limiter too
cat > src/middleware/rate_limit.py << 'DOCEOF'
"""Rate limiting middleware using Redis sliding window."""
import time
import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = structlog.get_logger()

class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, requests_per_minute: int = 600):
        super().__init__(app)
        self.rpm = requests_per_minute
        self.window = 60

    def _get_client_id(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    async def dispatch(self, request: Request, call_next):
        # Use Redis for distributed rate limiting instead of in-memory dict
        # This fixes the memory leak in multi-worker deployments
        client_id = self._get_client_id(request)
        try:
            from ..services.redis_pool import get_redis
            redis = await get_redis()
            key = f"ratelimit:{client_id}"
            current = await redis.incr(key)
            if current == 1:
                await redis.expire(key, self.window)
            if current > self.rpm:
                return JSONResponse(
                    status_code=429,
                    content={"detail": "Rate limit exceeded"},
                    headers={"Retry-After": "60"},
                )
        except Exception:
            logger.warning("rate_limit.redis_unavailable", client=client_id)
        return await call_next(request)
DOCEOF

git add -A && git commit -m "fix: replace in-memory rate limiter with Redis sliding window" --quiet --date="2026-02-04T11:00:00+08:00"

cat > tests/test_websocket.py << 'DOCEOF'
"""WebSocket tests."""
import pytest
from src.services.websocket import ConnectionManager

@pytest.mark.asyncio
async def test_connection_cleanup():
    mgr = ConnectionManager()
    assert len(mgr._connections) == 0
DOCEOF

git add -A && git commit -m "fix: add WebSocket connection cleanup to prevent memory leak" --quiet --date="2026-02-04T15:00:00+08:00"

git add -A && git commit --allow-empty -m "test: add WebSocket and rate limiter tests" --quiet --date="2026-02-05T09:30:00+08:00"

git checkout main --quiet

# --- Branch 3: dashboard-v2 (targeting main) ---
git checkout -b feature/dashboard-v2-e5f6a7 --quiet

cat > src/routes/dashboards.py << 'DOCEOF'
"""Dashboard v2 API - real-time streaming dashboards."""
from fastapi import APIRouter, Depends, Query, WebSocket
from pydantic import BaseModel
from datetime import datetime
from enum import Enum

router = APIRouter()

class WidgetType(str, Enum):
    LINE_CHART = "line_chart"
    BAR_CHART = "bar_chart"
    FUNNEL = "funnel"
    TABLE = "table"
    NUMBER = "number"
    MAP = "map"

class Widget(BaseModel):
    id: str
    type: WidgetType
    title: str
    query: str
    position: dict  # {x, y, w, h}
    config: dict = {}

class DashboardCreate(BaseModel):
    name: str
    description: str = ""
    widgets: list[Widget] = []
    is_public: bool = False

class DashboardResponse(BaseModel):
    id: str
    name: str
    description: str
    widgets: list[Widget]
    created_by: str
    created_at: datetime
    updated_at: datetime
    is_public: bool

@router.post("/", response_model=DashboardResponse)
async def create_dashboard(data: DashboardCreate):
    """Create a new dashboard."""
    pass

@router.get("/{dashboard_id}", response_model=DashboardResponse)
async def get_dashboard(dashboard_id: str):
    """Get dashboard by ID."""
    pass

@router.put("/{dashboard_id}")
async def update_dashboard(dashboard_id: str, data: DashboardCreate):
    """Update dashboard layout and widgets."""
    pass

@router.delete("/{dashboard_id}")
async def delete_dashboard(dashboard_id: str):
    """Delete a dashboard."""
    pass

@router.post("/{dashboard_id}/duplicate", response_model=DashboardResponse)
async def duplicate_dashboard(dashboard_id: str):
    """Duplicate an existing dashboard."""
    pass

@router.websocket("/{dashboard_id}/stream")
async def stream_dashboard(ws: WebSocket, dashboard_id: str):
    """Stream real-time updates for dashboard widgets."""
    await ws.accept()
    # TODO: stream query results
DOCEOF

cat > src/services/query_engine.py << 'DOCEOF'
"""Dashboard query engine with caching."""
import hashlib
import json
import structlog
from datetime import datetime, timedelta

logger = structlog.get_logger()

class QueryEngine:
    def __init__(self, ch_pool, redis):
        self.ch = ch_pool
        self.redis = redis
        self.cache_ttl = timedelta(seconds=30)

    def _cache_key(self, query: str, params: dict) -> str:
        raw = json.dumps({"q": query, "p": params}, sort_keys=True)
        return f"query_cache:{hashlib.sha256(raw.encode()).hexdigest()[:16]}"

    async def execute(self, query: str, params: dict = None) -> list[dict]:
        cache_key = self._cache_key(query, params or {})
        cached = await self.redis.get(cache_key)
        if cached:
            logger.debug("query.cache_hit", key=cache_key)
            return json.loads(cached)

        result = await self.ch.execute(query, params)
        await self.redis.setex(cache_key, int(self.cache_ttl.total_seconds()), json.dumps(result))
        logger.info("query.executed", rows=len(result))
        return result

    async def execute_streaming(self, query: str, params: dict = None):
        """Execute query and yield results row by row."""
        async for row in self.ch.execute_streaming(query, params):
            yield row
DOCEOF

git add -A && git commit -m "feat: redesign dashboard API with widget system and streaming" --quiet --date="2026-02-03T10:00:00+08:00"

cat > src/routes/templates.py << 'DOCEOF'
"""Dashboard template library."""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

class Template(BaseModel):
    id: str
    name: str
    description: str
    preview_url: str | None
    widgets: list[dict]

TEMPLATES = [
    Template(
        id="web-analytics",
        name="Web Analytics",
        description="Page views, sessions, bounce rate, and top pages",
        preview_url=None,
        widgets=[],
    ),
    Template(
        id="product-metrics",
        name="Product Metrics",
        description="DAU/MAU, retention, feature usage, and funnels",
        preview_url=None,
        widgets=[],
    ),
    Template(
        id="error-monitoring",
        name="Error Monitoring",
        description="Error rates, stack traces, and affected users",
        preview_url=None,
        widgets=[],
    ),
]

@router.get("/")
async def list_templates():
    return {"templates": TEMPLATES}

@router.get("/{template_id}")
async def get_template(template_id: str):
    for t in TEMPLATES:
        if t.id == template_id:
            return t
    return {"error": "Template not found"}
DOCEOF

git add -A && git commit -m "feat: add dashboard template library" --quiet --date="2026-02-04T09:00:00+08:00"

cat > src/services/realtime.py << 'DOCEOF'
"""Real-time dashboard update engine."""
import asyncio
import structlog
from .websocket import ConnectionManager

logger = structlog.get_logger()

class RealtimeEngine:
    def __init__(self, query_engine, ws_manager: ConnectionManager):
        self.qe = query_engine
        self.ws = ws_manager
        self._tasks: dict[str, asyncio.Task] = {}

    async def subscribe(self, dashboard_id: str, interval: int = 5):
        if dashboard_id in self._tasks:
            return
        self._tasks[dashboard_id] = asyncio.create_task(
            self._poll_loop(dashboard_id, interval)
        )

    async def _poll_loop(self, dashboard_id: str, interval: int):
        while True:
            # TODO: fetch latest data and broadcast
            await asyncio.sleep(interval)
DOCEOF

git add -A && git commit -m "feat: add real-time polling engine for dashboard streaming" --quiet --date="2026-02-05T11:00:00+08:00"

cat > tests/test_dashboards.py << 'DOCEOF'
"""Dashboard API tests."""
import pytest
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_create_dashboard(client: AsyncClient):
    resp = await client.post("/api/v1/dashboards/", json={
        "name": "My Dashboard",
        "widgets": [],
    })
    assert resp.status_code == 200

@pytest.mark.asyncio
async def test_list_templates(client: AsyncClient):
    resp = await client.get("/api/v1/dashboards/templates/")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["templates"]) >= 3
DOCEOF

git add -A && git commit -m "test: add dashboard and template endpoint tests" --quiet --date="2026-02-05T16:00:00+08:00"

git checkout main --quiet

# --- Branch 4: clickhouse migration (targeting main) ---
git checkout -b feature/clickhouse-migration-b8c9d0 --quiet

mkdir -p migrations
cat > migrations/001_initial_schema.sql << 'DOCEOF'
-- Initial ClickHouse schema for Pulse analytics
CREATE TABLE IF NOT EXISTS events (
    id UUID DEFAULT generateUUIDv4(),
    org_id String,
    user_id Nullable(String),
    name String,
    properties String,  -- JSON string
    timestamp DateTime64(3),
    ingested_at DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (org_id, name, timestamp)
TTL timestamp + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS users (
    id String,
    email String,
    name String,
    org_id String,
    role String DEFAULT 'member',
    password_hash String,
    created_at DateTime64(3),
    last_login Nullable(DateTime64(3))
) ENGINE = ReplacingMergeTree(created_at)
ORDER BY (org_id, id);
DOCEOF

cat > migrations/002_add_dashboards.sql << 'DOCEOF'
CREATE TABLE IF NOT EXISTS dashboards (
    id String,
    org_id String,
    name String,
    description String DEFAULT '',
    widgets String,  -- JSON array
    created_by String,
    is_public UInt8 DEFAULT 0,
    created_at DateTime64(3),
    updated_at DateTime64(3)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (org_id, id);
DOCEOF

cat > src/services/migrate.py << 'DOCEOF'
"""Database migration runner."""
import structlog
from pathlib import Path

logger = structlog.get_logger()

MIGRATIONS_DIR = Path(__file__).parent.parent.parent / "migrations"

class Migrator:
    def __init__(self, ch_pool):
        self.ch = ch_pool

    async def run_all(self):
        files = sorted(MIGRATIONS_DIR.glob("*.sql"))
        for f in files:
            logger.info("migration.running", file=f.name)
            sql = f.read_text()
            for stmt in sql.split(";"):
                stmt = stmt.strip()
                if stmt:
                    await self.ch.execute(stmt)
            logger.info("migration.done", file=f.name)
DOCEOF

git add -A && git commit -m "feat: add ClickHouse schema migrations" --quiet --date="2026-01-31T10:00:00+08:00"

cat > migrations/003_add_sessions_table.sql << 'DOCEOF'
CREATE TABLE IF NOT EXISTS sessions (
    id String,
    org_id String,
    user_id String,
    started_at DateTime64(3),
    ended_at Nullable(DateTime64(3)),
    duration_ms Nullable(UInt64),
    pages_viewed UInt32 DEFAULT 0,
    events_count UInt32 DEFAULT 0,
    country Nullable(String),
    device_type Nullable(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, user_id, started_at);
DOCEOF

cat > migrations/004_materialized_views.sql << 'DOCEOF'
-- Materialized view for real-time event counts
CREATE MATERIALIZED VIEW IF NOT EXISTS events_hourly_mv
ENGINE = SummingMergeTree()
ORDER BY (org_id, name, hour)
AS SELECT
    org_id,
    name,
    toStartOfHour(timestamp) AS hour,
    count() AS event_count,
    uniqExact(user_id) AS unique_users
FROM events
GROUP BY org_id, name, hour;
DOCEOF

git add -A && git commit -m "feat: add sessions table and materialized views" --quiet --date="2026-02-01T14:00:00+08:00"

git checkout main --quiet

# --- Branch 5: refactor-pipeline (targeting main) ---
git checkout -b grove/refactor-pipeline-f1a2b3 --quiet

cat > src/services/pipeline.py << 'DOCEOF'
"""Unified data pipeline with pluggable stages."""
import asyncio
import structlog
from abc import ABC, abstractmethod
from typing import AsyncIterator
from dataclasses import dataclass, field

logger = structlog.get_logger()

@dataclass
class PipelineEvent:
    data: dict
    metadata: dict = field(default_factory=dict)

class Stage(ABC):
    @abstractmethod
    async def process(self, event: PipelineEvent) -> PipelineEvent | None:
        """Process event. Return None to filter out."""
        ...

class ValidationStage(Stage):
    async def process(self, event: PipelineEvent) -> PipelineEvent | None:
        if "name" not in event.data:
            logger.warning("pipeline.invalid_event", data=event.data)
            return None
        return event

class EnrichmentStage(Stage):
    async def process(self, event: PipelineEvent) -> PipelineEvent | None:
        event.metadata["processed_at"] = "now"
        # TODO: add geo-IP enrichment
        return event

class Pipeline:
    def __init__(self, stages: list[Stage]):
        self.stages = stages

    async def run(self, events: AsyncIterator[PipelineEvent]):
        async for event in events:
            result = event
            for stage in self.stages:
                result = await stage.process(result)
                if result is None:
                    break
            if result:
                yield result
DOCEOF

git add -A && git commit -m "refactor: extract data pipeline into pluggable stage architecture" --quiet --date="2026-02-02T10:00:00+08:00"

cat > src/services/pipeline_stages.py << 'DOCEOF'
"""Built-in pipeline stages."""
from .pipeline import Stage, PipelineEvent
import structlog

logger = structlog.get_logger()

class DeduplicationStage(Stage):
    """Deduplicate events by idempotency key."""
    def __init__(self):
        self._seen: set[str] = set()

    async def process(self, event: PipelineEvent) -> PipelineEvent | None:
        key = event.data.get("idempotency_key")
        if key and key in self._seen:
            return None
        if key:
            self._seen.add(key)
        return event

class SamplingStage(Stage):
    """Sample a percentage of events."""
    def __init__(self, rate: float = 1.0):
        self.rate = rate
        self._count = 0

    async def process(self, event: PipelineEvent) -> PipelineEvent | None:
        self._count += 1
        if (self._count % int(1 / self.rate)) != 0:
            return None
        return event

class TransformStage(Stage):
    """Apply transformations to event properties."""
    async def process(self, event: PipelineEvent) -> PipelineEvent | None:
        # Normalize property keys to snake_case
        props = event.data.get("properties", {})
        event.data["properties"] = {
            k.lower().replace(" ", "_"): v for k, v in props.items()
        }
        return event
DOCEOF

git add -A && git commit -m "feat: add dedup, sampling, and transform pipeline stages" --quiet --date="2026-02-03T14:00:00+08:00"

cat > tests/test_pipeline.py << 'DOCEOF'
"""Pipeline stage tests."""
import pytest
from src.services.pipeline import Pipeline, PipelineEvent, ValidationStage, EnrichmentStage
from src.services.pipeline_stages import DeduplicationStage, TransformStage

async def events_from_list(items):
    for item in items:
        yield PipelineEvent(data=item)

@pytest.mark.asyncio
async def test_validation_filters_invalid():
    pipeline = Pipeline([ValidationStage()])
    events = [{"name": "click"}, {"invalid": True}, {"name": "page_view"}]
    results = [e async for e in pipeline.run(events_from_list(events))]
    assert len(results) == 2

@pytest.mark.asyncio
async def test_dedup_removes_duplicates():
    stage = DeduplicationStage()
    e1 = PipelineEvent(data={"name": "click", "idempotency_key": "abc"})
    e2 = PipelineEvent(data={"name": "click", "idempotency_key": "abc"})
    assert await stage.process(e1) is not None
    assert await stage.process(e2) is None
DOCEOF

git add -A && git commit -m "test: add pipeline stage unit tests" --quiet --date="2026-02-04T09:00:00+08:00"

git checkout main --quiet

# --- Branch 6: update-sdk (targeting main, fresh) ---
git checkout -b grove/update-sdk-d2e3f4 --quiet

cat > docs/sdk-guide.md << 'DOCEOF'
# Pulse Python SDK Guide

## Installation

```bash
pip install pulse-analytics-sdk
```

## Quick Start

```python
from pulse import Pulse

client = Pulse(api_key="pk_live_xxx")

# Track an event
client.track("page_view", user_id="user-123", properties={
    "path": "/pricing",
    "referrer": "google",
})

# Batch tracking
with client.batch() as batch:
    batch.track("signup", user_id="user-456")
    batch.track("purchase", user_id="user-456", properties={"plan": "pro"})
```
DOCEOF

git add -A && git commit -m "docs: add Python SDK quick start guide" --quiet --date="2026-02-06T08:00:00+08:00"

git checkout main --quiet

# ============================================================================
# Step 4: Create git worktrees
# ============================================================================
echo ""
echo "🔗 Creating worktrees..."

mkdir -p "$WORKTREE_DIR"

git worktree add "$WORKTREE_DIR/add-oauth" grove/add-oauth-a1b2c3 --quiet 2>/dev/null
git worktree add "$WORKTREE_DIR/fix-ws-leak" fix/ws-memory-leak-c3d4e5 --quiet 2>/dev/null
git worktree add "$WORKTREE_DIR/dashboard-v2" feature/dashboard-v2-e5f6a7 --quiet 2>/dev/null
git worktree add "$WORKTREE_DIR/clickhouse" feature/clickhouse-migration-b8c9d0 --quiet 2>/dev/null
git worktree add "$WORKTREE_DIR/refactor-pipeline" grove/refactor-pipeline-f1a2b3 --quiet 2>/dev/null
git worktree add "$WORKTREE_DIR/update-sdk" grove/update-sdk-d2e3f4 --quiet 2>/dev/null

echo "✅ 6 worktrees created"

# ============================================================================
# Step 5: Create Grove project data
# ============================================================================
echo ""
echo "📋 Setting up Grove project data..."

mkdir -p "$PROJ_DATA_DIR"/{notes,ai/{add-oauth,fix-ws-leak,dashboard-v2,clickhouse,refactor-pipeline}}

# --- project.toml ---
cat > "$PROJ_DATA_DIR/project.toml" << DOCEOF
name = "pulse"
path = "$DEMO_DIR"
added_at = "2026-01-20T02:00:00.000000Z"
DOCEOF

# --- tasks.toml ---
cat > "$PROJ_DATA_DIR/tasks.toml" << DOCEOF
[[tasks]]
id = "add-oauth"
name = "Add OAuth provider support"
branch = "grove/add-oauth-a1b2c3"
target = "main"
worktree_path = "$WORKTREE_DIR/add-oauth"
created_at = "2026-02-03T01:00:00.000000Z"
updated_at = "2026-02-04T08:30:00.000000Z"
status = "active"
multiplexer = "tmux"
session_name = ""

[[tasks]]
id = "fix-ws-leak"
name = "Fix WebSocket memory leak"
branch = "fix/ws-memory-leak-c3d4e5"
target = "main"
worktree_path = "$WORKTREE_DIR/fix-ws-leak"
created_at = "2026-02-04T03:00:00.000000Z"
updated_at = "2026-02-05T01:30:00.000000Z"
status = "active"
multiplexer = "tmux"
session_name = ""

[[tasks]]
id = "dashboard-v2"
name = "Redesign dashboard API"
branch = "feature/dashboard-v2-e5f6a7"
target = "main"
worktree_path = "$WORKTREE_DIR/dashboard-v2"
created_at = "2026-02-03T02:00:00.000000Z"
updated_at = "2026-02-05T08:00:00.000000Z"
status = "active"
multiplexer = "tmux"
session_name = ""

[[tasks]]
id = "clickhouse"
name = "Migrate to ClickHouse"
branch = "feature/clickhouse-migration-b8c9d0"
target = "main"
worktree_path = "$WORKTREE_DIR/clickhouse"
created_at = "2026-01-31T02:00:00.000000Z"
updated_at = "2026-02-01T06:00:00.000000Z"
status = "active"
multiplexer = "tmux"
session_name = ""

[[tasks]]
id = "refactor-pipeline"
name = "Refactor data pipeline"
branch = "grove/refactor-pipeline-f1a2b3"
target = "main"
worktree_path = "$WORKTREE_DIR/refactor-pipeline"
created_at = "2026-02-02T02:00:00.000000Z"
updated_at = "2026-02-04T01:00:00.000000Z"
status = "active"
multiplexer = "tmux"
session_name = ""

[[tasks]]
id = "update-sdk"
name = "Update Python SDK docs"
branch = "grove/update-sdk-d2e3f4"
target = "main"
worktree_path = "$WORKTREE_DIR/update-sdk"
created_at = "2026-02-06T00:00:00.000000Z"
updated_at = "2026-02-06T00:00:00.000000Z"
status = "active"
multiplexer = "tmux"
session_name = ""
DOCEOF

# --- archived.toml ---
cat > "$PROJ_DATA_DIR/archived.toml" << DOCEOF
[[tasks]]
id = "add-webhooks"
name = "Add webhook notifications"
branch = "grove/add-webhooks-a0b1c2"
target = "main"
worktree_path = "$WORKTREE_DIR/add-webhooks"
created_at = "2026-01-25T02:00:00.000000Z"
updated_at = "2026-01-29T06:00:00.000000Z"
status = "archived"
multiplexer = "tmux"
session_name = ""

[[tasks]]
id = "fix-cors"
name = "Fix CORS headers"
branch = "grove/fix-cors-d3e4f5"
target = "main"
worktree_path = "$WORKTREE_DIR/fix-cors"
created_at = "2026-01-27T02:00:00.000000Z"
updated_at = "2026-01-28T06:00:00.000000Z"
status = "archived"
multiplexer = "tmux"
session_name = ""
DOCEOF

# ============================================================================
# Step 6: Task Notes
# ============================================================================
echo "📝 Writing task notes..."

cat > "$PROJ_DATA_DIR/notes/add-oauth.md" << 'DOCEOF'
## Requirements

- Support Google, GitHub, and Microsoft OAuth providers
- Store OAuth tokens securely with encryption at rest
- CSRF protection using Redis-backed state tokens
- Auto-link OAuth accounts to existing email-matched users

## Design Notes

- Using httpx for async OAuth token exchange
- State tokens expire after 10 minutes (OAuthSessionManager)
- Provider config loaded from env: `PULSE_OAUTH_GOOGLE_CLIENT_ID`, etc.

## Open Questions

- [ ] Should we support SAML for enterprise customers?
- [x] Which OAuth scopes to request (email + profile)
DOCEOF

cat > "$PROJ_DATA_DIR/notes/fix-ws-leak.md" << 'DOCEOF'
## Problem

Memory usage grows linearly over time in production. After 24h, the API server uses ~2GB RAM (expected: ~200MB).

Profiled with `memray` — root cause is `RateLimitMiddleware._requests` dict that never cleans up entries for disconnected clients. Each client IP accumulates timestamps forever.

## Fix

1. Replace in-memory sliding window with Redis `INCR` + `EXPIRE`
2. Add periodic cleanup to WebSocket ConnectionManager
3. Use `weakref` for internal connection tracking

## Validation

- Load test with 10k concurrent connections for 1 hour
- Memory should stay flat at ~200MB
DOCEOF

cat > "$PROJ_DATA_DIR/notes/clickhouse.md" << 'DOCEOF'
## Migration Plan

Migrating event storage from PostgreSQL to ClickHouse for better OLAP performance.

### Phase 1: Schema (current)
- Design ClickHouse tables with proper partitioning
- MergeTree engine for events, ReplacingMergeTree for users/dashboards
- 90-day TTL on raw events

### Phase 2: Dual-write
- Write to both PG and CH during transition
- Compare query results for correctness

### Phase 3: Cutover
- Switch reads to ClickHouse
- Deprecate PG event tables
- Keep PG for user/auth data only
DOCEOF

cat > "$PROJ_DATA_DIR/notes/update-sdk.md" << 'DOCEOF'
Update the Python SDK documentation with:
- New batch tracking API
- Async client support
- Error handling best practices
DOCEOF

# ============================================================================
# Step 7: Code Review Comments
# ============================================================================
echo "💬 Adding review comments..."

# add-oauth: 4 comments (2 resolved, 1 open, 1 not_resolved)
cat > "$PROJ_DATA_DIR/ai/add-oauth/diff_comments.md" << 'DOCEOF'
src/routes/oauth.py:L18
The `redirect_uri` parameter should be validated against an allowlist to prevent open redirect attacks. Don't accept arbitrary URLs from the client.
=====
src/services/oauth_providers.py:L25
Missing error handling for the HTTP request. If Google's token endpoint is down or returns an error, this will crash with an unhandled exception.
=====
src/services/oauth_providers.py:L62
Same issue as the Google provider - need proper error handling for the GitHub token exchange. Also, the `Accept: application/json` header should be configurable.
=====
src/services/oauth_session.py:L15
Consider using a shorter TTL (5 min) for OAuth state tokens. 10 minutes is generous and increases the attack window.
DOCEOF

cat > "$PROJ_DATA_DIR/ai/add-oauth/replies.json" << 'DOCEOF'
{
    "src/routes/oauth.py:L18": {
        "status": "resolved",
        "reply": "Added redirect_uri validation against PULSE_OAUTH_ALLOWED_REDIRECTS config. Invalid URIs now return 400."
    },
    "src/services/oauth_providers.py:L25": {
        "status": "resolved",
        "reply": "Added try/except with httpx.HTTPError handling. Returns OAuthError with provider name and status code."
    },
    "src/services/oauth_session.py:L15": {
        "status": "not_resolved",
        "reply": "I'd prefer to keep 10 min for now. Users on slow networks sometimes take longer to complete the OAuth flow. We can tighten this later with telemetry data."
    }
}
DOCEOF

# dashboard-v2: 3 open comments
cat > "$PROJ_DATA_DIR/ai/dashboard-v2/diff_comments.md" << 'DOCEOF'
src/routes/dashboards.py:L76
The `stream_dashboard` WebSocket endpoint has no authentication. Any client can connect and receive real-time data without a token.
=====
src/services/query_engine.py:L23
Cache key includes the full query string - this is fragile. Whitespace differences or parameter ordering will cause cache misses for logically identical queries.
=====
src/routes/templates.py:L15
Templates are hardcoded in memory. Consider loading from a JSON/YAML file or database so they can be updated without redeployment.
DOCEOF

# refactor-pipeline: 3 comments (1 resolved, 2 open)
cat > "$PROJ_DATA_DIR/ai/refactor-pipeline/diff_comments.md" << 'DOCEOF'
src/services/pipeline.py:L38
The Pipeline.run method swallows errors silently when a stage raises an exception. Failed events should be sent to a dead-letter queue for inspection.
=====
src/services/pipeline_stages.py:L10
DeduplicationStage uses an unbounded in-memory set. In production this will grow forever and consume all memory. Use a Redis set with TTL or a bloom filter.
=====
src/services/pipeline_stages.py:L23
SamplingStage uses modulo arithmetic which doesn't give true random sampling. Consider using random.random() < self.rate for statistically correct sampling.
DOCEOF

cat > "$PROJ_DATA_DIR/ai/refactor-pipeline/replies.json" << 'DOCEOF'
{
    "src/services/pipeline_stages.py:L23": {
        "status": "resolved",
        "reply": "Switched to random.random() for proper statistical sampling. Also added a seed parameter for reproducible testing."
    }
}
DOCEOF

# fix-ws-leak: AI summary
cat > "$PROJ_DATA_DIR/ai/fix-ws-leak/summary.md" << 'DOCEOF'
## Summary

Fixed a critical memory leak in production caused by the in-memory rate limiter and WebSocket connection manager.

### Root Cause
- `RateLimitMiddleware._requests` dict accumulated client IPs indefinitely
- Disconnected WebSocket connections were never cleaned up

### Changes
1. **Rate Limiter**: Replaced in-memory sliding window with Redis `INCR` + `EXPIRE` — memory bounded, works across workers
2. **WebSocket Manager**: Added periodic cleanup task that removes stale connections every 30s
3. Added comprehensive tests for both fixes

### Impact
- Memory usage: ~2GB → ~200MB (after 24h load test)
- Rate limiting now works correctly in multi-worker deployments
DOCEOF

# ============================================================================
# Step 8: Create tmux sessions for "Live" tasks
# ============================================================================
echo ""
echo "🖥️  Creating tmux sessions for live tasks..."

# Session name format: grove-<hash>-<task-id>
SESSION_PREFIX="grove-$PROJECT_HASH"

for task_id in add-oauth fix-ws-leak dashboard-v2; do
    session="$SESSION_PREFIX-$task_id"
    wt_path="$WORKTREE_DIR/$task_id"
    if tmux has-session -t "$session" 2>/dev/null; then
        tmux kill-session -t "$session"
    fi
    tmux new-session -d -s "$session" -c "$wt_path" 2>/dev/null || true
    echo "  ● $task_id (live)"
done

for task_id in clickhouse refactor-pipeline update-sdk; do
    echo "  ○ $task_id (idle)"
done

# ============================================================================
# Step 9: Set up hooks notification data
# ============================================================================
echo ""
echo "🔔 Setting up hook notifications..."

cat > "$PROJ_DATA_DIR/hooks.toml" << 'DOCEOF'
[[history]]
level = "notice"
task_id = "fix-ws-leak"
task_name = "Fix WebSocket memory leak"
message = "All changes committed and tests passing."
timestamp = "2026-02-05T01:28:00.000000Z"

[[history]]
level = "warn"
task_id = "add-oauth"
task_name = "Add OAuth provider support"
message = "2 review comments need your attention."
timestamp = "2026-02-04T22:15:00.000000Z"

[[history]]
level = "notice"
task_id = "dashboard-v2"
task_name = "Redesign dashboard API"
message = "Dashboard streaming endpoint implemented."
timestamp = "2026-02-05T08:00:00.000000Z"

[[history]]
level = "critical"
task_id = "refactor-pipeline"
task_name = "Refactor data pipeline"
message = "Pipeline test_validation_filters_invalid FAILED"
timestamp = "2026-02-04T01:00:00.000000Z"
DOCEOF

# ============================================================================
# Done!
# ============================================================================
echo ""
echo "============================================"
echo "🌳 Grove Demo Setup Complete!"
echo "============================================"
echo ""
echo "Project:    $DEMO_DIR"
echo "Hash:       $PROJECT_HASH"
echo "Tasks:      6 active (3 live, 3 idle) + 2 archived"
echo ""
echo "To launch Grove TUI:"
echo "  cd $DEMO_DIR && grove"
echo ""
echo "Features to demo:"
echo "  📋 6 active tasks in various states"
echo "  📝 4 tasks with notes (e, then view in preview panel)"
echo "  💬 3 tasks with code review comments"
echo "  🔔 4 hook notification entries"
echo "  🌿 Multiple branches with real commit history"
echo "  📊 File edit heatmap from real code changes"
echo ""
echo "Live sessions: add-oauth, fix-ws-leak, dashboard-v2"
echo "Idle tasks:    clickhouse, refactor-pipeline, update-sdk"
echo "Archived:      add-webhooks, fix-cors"
echo ""

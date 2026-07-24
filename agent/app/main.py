from pathlib import Path
from dotenv import load_dotenv
# Load from repo root (.env sits one level above agent/)
load_dotenv(Path(__file__).parent.parent.parent / ".env")

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.classify import router as classify_router
from app.routes.negotiate import router as negotiate_router
from app.routes.outreach_template import router as outreach_template_router
from app.security import require_api_key

app = FastAPI(title="Pluvus Agent Service", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "agent"}


@app.get("/metrics", dependencies=[Depends(require_api_key)])
def metrics() -> dict:
    """HARD-O1: the code-side metrics surface. Returns a coarse aggregate over the
    in-process LLM-call ring buffer (call count, error rate, latency, token + cost
    totals). This is the SCAFFOLDING seam a real monitoring backend scrapes.

    W-9: now behind require_api_key like the AI routes — the LLM cost/latency
    figures it exposes are operationally sensitive, so it should not be world-
    readable when a key is configured. Health stays open (it carries no data)."""
    from app.telemetry import summary

    return summary()


app.include_router(classify_router)
app.include_router(negotiate_router)
app.include_router(outreach_template_router)

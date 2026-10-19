"""ingest-api: receives sensor readings, validates them and stores them.

POST /readings  -> 201 + id of the stored reading
GET  /health    -> liveness and database check (used by the Docker healthcheck)
"""

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, status
from psycopg.conninfo import make_conninfo
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ingest-api")

# make_conninfo escapes the values (a password containing spaces or quotes is safe).
DB_CONNINFO = make_conninfo(
    host=os.environ["DB_HOST"],
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ["DB_NAME"],
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    connect_timeout=5,
)

# A pool keeps a few connections open instead of opening one per request.
pool = ConnectionPool(DB_CONNINFO, min_size=1, max_size=4, open=False)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    pool.open()
    yield
    pool.close()


app = FastAPI(title="GreenPulse ingest-api", lifespan=lifespan)


class Reading(BaseModel):
    """A measurement sent by a sensor. Out-of-range values are rejected (422)."""

    sensor_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")
    temperature: float = Field(ge=-40, le=80, description="Air temperature, °C")
    humidity: float = Field(ge=0, le=100, description="Relative humidity, %")
    soil_moisture: float = Field(ge=0, le=100, description="Soil moisture, %")
    recorded_at: datetime | None = Field(default=None, description="Defaults to now")

    @field_validator("recorded_at")
    @classmethod
    def not_in_the_future(cls, value: datetime | None) -> datetime | None:
        if value is not None:
            if value.tzinfo is None:
                raise ValueError("recorded_at must include a timezone")
            if value > datetime.now(timezone.utc) + timedelta(minutes=1):
                raise ValueError("recorded_at is in the future")
        return value


@app.post("/readings", status_code=status.HTTP_201_CREATED)
def create_reading(reading: Reading) -> dict:
    with pool.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO readings (sensor_id, recorded_at, temperature, humidity, soil_moisture)
            VALUES (%s, COALESCE(%s, now()), %s, %s, %s)
            RETURNING id
            """,
            (
                reading.sensor_id,
                reading.recorded_at,
                reading.temperature,
                reading.humidity,
                reading.soil_moisture,
            ),
        ).fetchone()
    return {"id": row[0]}


@app.get("/health")
def health() -> dict:
    try:
        with pool.connection(timeout=3) as conn:
            conn.execute("SELECT 1")
    except Exception as exc:  # any DB problem means "not healthy"
        log.warning("health check failed: %s", exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "database unreachable")
    return {"status": "ok"}

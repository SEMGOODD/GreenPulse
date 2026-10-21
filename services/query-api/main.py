"""query-api: read side of GreenPulse. Serves the dashboard and its JSON API.

GET /                 dashboard (HTML), greets the name stored in the hello table
GET /api/hello        {"message": "hello <name>"} (the PDF requirement, as JSON)
GET /api/overview     latest reading per sensor, KPIs, thresholds
GET /api/readings     time series of one metric, averaged per time bucket
GET /api/alerts       active alerts first, then the most recent resolved ones
GET /health           liveness and database check (Docker healthcheck)
Prometheus metrics: separate port METRICS_PORT (default 9103), not public.
"""

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from prometheus_client import start_http_server
from prometheus_fastapi_instrumentator import Instrumentator
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("query-api")

BASE_DIR = Path(__file__).parent

DB_CONNINFO = make_conninfo(
    host=os.environ["DB_HOST"],
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ["DB_NAME"],
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    connect_timeout=5,
)
# PDF requirement: the table named like the DB user holds the name to greet.
HELLO_TABLE = os.environ.get("HELLO_TABLE", os.environ["DB_USER"])
# Configured order of the sensors: it fixes each sensor's chart color.
SENSOR_IDS = [s.strip() for s in os.environ.get("SENSOR_IDS", "").split(",") if s.strip()]
OFFLINE_AFTER_SECONDS = int(os.environ.get("OFFLINE_AFTER_SECONDS", "30"))
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "5"))
METRICS_PORT = int(os.environ.get("METRICS_PORT", "9103"))


def optional_float(name: str, default: str) -> float | None:
    value = os.environ.get(name, default).strip()
    return float(value) if value else None


# Same environment variables (and defaults) as alert-worker, so the dashboard
# draws exactly the thresholds that raise the alerts.
METRICS = {
    "temperature": {"label": "Temperature", "short": "Air temp.", "unit": "°C",
                    "low": optional_float("TEMPERATURE_MIN", "5"),
                    "high": optional_float("TEMPERATURE_MAX", "35")},
    "humidity": {"label": "Humidity", "short": "Humidity", "unit": "%",
                 "low": optional_float("HUMIDITY_MIN", "30"),
                 "high": optional_float("HUMIDITY_MAX", "90")},
    "soil_moisture": {"label": "Soil moisture", "short": "Soil", "unit": "%",
                      "low": optional_float("SOIL_MOISTURE_MIN", "20"),
                      "high": optional_float("SOIL_MOISTURE_MAX", "")},
}
Metric = Literal["temperature", "humidity", "soil_moisture"]

pool = ConnectionPool(DB_CONNINFO, min_size=1, max_size=6, open=False,
                      kwargs={"row_factory": dict_row})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    pool.open()
    start_http_server(METRICS_PORT)
    yield
    pool.close()


app = FastAPI(title="GreenPulse query-api", lifespan=lifespan)
# Request count, latency and status per endpoint (healthchecks and static files excluded).
Instrumentator(excluded_handlers=["/health", "/static.*"]).instrument(app)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def greeting() -> str:
    # The table name is an identifier: sql.Identifier quotes it safely.
    query = sql.SQL("SELECT name FROM {} ORDER BY id LIMIT 1").format(sql.Identifier(HELLO_TABLE))
    with pool.connection() as conn:
        row = conn.execute(query).fetchone()
    return f"hello {row['name']}" if row else "hello"


def ordered_sensors(found: list[str]) -> list[str]:
    """Configured sensors first (in their configured order), then unknown ones."""
    extra = sorted(s for s in found if s not in SENSOR_IDS)
    return SENSOR_IDS + extra


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    return templates.TemplateResponse(request, "index.html", {
        "greeting": greeting(),
        # tojson sorts dict keys: the display order is sent separately.
        "config": {"refresh_seconds": REFRESH_SECONDS, "metrics": METRICS,
                   "metric_order": list(METRICS)},
    })


@app.get("/api/hello")
def hello() -> dict:
    return {"message": greeting()}


@app.get("/api/overview")
def overview() -> dict:
    with pool.connection() as conn:
        latest = conn.execute("""
            SELECT DISTINCT ON (sensor_id) sensor_id, recorded_at,
                   temperature, humidity, soil_moisture
            FROM readings
            WHERE recorded_at > now() - interval '1 day'
            ORDER BY sensor_id, recorded_at DESC
        """).fetchall()
        active = conn.execute("""
            SELECT sensor_id, metric, kind, threshold, last_value
            FROM alerts WHERE resolved_at IS NULL
        """).fetchall()
        readings_last_hour = conn.execute(
            "SELECT count(*) AS n FROM readings WHERE recorded_at > now() - interval '1 hour'"
        ).fetchone()["n"]

    now = datetime.now(timezone.utc)
    by_sensor = {row["sensor_id"]: row for row in latest}
    sensors = []
    for sensor_id in ordered_sensors(list(by_sensor)):
        row = by_sensor.get(sensor_id)
        alerts = [a for a in active if a["sensor_id"] == sensor_id]
        age = (now - row["recorded_at"]).total_seconds() if row else None
        if row is None or age > OFFLINE_AFTER_SECONDS:
            state = "offline"
        else:
            state = "alert" if alerts else "ok"
        sensors.append({
            "sensor_id": sensor_id,
            "state": state,
            "recorded_at": row["recorded_at"] if row else None,
            "values": {m: row[m] for m in METRICS} if row else None,
            "alerts": [{"metric": a["metric"], "kind": a["kind"], "threshold": a["threshold"]}
                       for a in alerts],
        })

    online = [s for s in sensors if s["state"] != "offline"]
    avg_temperature = (sum(s["values"]["temperature"] for s in online) / len(online)
                       if online else None)
    return {
        "server_time": now,
        "sensors": sensors,
        "kpis": {
            "sensors_online": len(online),
            "sensors_total": len(sensors),
            "active_alerts": len(active),
            "readings_last_hour": readings_last_hour,
            "avg_temperature": avg_temperature,
        },
    }


@app.get("/api/readings")
def readings(
    metric: Metric = "temperature",
    minutes: int = Query(60, ge=5, le=1440, description="Time window, in minutes"),
) -> dict:
    # About 120 points per series whatever the window: the chart stays light.
    bucket_seconds = max(10, minutes * 60 // 120)
    query = sql.SQL("""
        SELECT sensor_id,
               date_bin(make_interval(secs => %(bucket)s), recorded_at,
                        TIMESTAMPTZ '2000-01-01') AS bucket,
               avg({metric}) AS value
        FROM readings
        WHERE recorded_at > now() - make_interval(mins => %(minutes)s)
        GROUP BY sensor_id, bucket
        ORDER BY sensor_id, bucket
    """).format(metric=sql.Identifier(metric))
    with pool.connection() as conn:
        rows = conn.execute(query, {"bucket": bucket_seconds, "minutes": minutes}).fetchall()

    points: dict[str, list] = {}
    for row in rows:
        points.setdefault(row["sensor_id"], []).append(
            [int(row["bucket"].timestamp() * 1000), round(row["value"], 2)])
    now = datetime.now(timezone.utc)
    return {
        "metric": metric,
        **METRICS[metric],
        "minutes": minutes,
        "bucket_seconds": bucket_seconds,
        "to": int(now.timestamp() * 1000),
        "series": [{"sensor_id": s, "points": points.get(s, [])}
                   for s in ordered_sensors(list(points))],
    }


@app.get("/api/alerts")
def alerts(limit: int = Query(30, ge=1, le=200)) -> dict:
    with pool.connection() as conn:
        rows = conn.execute("""
            SELECT id, sensor_id, metric, kind, threshold, first_value, worst_value,
                   last_value, started_at, last_seen_at, resolved_at
            FROM alerts
            ORDER BY (resolved_at IS NULL) DESC, started_at DESC
            LIMIT %s
        """, (limit,)).fetchall()
    return {"alerts": rows}


@app.get("/health")
def health() -> dict:
    try:
        with pool.connection(timeout=3) as conn:
            conn.execute("SELECT 1")
    except Exception as exc:
        log.warning("health check failed: %s", exc)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "database unreachable")
    return {"status": "ok"}

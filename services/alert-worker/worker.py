"""alert-worker: evaluates new readings against thresholds and manages alerts.

Every POLL_SECONDS:
  1. take the readings not evaluated yet (and mark them as evaluated),
  2. for each metric out of its normal range -> open an alert, or update the
     one already open for that sensor and metric,
  3. for each metric back in range -> resolve the open alert,
  4. once an hour, delete readings older than RETENTION_DAYS.
Prometheus metrics are served on METRICS_PORT (default 9101).
"""

import logging
import os
import signal
import time
from dataclasses import dataclass
from pathlib import Path

import psycopg
from prometheus_client import Counter, Gauge, Histogram, start_http_server
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("alert-worker")

DB_CONNINFO = make_conninfo(
    host=os.environ["DB_HOST"],
    port=os.environ.get("DB_PORT", "5432"),
    dbname=os.environ["DB_NAME"],
    user=os.environ["DB_USER"],
    password=os.environ["DB_PASSWORD"],
    connect_timeout=5,
)
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "5"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "500"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "7"))
PURGE_EVERY_SECONDS = 3600
METRICS_PORT = int(os.environ.get("METRICS_PORT", "9101"))

# Prometheus metrics: is the platform doing its job?
READINGS_PROCESSED = Counter(
    "greenpulse_worker_readings_processed_total", "Readings evaluated against the thresholds.")
ALERTS_OPENED = Counter(
    "greenpulse_alerts_opened_total", "Alerts opened.", ["metric", "kind"])
ALERTS_RESOLVED = Counter(
    "greenpulse_alerts_resolved_total", "Alerts resolved.", ["metric"])
ALERTS_ACTIVE = Gauge(
    "greenpulse_alerts_active", "Alerts currently open.", ["metric"])
BACKLOG = Gauge(
    "greenpulse_worker_backlog_readings", "Readings waiting to be evaluated.")
LAST_BATCH = Gauge(
    "greenpulse_worker_last_batch_timestamp_seconds", "Unix time of the last completed batch.")
BATCH_DURATION = Histogram(
    "greenpulse_worker_batch_duration_seconds", "Time spent evaluating one batch.")

# Touched after every batch; the Docker healthcheck checks that it stays recent.
HEARTBEAT_FILE = Path("/tmp/heartbeat")


@dataclass(frozen=True)
class Rule:
    """Normal range of a metric. None means "no limit on that side"."""

    metric: str
    low: float | None
    high: float | None

    def check(self, value: float) -> tuple[str, float] | None:
        """Return (kind, threshold) if the value is out of range, else None."""
        if self.high is not None and value > self.high:
            return "high", self.high
        if self.low is not None and value < self.low:
            return "low", self.low
        return None


def optional_float(name: str, default: str) -> float | None:
    value = os.environ.get(name, default).strip()
    return float(value) if value else None


# Thresholds come from the environment, so they can change without a rebuild.
RULES = [
    Rule("temperature", optional_float("TEMPERATURE_MIN", "5"), optional_float("TEMPERATURE_MAX", "35")),
    Rule("humidity", optional_float("HUMIDITY_MIN", "30"), optional_float("HUMIDITY_MAX", "90")),
    Rule("soil_moisture", optional_float("SOIL_MOISTURE_MIN", "20"), optional_float("SOIL_MOISTURE_MAX", "")),
]

# Takes a batch of unchecked readings and marks them checked in ONE statement.
# FOR UPDATE SKIP LOCKED lets several workers run side by side without
# evaluating the same reading twice.
CLAIM_READINGS = """
    UPDATE readings SET checked = true
    WHERE id IN (
        SELECT id FROM readings WHERE NOT checked
        ORDER BY id LIMIT %s
        FOR UPDATE SKIP LOCKED
    )
    RETURNING id, sensor_id, recorded_at, temperature, humidity, soil_moisture
"""

# Opens an alert, or updates the active one (the partial unique index
# alerts_one_active_idx guarantees there is at most one).
UPSERT_ALERT = """
    INSERT INTO alerts (sensor_id, metric, kind, threshold, first_value, worst_value,
                        last_value, started_at, last_seen_at)
    VALUES (%(sensor_id)s, %(metric)s, %(kind)s, %(threshold)s, %(value)s, %(value)s,
            %(value)s, %(at)s, %(at)s)
    ON CONFLICT (sensor_id, metric) WHERE resolved_at IS NULL DO UPDATE SET
        last_value   = EXCLUDED.last_value,
        last_seen_at = EXCLUDED.last_seen_at,
        worst_value  = CASE WHEN alerts.kind = 'high'
                            THEN GREATEST(alerts.worst_value, EXCLUDED.last_value)
                            ELSE LEAST(alerts.worst_value, EXCLUDED.last_value) END
    RETURNING (xmax = 0) AS created
"""

RESOLVE_ALERT = """
    UPDATE alerts SET resolved_at = %(at)s, last_value = %(value)s
    WHERE sensor_id = %(sensor_id)s AND metric = %(metric)s AND resolved_at IS NULL
    RETURNING id
"""


@BATCH_DURATION.time()
def process_batch(conn: psycopg.Connection) -> int:
    """Evaluate one batch of readings. Returns how many readings were processed."""
    with conn.transaction():
        readings = conn.execute(CLAIM_READINGS, (BATCH_SIZE,)).fetchall()
        # Oldest first, so an alert opens and resolves in the right order.
        for reading in sorted(readings, key=lambda r: r["id"]):
            for rule in RULES:
                value = reading[rule.metric]
                params = {
                    "sensor_id": reading["sensor_id"],
                    "metric": rule.metric,
                    "value": value,
                    "at": reading["recorded_at"],
                }
                breach = rule.check(value)
                if breach:
                    params["kind"], params["threshold"] = breach
                    if conn.execute(UPSERT_ALERT, params).fetchone()["created"]:
                        ALERTS_OPENED.labels(rule.metric, params["kind"]).inc()
                        log.warning("ALERT %(sensor_id)s %(metric)s %(kind)s: %(value).1f "
                                    "(threshold %(threshold)s)", params)
                elif conn.execute(RESOLVE_ALERT, params).fetchone():
                    ALERTS_RESOLVED.labels(rule.metric).inc()
                    log.info("RESOLVED %(sensor_id)s %(metric)s: %(value).1f", params)
    READINGS_PROCESSED.inc(len(readings))
    return len(readings)


def update_state_metrics(conn: psycopg.Connection) -> None:
    """Gauges read from the database: they stay right even after a restart."""
    active = dict.fromkeys((rule.metric for rule in RULES), 0)
    # Even a SELECT runs inside an explicit transaction: outside of one, psycopg
    # would leave a transaction open and the next batch would never be committed.
    with conn.transaction():
        for row in conn.execute(
                "SELECT metric, count(*) AS n FROM alerts WHERE resolved_at IS NULL GROUP BY metric"):
            active[row["metric"]] = row["n"]
        backlog = conn.execute("SELECT count(*) AS n FROM readings WHERE NOT checked").fetchone()["n"]
    for metric, count in active.items():
        ALERTS_ACTIVE.labels(metric).set(count)
    BACKLOG.set(backlog)
    LAST_BATCH.set_to_current_time()


def purge_old_readings(conn: psycopg.Connection) -> None:
    with conn.transaction():
        deleted = conn.execute(
            "DELETE FROM readings WHERE recorded_at < now() - make_interval(days => %s)",
            (RETENTION_DAYS,),
        ).rowcount
    if deleted:
        log.info("purged %d readings older than %d days", deleted, RETENTION_DAYS)


def main() -> None:
    running = True

    def stop(*_args) -> None:
        nonlocal running
        running = False

    # `docker stop` sends SIGTERM: finish the current batch, then exit cleanly.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    log.info("starting, rules: %s", RULES)
    start_http_server(METRICS_PORT)
    last_purge = 0.0
    while running:
        try:
            with psycopg.connect(DB_CONNINFO, row_factory=dict_row) as conn:
                log.info("connected to the database")
                while running:
                    if time.monotonic() - last_purge > PURGE_EVERY_SECONDS:
                        purge_old_readings(conn)
                        last_purge = time.monotonic()
                    processed = process_batch(conn)
                    update_state_metrics(conn)
                    HEARTBEAT_FILE.touch()
                    # A full batch means there is a backlog: loop again at once.
                    if processed < BATCH_SIZE:
                        time.sleep(POLL_SECONDS)
        except psycopg.OperationalError as exc:
            # Database down or unreachable: wait and reconnect instead of crashing.
            log.error("database error: %s (retrying in 5 s)", exc)
            time.sleep(5)
    log.info("stopped")


if __name__ == "__main__":
    main()

-- GreenPulse schema: single source of truth for the telemetry tables.
-- Run by Ansible (roles/postgres) on the BDD VM, and by the local dev stack

CREATE TABLE IF NOT EXISTS readings (
    id            BIGSERIAL PRIMARY KEY,
    sensor_id     VARCHAR(64)      NOT NULL,
    recorded_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    temperature   DOUBLE PRECISION NOT NULL,
    humidity      DOUBLE PRECISION NOT NULL,
    soil_moisture DOUBLE PRECISION NOT NULL,
    checked       BOOLEAN          NOT NULL DEFAULT false
);

-- Dashboard queries: "latest readings of a sensor", "readings of the last hour".
CREATE INDEX IF NOT EXISTS readings_sensor_time_idx ON readings (sensor_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS readings_time_idx ON readings (recorded_at DESC);
-- alert-worker only scans readings it has not evaluated yet.
CREATE INDEX IF NOT EXISTS readings_unchecked_idx ON readings (id) WHERE NOT checked;

-- One row per anomaly episode (written by alert-worker).
-- An alert is "active" while resolved_at is NULL, and resolved when the
-- metric comes back inside its normal range.
CREATE TABLE IF NOT EXISTS alerts (
    id           BIGSERIAL PRIMARY KEY,
    sensor_id    VARCHAR(64)      NOT NULL,
    metric       VARCHAR(32)      NOT NULL,
    kind         VARCHAR(8)       NOT NULL CHECK (kind IN ('high', 'low')),
    threshold    DOUBLE PRECISION NOT NULL,
    first_value  DOUBLE PRECISION NOT NULL,
    worst_value  DOUBLE PRECISION NOT NULL,
    last_value   DOUBLE PRECISION NOT NULL,
    started_at   TIMESTAMPTZ      NOT NULL,
    last_seen_at TIMESTAMPTZ      NOT NULL,
    resolved_at  TIMESTAMPTZ
);

-- At most ONE active alert per sensor and metric: a heatwave lasting 10 minutes
-- is one alert, not 120. The database enforces it, not just the code.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_active_idx
    ON alerts (sensor_id, metric) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS alerts_started_idx ON alerts (started_at DESC);

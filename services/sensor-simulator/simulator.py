"""sensor-simulator: virtual greenhouse sensors posting readings to ingest-api.

Each sensor follows a realistic curve (day/night temperature cycle, soil that
dries out and gets watered) plus noise. From time to time an "incident" is
injected (heatwave, dry air, irrigation failure) so that alerts get raised,
and then resolved when the incident ends.
Standard library only: no dependencies to install.
"""

import json
import logging
import math
import os
import random
import signal
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sensor-simulator")

INGEST_URL = os.environ.get("INGEST_URL", "http://ingest-api:8000/readings")
SENSOR_IDS = [s.strip() for s in os.environ.get(
    "SENSOR_IDS", "greenhouse-north,greenhouse-south,nursery").split(",") if s.strip()]
INTERVAL_SECONDS = float(os.environ.get("INTERVAL_SECONDS", "5"))
# Chance, at each tick, that a sensor starts an incident.
INCIDENT_PROBABILITY = float(os.environ.get("INCIDENT_PROBABILITY", "0.004"))
# A simulated "day" lasts this long, so the day/night cycle is visible on the chart.
DAY_LENGTH_SECONDS = float(os.environ.get("DAY_LENGTH_SECONDS", "3600"))

# name -> (metric affected, offset added at the peak of the incident)
INCIDENTS = {
    "heatwave": ("temperature", +14.0),
    "cold snap": ("temperature", -16.0),
    "dry air": ("humidity", -35.0),
    "irrigation failure": ("soil_moisture", -40.0),
}


@dataclass
class Incident:
    name: str
    metric: str
    offset: float
    total_ticks: int
    tick: int = 0

    def strength(self) -> float:
        """0 -> 1 -> 0 over the incident (smooth rise and fall)."""
        return math.sin(math.pi * self.tick / self.total_ticks)


class Sensor:
    def __init__(self, sensor_id: str, index: int):
        self.sensor_id = sensor_id
        # Each zone has its own climate, so the curves do not overlap.
        self.base_temperature = 22.0 + index * 2.5
        self.base_humidity = 65.0 - index * 6
        self.soil = random.uniform(55, 75)
        self.phase = index * 0.7
        self.incident: Incident | None = None

    def next_reading(self, now: float) -> dict:
        day = math.sin(2 * math.pi * now / DAY_LENGTH_SECONDS + self.phase)
        temperature = self.base_temperature + 6 * day + random.gauss(0, 0.3)
        # Air gets drier when it gets warmer.
        humidity = self.base_humidity - 10 * day + random.gauss(0, 1.0)

        # Soil dries out slowly, and is watered back to ~75 % when it gets low.
        self.soil -= random.uniform(0.02, 0.08)
        if self.soil < 35:
            self.soil = random.uniform(70, 78)
            log.info("%s: irrigation cycle", self.sensor_id)
        soil = self.soil + random.gauss(0, 0.4)

        values = {"temperature": temperature, "humidity": humidity, "soil_moisture": soil}
        self._apply_incident(values)
        return {
            "sensor_id": self.sensor_id,
            "temperature": round(min(max(values["temperature"], -40), 80), 2),
            "humidity": round(min(max(values["humidity"], 0), 100), 2),
            "soil_moisture": round(min(max(values["soil_moisture"], 0), 100), 2),
        }

    def _apply_incident(self, values: dict) -> None:
        if self.incident is None and random.random() < INCIDENT_PROBABILITY:
            name = random.choice(list(INCIDENTS))
            metric, offset = INCIDENTS[name]
            # Between ~2 and ~6 minutes at the default 5 s interval.
            self.incident = Incident(name, metric, offset, random.randint(24, 72))
            log.warning("%s: incident started (%s)", self.sensor_id, name)
        if self.incident:
            self.incident.tick += 1
            values[self.incident.metric] += self.incident.offset * self.incident.strength()
            if self.incident.tick >= self.incident.total_ticks:
                log.info("%s: incident over (%s)", self.sensor_id, self.incident.name)
                self.incident = None


def post_reading(reading: dict) -> None:
    request = urllib.request.Request(
        INGEST_URL,
        data=json.dumps(reading).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        response.read()


def main() -> None:
    running = True

    def stop(*_args) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    sensors = [Sensor(sensor_id, i) for i, sensor_id in enumerate(SENSOR_IDS)]
    log.info("simulating %d sensors every %.0f s -> %s", len(sensors), INTERVAL_SECONDS, INGEST_URL)
    failures = 0
    while running:
        started = time.monotonic()
        for sensor in sensors:
            try:
                post_reading(sensor.next_reading(time.time()))
                failures = 0
            except (urllib.error.URLError, OSError) as exc:
                failures += 1
                # Log the first failure, then only every 10th to avoid flooding the logs.
                if failures == 1 or failures % 10 == 0:
                    log.error("cannot reach ingest-api (%d failures): %s", failures, exc)
        time.sleep(max(0.0, INTERVAL_SECONDS - (time.monotonic() - started)))
    log.info("stopped")


if __name__ == "__main__":
    main()

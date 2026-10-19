"""GreenPulse application: reads a name from PostgreSQL and says hello.

All settings come from environment variables, provided by systemd from the
EnvironmentFile written by Ansible. The code itself contains no configuration.
"""

import os

import psycopg
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from psycopg import sql

app = FastAPI(title="GreenPulse")


def get_connection() -> psycopg.Connection:
    """Open a connection to the PostgreSQL database on the BDD VM."""
    return psycopg.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ["DB_PORT"]),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        connect_timeout=5,
    )


@app.get("/", response_class=PlainTextResponse)
def hello() -> str:
    """Return "hello <name>" using the first name stored in the table."""
    query = sql.SQL("SELECT name FROM {} ORDER BY id LIMIT 1").format(
        sql.Identifier(os.environ["DB_TABLE"])
    )
    with get_connection() as conn:
        row = conn.execute(query).fetchone()
    return f"hello {row[0]}" if row else "hello nobody"


@app.get("/health")
def health() -> dict:
    """Liveness check that does not depend on the database."""
    return {"status": "ok"}

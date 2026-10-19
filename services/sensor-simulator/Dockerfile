FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Standard library only: nothing to pip install.
COPY simulator.py .

RUN useradd --system --no-create-home app
USER app

CMD ["python", "simulator.py"]

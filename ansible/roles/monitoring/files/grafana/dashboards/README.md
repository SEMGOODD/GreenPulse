# Grafana dashboards (your exercise)

Every `*.json` file in this folder is loaded into Grafana, in the **GreenPulse** folder.

Workflow:
1. Build a dashboard in the Grafana UI (`terraform output grafana_url`, user `admin`).
2. Dashboard > Share > Export > **Export for sharing externally: off** > Save to file.
3. Put the JSON here (e.g. `infrastructure.json`), commit, `terraform apply`:
   the dashboard is now code, recreated identically on every new VM.

Suggested dashboards: Infrastructure (node_exporter), API (http_* metrics),
Business (greenpulse_* metrics), PostgreSQL (pg_* metrics).

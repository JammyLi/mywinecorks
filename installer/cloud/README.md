# MyWineCorks cloud server

One cloud server per region (default plan: AWS Tokyo for Taiwan, US-West for the US). Each
workspace is its own SQLite file under `/data/tenants/<id>/app.db`; Litestream streams every
change to object storage within about a second.

## Set up

1. Build or pull the image (`installer/docker/Dockerfile`, built with the production HQ public key).
2. `cp .env.example .env` and fill it in. `PROVISION_TOKEN` is a long random string
   (`openssl rand -base64 32`); put the same value in HQ as `CLOUD_PROVISION_TOKEN`, and the
   server's address as `CLOUD_URL`.
3. `docker compose up -d`, with HTTPS in front (load balancer or Caddy) for `PUBLIC_URL`.
4. In HQ: client › subscription with hosting "Cloud" › **Create cloud workspace**. HQ issues the
   license, creates the workspace here and emails the Owner a setup link. Renewals, grace-period
   changes and revocations are pushed here at once; there is no check-in for cloud workspaces.

## Updates

Pull the new image tag and `docker compose up -d`. Every database is backed up inside the volume
(`/data/backups`) before a new version first starts, and Litestream keeps its own history.

## Restore (point in time)

```bash
docker compose stop app
# one workspace, as it was at a given time:
docker compose run --rm litestream restore -timestamp 2026-11-26T03:00:00Z \
  -o /data/tenants/<id>/app.db.restored "s3://$LITESTREAM_BUCKET/tenants/<id>/app.db"
# check it, then move it over app.db (keep the old file), and start again:
docker compose start app
```

Each database's replica path is its path under `/data` (directory replication keeps the
layout). Restore drills are part of M10.

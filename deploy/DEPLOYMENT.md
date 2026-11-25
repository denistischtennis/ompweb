# Deploying the multiuser fork (this machine)

Canonical runtime config for the **source-built** stack served on port **1338**
(`docker-compose.yml` + `.env` + `gh-hosts.yml` in this folder). The older npm-installed
single-user stack still runs separately on :1337 from `/root/ompweb-docker`.

## Files in this directory
| File | Purpose | In git? |
|---|---|---|
| `Dockerfile.master` | master web-server image, built from repo source (npm ci+pack+install, docker CLI, gh CLI, pinned runner seed) | yes |
| `Dockerfile.host` | per-user `ompweb host` image (one image, shared by every member space) | yes |
| `entrypoint-host.sh` | host container entrypoint (logs into master; passes `--allow-http` for http URLs) | yes |
| `docker-compose.yml` | the :1338 service definition (ports, env, DinD socket mount, tool roMounts) | yes |
| `.env.example` → `.env` | `OMP_WEB_PASSWORD_HASH` (the actual `.env` holds your hash) | example only |
| `gh-hosts.yml` | gh login (`oauth_token`) mounted into master + every user space | **no** (secret) |

## Fresh-machine setup (as root)
```bash
git clone https://github.com/denistischtennis/ompweb /root/projects/ompweb
cd /root/projects/ompweb/deploy
cp .env.example .env                       # or set OMP_WEB_PASSWORD_HASH via ompweb hash-password
printf 'github.com:\n    oauth_token: <gh-token>\n' > gh-hosts.yml
chown 10000:10000 gh-hosts.yml && chmod 600 gh-hosts.yml   # readable by root AND the omp user in spaces
docker build -f Dockerfile.host   -t local/ompweb-host:0.7.4-mt.1 ..     # provisioning references this tag
ufw allow 1338/tcp                                                            # container→host-port needs an explicit rule
docker compose up -d                                                          # builds the master image and starts it
```
LAN URL: `http://192.168.1.247:1338` (update `OMP_WEB_PUBLIC_URL` if the host IP changes).

## Key settings baked into the compose
- **DinD**: `/var/run/docker.sock` is bind-mounted so the master can spawn member host
  containers as siblings on the host daemon (their bind-mount paths stay identical).
- **Provisioning active** only when both `OMP_WEB_HOST_IMAGE` and `OMP_WEB_PUBLIC_URL` are set.
- **`OMP_WEB_RO_MOUNTS`** must be granular `src:dst` (e.g. `…/opt/ida-pro-9.4:/opt/ida-pro-9.4`).
  Mounting whole `/opt` or `/home/omp` shadows the image's `/opt/ompweb` runner → host shows `omp-missing`.
- **Member model access**: provisioning seeds `mcp.json`, `skills/`, `models.yml` and `config.yml`
  from the master into each space. Without `models.yml` a member's host has no provider and every
  send fails with `Model not found` even though the master can address the model.

## Rebuilding after a code change
```bash
cd /root/projects/ompweb
docker build -f deploy/Dockerfile.master -t local/ompweb-master:0.7.4-mt.1 .
cd deploy && docker compose up -d --force-recreate
```
The browser may cache the old bundle (PWA service worker): hard-reload (Ctrl+Shift+R) or
DevTools → Application → Unregister service worker after a redeploy.

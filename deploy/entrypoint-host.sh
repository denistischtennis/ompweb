#!/bin/sh
# Container entrypoint for an ompweb HOST space (fork phase 4).
# The app and the pinned ompweb-omp binary come from the image; all mutable state
# lives under $PI_CODING_AGENT_DIR, which docker mounts per user (a volume).
# Optional provisioning inputs (set by the master's provisioner):
#   OMP_WEB_HOST_URL    - the master web server URL, e.g. http://192.168.1.10:30177
#   OMP_WEB_HOST_TOKEN  - the host token issued by the master for this user
set -eu

if [ -n "${OMP_WEB_HOST_URL:-}" ] && [ -n "${OMP_WEB_HOST_TOKEN:-}" ]; then
  # The token never travels in argv (ps would show it); feed it through stdin.
  # `host login` replaces the single stored link, so a rotated master token lands here on restart.
  printf '%s\n' "$OMP_WEB_HOST_TOKEN" | ompweb host login --url "$OMP_WEB_HOST_URL"
fi

exec ompweb host "$@"

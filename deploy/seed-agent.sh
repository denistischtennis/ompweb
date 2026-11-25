#!/bin/sh
# The standard way to give an ompweb agent directory its shared content.
#
# Everything shareable (mcp.json + the curated skills set) is taken from the
# ompweb-tools repo — the single source of truth for the fleet's agent bundle.
# Provider config (config.yml / models.yml) and runtime state (agent.db, omp-web/)
# are deployment-owned and left untouched here.
#
# Usage:
#   # host directory (e.g. a bind-mounted master home) — reads /root/projects/ompweb-tools by default:
#   ./seed-agent.sh /root/.omp/agent
#   # a docker volume (the master's agent-home volume, or a member space):
#   docker run --rm -v ompweb-1338_masteragent:/agent \
#     -v /root/projects/ompweb:/repo:ro -v /root/projects/ompweb-tools:/tools:ro \
#     alpine sh -c 'TOOLS=/tools exec /repo/deploy/seed-agent.sh /agent'
# Override the source with TOOLS=/path/to/ompweb-tools.
set -eu
TOOLS="${TOOLS:-/root/projects/ompweb-tools}"
AGENT="${1:?usage: seed-agent.sh <agent-dir>  (e.g. /root/.omp/agent)}"
SRC="$TOOLS/root/.omp/agent"

[ -f "$SRC/mcp.json" ] || { echo "error: $SRC/mcp.json not found — clone ompweb-tools or set TOOLS=" >&2; exit 1; }

install -d "$AGENT"
cp -a "$SRC/mcp.json" "$AGENT/mcp.json"
if [ -d "$SRC/skills" ]; then
  rm -rf "$AGENT/skills"
  cp -a "$SRC/skills" "$AGENT/skills"
fi

echo "seeded $AGENT from $SRC (mcp.json + skills: $(ls "$AGENT/skills" 2>/dev/null | tr '\n' ' '))"

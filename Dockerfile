# pi + pi-qbot: QQ group bot running a pi session per group.
FROM node:24-trixie-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates curl tini tmux ripgrep fd-find python3 jq \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# uv for Python tooling (used by the TG sticker importer and by the agent itself).
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/

ARG PI_VERSION=1.4.0
RUN npm install -g @earendil-works/pi-coding-agent@${PI_VERSION} && npm cache clean --force

ENV PI_SKIP_VERSION_CHECK=1 \
    PI_CODING_AGENT_DIR=/root/.pi/agent \
    TERM=xterm-256color

# Extensions baked into the image: CPA provider, realmem, empty-text guard, magic-context,
# web tools, todo, background tasks.
# Pi compaction is off: magic-context manages context itself.
RUN pi install npm:@router-for-me/pi-cliproxyapi-provider \
 && pi install git:github.com/WtzLAS/realmem \
 && pi install git:github.com/st0nie/pi-empty-text-guard \
 && pi install npm:@cortexkit/pi-magic-context \
 && pi install npm:@juicesharp/rpiv-web-tools \
 && pi install npm:@juicesharp/rpiv-todo \
 && pi install npm:pi-background-tasks \
 && jq '.compaction = {"enabled": false} | .steeringMode = "all" | .followUpMode = "all"' \
      /root/.pi/agent/settings.json > /tmp/s.json && mv /tmp/s.json /root/.pi/agent/settings.json

# The qqbot extension itself (loaded via `-e`, never by the per-group sessions).
COPY package.json tsconfig.json /opt/pi-qbot/
COPY src /opt/pi-qbot/src
COPY scripts /opt/pi-qbot/scripts

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /data
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

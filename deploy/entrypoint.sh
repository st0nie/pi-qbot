#!/bin/sh
# Starts pi with the qqbot bridge inside a detached tmux session so you can
# `docker exec -it pi-qbot tmux attach` to watch/drive it.
set -eu
MODEL="${QQBOT_MODEL:-cliproxyapi/kimi-k2.8-code}"
THINKING="${QQBOT_THINKING:-low}"
cd /data
# Trust the bot root so project-local .pi resources load without the prompt.
mkdir -p /root/.pi/agent
[ -f /root/.pi/agent/trust.json ] || echo '{"/data": true}' > /root/.pi/agent/trust.json

tmux new-session -d -s qqbot -x 200 -y 50 \
  "pi --no-session -e /opt/pi-qbot/src/index.ts --qqbot --model '$MODEL' --thinking '$THINKING'; echo 'pi exited'; sleep 5"
# Keep the container alive while the tmux session (and therefore pi) runs.
while tmux has-session -t qqbot 2>/dev/null; do sleep 5; done
echo "pi session ended" >&2
exit 1

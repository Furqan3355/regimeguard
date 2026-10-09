#!/usr/bin/env bash
# Starts everything for the public demo inside one container. See DEPLOY.md.
set -euo pipefail

# 1) Secrets arrive as environment variables. The scripts expect files, so write them out.
need() { [ -n "${!1:-}" ] || { echo "Missing secret: $1 (see DEPLOY.md)" >&2; exit 1; }; }
for v in KEY_AGENT KEY_ORACLE AGENT_CONFIG_JSON OWNER_PUBKEY GUARD_PROGRAM_ID MINT_ADDRESS RECEIVER_ATA; do need "$v"; done

mkdir -p .keys
printf '%s' "$KEY_AGENT" > .keys/agent.json
printf '%s' "$KEY_ORACLE" > .keys/oracle.json
printf '%s' "$AGENT_CONFIG_JSON" > .agent-config.json
chmod 600 .keys/*.json .agent-config.json
touch .env   # the npm scripts run with --env-file=.env; real values come from the container environment

# The owner's SECRET key is never needed here: the dashboard is read-only and the agent only needs the owner's public key.
export PUBLIC_DEMO=1
export PORT=3000   # dashboard API port (only reachable from inside the container)

# 2) Keeper first, so the oracle is fresh before anyone asks to spend
npm run keeper &
KEEPER=$!
sleep 15

# 3) Demo agent, dashboard API, and the web app on the public port
npm run agent &
AGENT=$!
npm run dashboard &
DASH=$!
(cd web && exec ./node_modules/.bin/next start -p 7860 -H 0.0.0.0) &
WEB=$!

trap 'kill $KEEPER $AGENT $DASH $WEB 2>/dev/null || true' EXIT

# If any process stops, stop the container too, so the host restarts everything cleanly
wait -n
echo "A process exited, shutting down" >&2
exit 1

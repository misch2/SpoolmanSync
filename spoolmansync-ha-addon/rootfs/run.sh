#!/usr/bin/env bash
# SpoolmanSync Add-on Startup Script

set -e

echo "=== SpoolmanSync Add-on Starting ==="

# Read add-on options
CONFIG_PATH=/data/options.json
DIRECT_PORT=3000
if [ -f "$CONFIG_PATH" ]; then
    SPOOLMAN_URL=$(jq -r '.spoolman_url // ""' "$CONFIG_PATH")
    if [ -n "$SPOOLMAN_URL" ] && [ "$SPOOLMAN_URL" != "null" ]; then
        export SPOOLMAN_URL
        echo "Spoolman URL configured: $SPOOLMAN_URL"
    fi

    BAMBU_BRIDGE_URL=$(jq -r '.bambu_bridge_url // ""' "$CONFIG_PATH")
    if [ -n "$BAMBU_BRIDGE_URL" ] && [ "$BAMBU_BRIDGE_URL" != "null" ]; then
        export BAMBU_BRIDGE_URL
        echo "Bambu bridge configured: $BAMBU_BRIDGE_URL"
    fi

    BAMBU_BRIDGE_TOKEN=$(jq -r '.bambu_bridge_token // ""' "$CONFIG_PATH")

    if [ -n "$BAMBU_BRIDGE_TOKEN" ] && [ "$BAMBU_BRIDGE_TOKEN" != "null" ]; then
        export BAMBU_BRIDGE_TOKEN
        echo "Bambu bridge authentication configured"
    fi

    CONFIGURED_PORT=$(jq -r '.port // 3000' "$CONFIG_PATH")
    if [ -n "$CONFIGURED_PORT" ] && [ "$CONFIGURED_PORT" != "null" ]; then
        DIRECT_PORT="$CONFIGURED_PORT"
    fi
fi

export DIRECT_ACCESS_PORT="$DIRECT_PORT"
echo "Direct access port: $DIRECT_PORT"

# Read the ingress port assigned by Supervisor (dynamic, avoids conflicts with other add-ons)
INGRESS_PORT=$(curl -s -X GET "http://supervisor/addons/self/info" \
  -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" | jq -r '.data.ingress_port // 8099')
echo "Ingress port: $INGRESS_PORT"

# Derive internal Next.js port from direct port (+1) to avoid conflicts on host_network
INTERNAL_PORT=$((DIRECT_PORT + 1))
# Avoid colliding with the ingress port
if [ "$INTERNAL_PORT" -eq "$INGRESS_PORT" ]; then
    INTERNAL_PORT=$((INTERNAL_PORT + 1))
fi
export PORT="$INTERNAL_PORT"
echo "Internal Next.js port: $INTERNAL_PORT"

# Update nginx config with the configured ports
sed -i "s/listen 3000;/listen ${DIRECT_PORT};/" /etc/nginx/http.d/default.conf
sed -i "s/listen 8099;/listen ${INGRESS_PORT};/" /etc/nginx/http.d/default.conf
sed -i "s/127.0.0.1:3001/127.0.0.1:${INTERNAL_PORT}/g" /etc/nginx/http.d/default.conf

# Supervisor token is automatically available
if [ -n "$SUPERVISOR_TOKEN" ]; then
    echo "Supervisor token available for HA API access"
else
    echo "Warning: SUPERVISOR_TOKEN not set"
fi

# Run Prisma migrations
echo "Running database migrations..."
cd /app
npx prisma migrate deploy 2>&1 || {
    echo "Migration retry..."
    npx prisma migrate deploy 2>&1 || echo "Migration error (non-fatal, continuing...)"
}
echo "Migrations complete."

# Start nginx in background
# nginx serves the configured direct access port and the Supervisor-assigned ingress port
# Both proxy to the internal Next.js server
echo "Starting nginx on ports ${DIRECT_PORT} (direct) and ${INGRESS_PORT} (ingress)..."
nginx -g 'daemon off;' &

# Start the Next.js server on internal port
# Bound to 127.0.0.1 - only accessible via nginx, not directly from outside
echo "Starting Next.js server on port ${PORT}..."
exec node server.js

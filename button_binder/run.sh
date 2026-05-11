#!/usr/bin/with-contenv sh

set -e

cd /app
exec node src/server.js

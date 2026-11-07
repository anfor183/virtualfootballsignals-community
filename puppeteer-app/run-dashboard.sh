#!/usr/bin/env bash
# NexusPanel Dashboard Launcher for Linux
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR/dashboard"

# Clear any zombie instances if port 3081 is stuck
fuser -k 3081/tcp 2>/dev/null || true

export ELECTRON_DISABLE_SANDBOX=1
npm run dev

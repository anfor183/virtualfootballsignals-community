#!/usr/bin/env bash
# NexusPanel Bot Dashboard Web Bridge Launcher
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR/dashboard"

# Clear any zombie process on port 5173/5174 if stuck
fuser -k 5173/tcp 2>/dev/null || true
fuser -k 5174/tcp 2>/dev/null || true

# Validate if an X display is actually responding
valid_display() {
    [ -n "$1" ] && xdpyinfo -display "$1" >/dev/null 2>&1
}

# Clean stale X lock/socket if the owning process is dead
cleanup_stale_display() {
    local disp_num="$1"
    local lock="/tmp/.X${disp_num}-lock"
    local sock="/tmp/.X11-unix/X${disp_num}"
    if [ -f "$lock" ]; then
        local lpid
        lpid=$(cat "$lock" 2>/dev/null | tr -d ' ')
        if [ -n "$lpid" ] && ! kill -0 "$lpid" 2>/dev/null; then
            rm -f "$lock" "$sock"
        fi
    fi
    if [ ! -f "$lock" ] && [ -e "$sock" ]; then
        rm -f "$sock"
    fi
}

# Resolve active X display or start a virtual Xvfb display
if ! valid_display "${DISPLAY:-}"; then
    if valid_display ":10.0"; then
        export DISPLAY=":10.0"
    elif valid_display ":10"; then
        export DISPLAY=":10"
    elif valid_display ":0"; then
        export DISPLAY=":0"
    elif valid_display ":99"; then
        export DISPLAY=":99"
    else
        # Find a clean display number for Xvfb
        XVFB_DISP=""
        for d in 99 98 97 96 95; do
            cleanup_stale_display "$d"
            if [ ! -f "/tmp/.X${d}-lock" ] && [ ! -e "/tmp/.X11-unix/X${d}" ]; then
                XVFB_DISP=":$d"
                break
            fi
        done

        if [ -n "$XVFB_DISP" ]; then
            echo "Starting Xvfb on $XVFB_DISP..."
            Xvfb "$XVFB_DISP" -screen 0 1920x1080x24 -ac +extension RANDR >/dev/null 2>&1 &
            for i in {1..30}; do
                if valid_display "$XVFB_DISP"; then
                    break
                fi
                sleep 0.1
            done
            export DISPLAY="$XVFB_DISP"
        fi
    fi
fi

echo "NexusPanel Bot Dashboard running on DISPLAY=${DISPLAY}"

export ELECTRON_DISABLE_SANDBOX=1

exec node_modules/electron/dist/electron . --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage

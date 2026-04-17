#!/bin/bash
# Patch supercolliderjs boot timeout from 3s to 30s
# The library hardcodes a 3000ms timeout for scsynth startup,
# which is too short when audio device initialization takes longer.

SERVER_JS="node_modules/@supercollider/server/lib/server.js"

if [ ! -f "$SERVER_JS" ]; then
  echo "⏭️  supercolliderjs not installed yet, skipping patch"
  exit 0
fi

# Check if already patched
if grep -q "30000ms" "$SERVER_JS"; then
  echo "✅ supercolliderjs already patched"
  exit 0
fi

# Patch timeout: 3000ms -> 30000ms
# `sed -i.bak` is portable across BSD sed (macOS) and GNU sed (Linux).
if sed -i.bak 's/Server failed to start in 3000ms/Server failed to start in 30000ms/; s/}, 3000);/}, 30000);/' "$SERVER_JS"; then
  rm -f "$SERVER_JS.bak"
  echo "✅ supercolliderjs patched: boot timeout 3s -> 30s"
else
  echo "⚠️  Failed to patch supercolliderjs"
  exit 1
fi

#!/usr/bin/env bash
# Builds the Doom engine to Wasm and inlines it as apps/doom.html.assets/engine.js, one script
# the sandboxed app frame can load without the network.
#
# The engine is doomgeneric at the commit below, plus engine/doomgeneric_realm.c, the platform
# layer that hands frames to the page, takes keys from it and reports the game's stats.
#
# Needs git and Emscripten (emcc on the PATH).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="https://github.com/ozkl/doomgeneric.git"
COMMIT="dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284"
SRC="$HERE/vendor/doomgeneric"

if [ ! -d "$SRC/.git" ]; then
  git clone --quiet "$REPO" "$SRC"
fi
git -C "$SRC" checkout --quiet "$COMMIT"
cp "$HERE/engine/doomgeneric_realm.c" "$SRC/doomgeneric/doomgeneric_realm.c"

(cd "$SRC/doomgeneric" && emcc -O2 -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -w $(cat "$HERE/engine/srcs.txt") \
  -o "$HERE/apps/doom.html.assets/engine.js" \
  -s MODULARIZE=1 -s EXPORT_NAME=createDoom -s SINGLE_FILE=1 -s SINGLE_FILE_BINARY_ENCODE=0 \
  -s ENVIRONMENT=web -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=67108864 -s INVOKE_RUN=0 -s EXIT_RUNTIME=0 \
  -s "EXPORTED_FUNCTIONS=['_main','_dg_push_key','_dg_stats']" \
  -s "EXPORTED_RUNTIME_METHODS=['FS','callMain','HEAPU8']")
echo "engine.js: $(wc -c < "$HERE/apps/doom.html.assets/engine.js") bytes"

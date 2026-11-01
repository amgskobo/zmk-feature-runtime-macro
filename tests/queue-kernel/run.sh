#!/usr/bin/env bash
set -euo pipefail
test_dir="$(cd "$(dirname "$0")" && pwd)"
output="${RUNTIME_MACRO_KERNEL_OUTPUT:?set a fresh output path}"
if [ -e "$output" ]; then echo "output already exists: $output" >&2; exit 2; fi
mkdir -p "$output/workspace/.west"
printf '[manifest]\npath = zephyr\n' >"$output/workspace/.west/config"
ln -s "${ZEPHYR_BASE:?resolved Zephyr required}" "$output/workspace/zephyr"
python3 "$test_dir/generate.py" "$output/queue-generated.c"
(cd "$output/workspace" && west build -b native_sim/native/64 -s "$test_dir" \
    -d "$output/build" -- -DWEST=OFF -DZMK_ROOT="${ZMK_ROOT:?resolved DYA required}" \
    -DZephyr_DIR="$ZEPHYR_BASE/share/zephyr-package/cmake" \
    -DQUEUE_GENERATED="$output/queue-generated.c") >"$output/build.log" 2>&1
failed=0
for taps in 32 33 64; do
    if REVIEW_TAPS="$taps" "$output/build/zephyr/zephyr.exe" >"$output/taps-$taps.log" 2>&1; then
        code=0
    else
        code=$?
        failed=1
    fi
    printf '%s %s\n' "$taps" "$code" >>"$output/status.tsv"
    cat "$output/taps-$taps.log"
done
exit "$failed"

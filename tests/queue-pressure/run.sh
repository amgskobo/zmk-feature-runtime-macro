#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
set -euo pipefail

if [[ -n ${RUNTIME_MACRO_PRESSURE_OUTPUT:-} && ( -e "$RUNTIME_MACRO_PRESSURE_OUTPUT" || -L "$RUNTIME_MACRO_PRESSURE_OUTPUT" ) ]]; then
    echo "Use a fresh RUNTIME_MACRO_PRESSURE_OUTPUT directory; existing evidence is preserved" >&2
    exit 2
fi
workspace="$(cd "${1:?pass a resolved west workspace}" && pwd)"
root="$(cd "$(dirname "$0")/../.." && pwd)"
zmk_source="$(cd "$workspace" && west list zmk -f '{abspath}')"
output="${RUNTIME_MACRO_PRESSURE_OUTPUT:-$(mktemp -d -t runtime-macro-pressure.XXXXXXXX)}"
mkdir -p "$output"
build="$(mktemp -d)"
trap 'rm -rf -- "$build"' EXIT HUP INT TERM
cd "$workspace"
west build -p=always -o=-j1 -s "$zmk_source/app" -d "$build" \
  -b native_sim//zmk_test_mock -- -DCONFIG_ASSERT=y \
  -DKEYMAP_FILE="$root/tests/queue-pressure/config/pressure.keymap" \
  -DZMK_CONFIG="$root/tests/queue-pressure/config" \
  -DZMK_EXTRA_MODULES="$root;$root/tests/queue-pressure/module" >"$output/build.log" 2>&1
cp "$build/CMakeCache.txt" "$build/zephyr/.config" "$build/zephyr/zephyr.dts" \
   "$build/zephyr/zmk.exe" "$build/zephyr/zmk.elf" "$output/"
failed=0
for scenario in taps held delete; do
  for run in 1 2 3; do
    status=0
    RUNTIME_MACRO_PRESSURE_CASE="$scenario" timeout 10 "$build/zephyr/zmk.exe" \
      >"$output/$scenario-$run.log" 2>&1 || status=$?
    cat "$output/$scenario-$run.log"
    if [ "$status" != 0 ] || ! grep -Fq "PASS runtime macro queue pressure scenario=$scenario" "$output/$scenario-$run.log"; then failed=1; fi
  done
done
exit "$failed"

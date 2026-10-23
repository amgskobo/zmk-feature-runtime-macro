#!/usr/bin/env python3
"""The runtime macro Studio RPC handler with real nanopb messages."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--source",
    type=Path,
    default=root / "src/studio/runtime_macro_handler.c",
    help="override the handler source for regression reproduction",
)
args = parser.parse_args()
nanopb = (
    Path(os.environ["NANOPB_SOURCE"])
    if "NANOPB_SOURCE" in os.environ
    else Path(
        subprocess.check_output(
            ["west", "list", "nanopb", "-f", "{abspath}"], text=True
        ).strip()
    )
)

with tempfile.TemporaryDirectory(prefix="runtime-macro-rpc-handler-") as folder:
    work = Path(folder)
    # The generator may regenerate its own Python proto; keep the checkout read-only.
    shutil.copytree(nanopb / "generator", work / "generator")
    subprocess.run(
        [
            "python3",
            str(work / "generator/nanopb_generator.py"),
            "-I",
            str(root / "proto"),
            "-D",
            str(work),
            str(root / "proto/cormoran/runtime_macro/runtime_macro.proto"),
        ],
        check=True,
        timeout=60,
    )
    for rel in (
        "zephyr/device.h",
        "zephyr/logging/log.h",
        "zephyr/sys/util.h",
        "zmk/behavior.h",
        "zmk/studio/core.h",
        "zmk/studio/custom.h",
        "cormoran/zmk/custom_settings.h",
    ):
        path = work / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("/* Controlled framework API; see handler_test.c. */\n")

    def compile_handler(binary, label, flags, count=8, name_max=24):
        return subprocess.run(
            [
                "cc",
                "-std=c11",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-Wno-unused-parameter",
                "-Wno-unused-function",
                *flags,
                f"-DCONFIG_ZMK_RUNTIME_MACRO_COUNT={count}",
                f"-DCONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN={name_max}",
                "-DCONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES=256",
                f'-DHANDLER_SOURCE="{args.source.resolve()}"',
                f'-DTEST_VARIANT="{label}"',
                "-I" + str(work),
                "-I" + str(nanopb),
                "-I" + str(root / "include"),
                str(root / "tests/rpc-handler/handler_test.c"),
                str(work / "cormoran/runtime_macro/runtime_macro.pb.c"),
                *(
                    str(nanopb / f"pb_{part}.c")
                    for part in ("common", "encode", "decode")
                ),
                "-o",
                str(binary),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

    variants = {
        "optimized": ["-O2"],
        "sanitized": [
            "-O1",
            "-g",
            "-fsanitize=address,undefined",
            "-fno-sanitize-recover=all",
        ],
    }
    for label, flags in variants.items():
        binary = work / f"rpc-handler-{label}"
        built = compile_handler(binary, label, flags)
        if built.returncode:
            raise SystemExit(built.stdout + built.stderr)
        subprocess.run(
            [str(binary)],
            check=True,
            timeout=20,
            env={**os.environ, "ASAN_OPTIONS": "detect_leaks=0"},
        )

    # Limits the RPC messages cannot carry must not build.
    for what, overrides, message in (
        ("17 slots", {"count": 17}, "ListMacrosResponse capacity"),
        ("32-byte names", {"name_max": 32}, "RPC name capacity"),
    ):
        rejected = compile_handler(
            work / "rpc-handler-oversized", "oversized", ["-O0"], **overrides
        )
        if rejected.returncode == 0 or message not in rejected.stderr:
            raise SystemExit(f"{what} built against the RPC message limits")
    print(
        "runtime macro RPC capacity: PASS (17 slots and 32-byte names rejected at build time)"
    )

#!/usr/bin/env python3
"""The runtime macro Studio RPC handler with real nanopb messages."""

import argparse
from contextlib import nullcontext
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from list_wire import load_protocol, verify_vectors

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--source",
    type=Path,
    default=root / "src/studio/runtime_macro_handler.c",
    help="override the handler source for regression reproduction",
)
parser.add_argument(
    "--output",
    type=Path,
    help="retain inputs, binaries, commands and logs in a fresh absolute directory",
)
parser.add_argument(
    "--variant",
    choices=(
        "all",
        "optimized",
        "sanitized",
        "large-body",
        "max-name",
        "oversize",
        "list-wire",
    ),
    default="all",
    help="focus on one variant; only all is the complete canonical handler matrix",
)
args = parser.parse_args()
if args.output is not None:
    if (
        not args.output.is_absolute()
        or args.output.exists()
        or args.output.is_symlink()
    ):
        parser.error("output must be a fresh absolute directory")
    selected_output = args.output.resolve()
    source_roots = [root.resolve()]
    source = args.source.resolve()
    if source.parent.name == "studio" and source.parent.parent.name == "src":
        source_roots.append(source.parents[2])
    if any(selected_output.is_relative_to(source_root) for source_root in source_roots):
        parser.error("output must be outside owner source trees")
    selected_output.mkdir(parents=True, exist_ok=False)
    storage = nullcontext(selected_output)
else:
    storage = tempfile.TemporaryDirectory(prefix="runtime-macro-rpc-handler-")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


with storage as folder:
    work = Path(folder)
    results = {
        "schema": 1,
        "scope": "canonical" if args.variant == "all" else "focused",
        "variant": args.variant,
        "handler_source": str(args.source.resolve()),
        "retained": args.output is not None,
        "status": "RUNNING",
        "operations": [],
        "binaries": {},
        "inputs": {},
    }

    def save_results():
        (work / "results.json").write_text(json.dumps(results, indent=2) + "\n")

    def retain_input(label, path):
        path = path.resolve()
        record = {"path": str(path), "sha256": digest(path)}
        if args.output is not None:
            destination = work / "inputs" / label
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            record["copy"] = str(destination.relative_to(work))
        results["inputs"][label] = record

    def invoke(name, command, *, capture=False, **kwargs):
        operation = {
            "name": name,
            "command": command,
            "cwd": str(Path(kwargs.get("cwd", Path.cwd())).resolve()),
            "start_unix_ns": time.time_ns(),
            "explicit_environment": {
                key: kwargs["env"][key]
                for key in ("ASAN_OPTIONS", "UBSAN_OPTIONS", "LSAN_OPTIONS")
                if key in kwargs.get("env", {})
            },
        }
        results["operations"].append(operation)
        save_results()
        start = time.monotonic_ns()
        try:
            if capture:
                result = subprocess.run(
                    command, capture_output=True, text=True, **kwargs
                )
                (work / f"{name}.stdout").write_text(result.stdout)
                (work / f"{name}.stderr").write_text(result.stderr)
                operation.update(stdout=f"{name}.stdout", stderr=f"{name}.stderr")
            elif args.output is not None:
                operation["log"] = f"{name}.log"
                with (work / operation["log"]).open("x") as log:
                    result = subprocess.run(
                        command, stdout=log, stderr=subprocess.STDOUT, **kwargs
                    )
            else:
                result = subprocess.run(command, **kwargs)
            operation["exit"] = result.returncode
            return result
        except subprocess.CalledProcessError as error:
            operation["exit"] = error.returncode
            if capture:
                for stream in ("stdout", "stderr"):
                    (work / f"{name}.{stream}").write_text(getattr(error, stream) or "")
                    operation[stream] = f"{name}.{stream}"
            raise
        except subprocess.TimeoutExpired as error:
            operation.update(exit=None, timed_out=True)
            if capture:
                for stream in ("stdout", "stderr"):
                    content = getattr(error, stream) or b""
                    if isinstance(content, bytes):
                        content = content.decode(errors="replace")
                    (work / f"{name}.{stream}").write_text(content)
                    operation[stream] = f"{name}.{stream}"
            raise
        except OSError as error:
            operation["error"] = {"type": type(error).__name__, "message": str(error)}
            raise
        finally:
            operation["elapsed_ns"] = time.monotonic_ns() - start
            if operation.get("log"):
                sys.stdout.write((work / operation["log"]).read_text(errors="replace"))
                sys.stdout.flush()
            save_results()

    def execute(binary, label, *, env=None):
        results["binaries"][label] = {
            "path": str(binary),
            "sha256": digest(binary),
            "runs": 1,
        }
        save_results()
        kwargs = {} if env is None else {"env": env}
        if args.output is not None:
            initial_state = work / f"{label}-run-1"
            initial_state.mkdir()
            kwargs["cwd"] = initial_state
        try:
            result = invoke(
                f"run-{label}",
                [str(binary)],
                capture=args.output is None,
                check=True,
                timeout=20,
                **kwargs,
            )
        except subprocess.CalledProcessError as error:
            if args.output is None:
                sys.stdout.write(error.stdout or "")
                sys.stderr.write(error.stderr or "")
            raise
        if args.output is not None:
            return (work / f"run-{label}.log").read_text()
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.stdout

    def run():
        if args.variant != "all":
            print(
                f"FOCUSED RPC handler variant={args.variant}; canonical full matrix NOT RUN",
                flush=True,
            )
        retain_input("handler.c", args.source)
        retain_input("runner.py", Path(__file__))
        retain_input("handler_test.c", root / "tests/rpc-handler/handler_test.c")
        retain_input(
            "runtime_macro_codec.h",
            args.source.resolve().parent.parent / "runtime_macro_codec.h",
        )
        for path in sorted((root / "include").rglob("*.h")):
            retain_input("owner/" + str(path.relative_to(root)), path)
        for path in sorted((root / "proto").rglob("*")):
            if path.is_file():
                retain_input("owner/" + str(path.relative_to(root)), path)
        nanopb = (
            Path(os.environ["NANOPB_SOURCE"])
            if "NANOPB_SOURCE" in os.environ
            else Path(
                invoke(
                    "nanopb-discovery",
                    ["west", "list", "nanopb", "-f", "{abspath}"],
                    capture=True,
                    check=True,
                ).stdout.strip()
            )
        ).resolve()
        results["nanopb_source"] = str(nanopb)
        for path in sorted((*nanopb.glob("*.h"), *nanopb.glob("pb_*.c"))):
            retain_input("nanopb/" + path.name, path)
        run_matrix(nanopb)

    def run_matrix(nanopb):
        # The generator may regenerate its own Python proto; keep the checkout read-only.
        shutil.copytree(nanopb / "generator", work / "generator")
        invoke(
            "generate",
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
        protocol = load_protocol(work, root)
        generated_profiles = {}

        def generated_profile(count, name_max):
            template = root / "proto/cormoran/runtime_macro/runtime_macro.options.in"
            if not template.exists():
                return work
            # Invalid compiler controls still use an in-protocol layout, then
            # require the real handler's named count/name refusal.
            key = (min(count, 16), min(name_max, 32))
            if key in generated_profiles:
                return generated_profiles[key]
            destination = work / f"generated-{key[0]}-{key[1]}"
            destination.mkdir()
            text = template.read_text().replace(
                "@RUNTIME_MACRO_NANOPB_OPTIONS@",
                template.with_suffix("").read_text(),
            )
            text = text.replace("@CONFIG_ZMK_RUNTIME_MACRO_COUNT@", str(key[0]))
            text = text.replace("@CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN@", str(key[1]))
            if "@" in text:
                raise AssertionError("Unresolved Macro options template")
            options = destination / "runtime_macro.options"
            options.write_text(text)
            invoke(
                f"generate-{key[0]}-{key[1]}",
                [
                    "python3",
                    str(work / "generator/nanopb_generator.py"),
                    "-I",
                    str(root / "proto"),
                    "-f",
                    str(options),
                    "-D",
                    str(destination),
                    str(root / "proto/cormoran/runtime_macro/runtime_macro.proto"),
                ],
                check=True,
                timeout=60,
            )
            generated_profiles[key] = destination
            return destination

        def compile_handler(
            binary,
            label,
            flags,
            count=8,
            name_max=24,
            macro_bytes=256,
            record=None,
            standalone=False,
        ):
            generated = work if standalone else generated_profile(count, name_max)
            result = invoke(
                "compile-" + (record or label),
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
                    f"-DCONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES={macro_bytes}",
                    f'-DHANDLER_SOURCE="{args.source.resolve()}"',
                    f'-DTEST_VARIANT="{label}"',
                    "-I" + str(generated),
                    "-I" + str(work),
                    "-I" + str(nanopb),
                    "-I" + str(root / "include"),
                    str(root / "tests/rpc-handler/handler_test.c"),
                    str(generated / "cormoran/runtime_macro/runtime_macro.pb.c"),
                    *(
                        str(nanopb / f"pb_{part}.c")
                        for part in ("common", "encode", "decode")
                    ),
                    "-o",
                    str(binary),
                ],
                capture=True,
                timeout=60,
            )
            if result.returncode == 0:
                results["binaries"][record or label] = {
                    "path": str(binary),
                    "sha256": digest(binary),
                }
                (work / f"{binary.name}.sha256").write_text(
                    f"{digest(binary)}  {binary.name}\n"
                )
                save_results()
            return result

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
            if args.variant not in ("all", label):
                continue
            binary = work / f"rpc-handler-{label}"
            built = compile_handler(binary, label, flags)
            if built.returncode:
                raise SystemExit(built.stdout + built.stderr)
            log = execute(
                binary, label, env={**os.environ, "ASAN_OPTIONS": "detect_leaks=0"}
            )
            verify_vectors(log, protocol, 8, 24, 256)

        # A supported larger body must not move its staging onto the 4 KiB RPC
        # stack. The original pair of automatic 2048-byte arrays fails this guard.
        if args.variant in ("all", "large-body"):
            large = work / "rpc-handler-large-body"
            built = compile_handler(
                large,
                "large-body",
                ["-O2", "-Wframe-larger-than=2048"],
                macro_bytes=2048,
            )
            if built.returncode:
                raise SystemExit(built.stdout + built.stderr)
            log = execute(large, "large-body")
            verify_vectors(log, protocol, 8, 24, 2048)

        if args.variant in ("all", "list-wire"):
            for count in (8, 16):
                for name_max in (24, 32):
                    for label, flags in variants.items():
                        profile = f"list-{count}-{name_max}-{label}"
                        binary = work / profile
                        built = compile_handler(
                            binary,
                            profile,
                            flags,
                            count=count,
                            name_max=name_max,
                            record=profile,
                        )
                        if built.returncode:
                            raise SystemExit(built.stdout + built.stderr)
                        log = execute(
                            binary,
                            profile,
                            env={
                                **os.environ,
                                "ASAN_OPTIONS": "detect_leaks=0",
                                "MACRO_RPC_LIST_ONLY": "1",
                            },
                        )
                        verify_vectors(log, protocol, count, name_max, 256)
            print("runtime macro list profiles: PASS profiles=4 variants=2 vectors=32")
            binary = work / "list-standalone"
            built = compile_handler(
                binary,
                "list-standalone",
                ["-O2"],
                count=16,
                name_max=32,
                record="list-standalone",
                standalone=True,
            )
            if built.returncode:
                raise SystemExit(built.stdout + built.stderr)
            log = execute(
                binary,
                "list-standalone",
                env={**os.environ, "MACRO_RPC_LIST_ONLY": "1"},
            )
            verify_vectors(log, protocol, 16, 32, 256)
            print("runtime macro standalone list: PASS count=16 name=32 vectors=4")

        # The documented 32 content bytes plus NUL must fit; 33 content bytes
        # remain outside the wire capacity. Preserve slot-capacity rejection.
        if args.variant in ("all", "max-name"):
            accepted = compile_handler(
                work / "rpc-handler-max-name", "max-name", ["-O2"], name_max=32
            )
            if accepted.returncode:
                raise SystemExit(accepted.stdout + accepted.stderr)
        # This is a compile-capacity control. The runtime fixture below encodes a
        # configured-limit+1 name and requires that value to fit the wire field;
        # the 32-byte wire limit itself is exercised by tests/review/test_name_wire.py.
        if args.variant in ("all", "oversize"):
            for what, overrides, message in (
                ("17 slots", {"count": 17}, "ListMacrosResponse capacity"),
                ("33-byte names", {"name_max": 33}, "RPC name capacity"),
            ):
                rejected = compile_handler(
                    work / "rpc-handler-oversized",
                    "oversized",
                    ["-O0"],
                    **overrides,
                    record="oversized-"
                    + ("slots" if "count" in overrides else "names"),
                )
                if rejected.returncode == 0 or message not in rejected.stderr:
                    raise SystemExit(f"{what} built against the RPC message limits")
        if args.variant == "all":
            print(
                "runtime macro RPC capacity: PASS (32-byte names accepted; 17 slots and 33-byte names rejected)"
            )
        else:
            print(
                f"runtime macro RPC focused: PASS variant={args.variant}; canonical full matrix NOT RUN"
            )

    save_results()
    try:
        run()
    except BaseException as error:
        results.update(
            status="FAIL", failure={"type": type(error).__name__, "message": str(error)}
        )
        raise
    else:
        results["status"] = "PASS"
    finally:
        results["input_drift"] = [
            label
            for label, item in results["inputs"].items()
            if not Path(item["path"]).is_file()
            or digest(Path(item["path"])) != item["sha256"]
        ]
        if results["input_drift"]:
            results["status"] = "FAIL"
            results.setdefault(
                "failure",
                {
                    "type": "SourceDrift",
                    "message": "RPC handler source inputs changed during execution",
                },
            )
        save_results()
        if args.output is not None:
            print(f"RPC handler evidence retained: {work}", flush=True)
        if results["input_drift"] and results["failure"]["type"] == "SourceDrift":
            raise SystemExit("RPC handler source inputs changed during execution")

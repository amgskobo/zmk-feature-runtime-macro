#!/usr/bin/env python3
"""Actual owner CMake, ARM list capacities and automatic option refresh."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def main():
    sys.path.insert(0, str(ROOT / "tests/rpc-handler"))
    from list_wire import verify_response_storage

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--fault", choices=("missing-base-dependency", "fixed-capacity")
    )
    args = parser.parse_args()
    if (
        not args.output.is_absolute()
        or args.output.exists()
        or args.output.is_symlink()
    ):
        parser.error("Use a fresh absolute output directory")
    out = args.output.resolve()
    if out.is_relative_to(ROOT.resolve()):
        parser.error("output must be outside the owner source tree")
    out.mkdir(parents=True)
    commands, profiles = [], []

    def run(name, argv):
        argv = [str(value) for value in argv]
        result = subprocess.run(
            argv, cwd=ROOT, capture_output=True, text=True, timeout=120
        )
        (out / (name + ".stdout")).write_text(result.stdout)
        (out / (name + ".stderr")).write_text(result.stderr)
        commands.append(
            {"argv": argv, "cwd": str(ROOT), "exit": result.returncode, "name": name}
        )
        (out / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        if result.returncode:
            raise RuntimeError(f"{name} failed; see {out}")
        return result.stdout

    names = [
        os.fsdecode(n)
        for n in subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT,
        ).split(b"\0")
        if n
    ]

    def digest(p):
        return hashlib.sha256(
            os.fsencode(os.readlink(p)) if p.is_symlink() else p.read_bytes()
        ).hexdigest()

    source = {name: digest(ROOT / name) for name in names}
    (out / "source-inputs.json").write_text(json.dumps(source, indent=2) + "\n")
    target = out / "input"
    target.mkdir()
    for name in names:
        src, dst = ROOT / name, target / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_symlink():
            dst.symlink_to(os.readlink(src))
        else:
            shutil.copy2(src, dst)
    cmake = target / "CMakeLists.txt"
    template = target / "proto/cormoran/runtime_macro/runtime_macro.options.in"
    base = template.with_suffix("")
    if args.fault == "missing-base-dependency":
        text = cmake.read_text()
        original = "set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS\n                     ${RUNTIME_MACRO_NANOPB_OPTIONS_FILE})"
        assert text.count(original) == 1
        cmake.write_text(text.replace(original, ""))
    elif args.fault == "fixed-capacity":
        text = template.read_text()
        assert text.count("@CONFIG_ZMK_RUNTIME_MACRO_COUNT@") == 1
        template.write_text(text.replace("@CONFIG_ZMK_RUNTIME_MACRO_COUNT@", "16"))
    zephyr = run("zephyr", ["west", "list", "zephyr", "-f", "{abspath}"]).strip()
    nanopb = run("nanopb", ["west", "list", "nanopb", "-f", "{abspath}"]).strip()
    compiler, nm = (
        shutil.which("arm-zephyr-eabi-gcc"),
        shutil.which("arm-zephyr-eabi-nm"),
    )
    if not compiler or not nm:
        raise RuntimeError(
            "Selected ARM compiler/nm required in the prepared environment"
        )
    build = out / "build"
    common = [
        "cmake",
        "-S",
        ROOT / "tests/proto-layout",
        "-B",
        build,
        "-G",
        "Ninja",
        "-DOWNER_INPUT=" + str(target),
        "-DSELECTED_ZEPHYR=" + zephyr,
        "-DSELECTED_NANOPB=" + nanopb,
        "-DCMAKE_SYSTEM_NAME=Generic",
        "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
        "-DCMAKE_C_COMPILER=" + compiler,
        "-DCMAKE_C_FLAGS=-mcpu=cortex-m4 -mthumb",
    ]

    def inspect(count, name_max, label):
        run(
            "build-" + label,
            ["cmake", "--build", build, "--target", "layout_witness", "-j", "1"],
        )
        objects = [
            p
            for p in build.glob("CMakeFiles/layout_witness.dir/layout.c.*")
            if p.suffix in (".o", ".obj")
        ]
        assert len(objects) == 1, "Missing/duplicate compiled ARM type witness"
        output = run("symbols-" + label, [nm, "-S", "--size-sort", objects[0]])
        sizes = {
            line.split()[-1]: int(line.split()[1], 16) for line in output.splitlines()
        }
        verify_response_storage(
            sizes["response_type"], count, name_max, sizes["response_align"]
        )
        assert sizes["response_align"] == 4, "Unexpected selected ARM response ABI"
        assert sizes["summary_slot"] == 1 and sizes["summary_name"] == name_max + 1
        for name in [
            "encoded_size_word",
            "request_slot",
            "detail_slot",
            "binding_param1",
            "binding_param2",
            "delay_word",
        ]:
            assert sizes[name] == 4, "Full-width protocol field narrowed: " + name
        assert sizes["request_name"] == 33 and sizes["detail_name"] == 33
        profiles.append(
            {"count": count, "name_max": name_max, "stage": label, "symbols": sizes}
        )

    run(
        "configure-8-24",
        [
            *common,
            "-DCONFIG_ZMK_RUNTIME_MACRO_COUNT=8",
            "-DCONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN=24",
        ],
    )
    inspect(8, 24, "8-24")
    generated = build / "owner/proto/cormoran/runtime_macro/runtime_macro.options"
    for kind, path in [("base", base), ("template", template)]:
        marker = f"# {kind} dependency refresh sentinel"
        path.write_text(path.read_text() + "\n" + marker + "\n")
        inspect(8, 24, kind + "-refresh")
        assert marker in generated.read_text(), (
            f"{kind.title()} options dependency did not reconfigure"
        )
    run(
        "configure-16-32",
        [
            *common,
            "-DCONFIG_ZMK_RUNTIME_MACRO_COUNT=16",
            "-DCONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN=32",
        ],
    )
    inspect(16, 32, "16-32")
    assert all(digest(ROOT / name) == source[name] for name in names), (
        "Owner source drift"
    )
    (out / "result.json").write_text(
        json.dumps(
            {
                "status": "PASS",
                "profiles": profiles,
                "source_stable": True,
                "fault": args.fault,
                "scope": "Actual owner CMake/generated ARM protocol objects; not firmware/application execution",
            },
            indent=2,
        )
        + "\n"
    )
    print("runtime macro protocol layout: PASS profiles=2 refreshes=2")


if __name__ == "__main__":
    main()

"""Bind the frozen macro response's linked RAM to actual ARM owner inputs."""

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def input_allocation(text):
    regions = [
        (int(a, 16), int(a, 16) + int(b, 16))
        for a, b in re.findall(
            r"^\s*(?:RAM|SRAM)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+\S+\s*$",
            text,
            re.M,
        )
    ]
    if not regions:
        raise AssertionError("Missing linked RAM region")
    section = ".bss.zmk_rpc_custom_subsystem_response_buffer_cormoran__runtime_macro"
    rows, pending = [], False
    for line in text.splitlines():
        single = re.match(
            r"^\s+(\.\S+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(.+)$", line
        )
        wrapped = re.match(r"^\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(.+)$", line)
        if single:
            name, address, size, owner = single.groups()
            selected = name == section
        elif pending and wrapped:
            address, size, owner = wrapped.groups()
            selected = True
        else:
            pending = line.strip() == section
            continue
        pending = False
        address, size = int(address, 16), int(size, 16)
        if (
            not selected
            or not address
            or not size
            or not owner.endswith("(runtime_macro_handler.c.obj)")
        ):
            continue
        if not any(a <= address and address + size <= b for a, b in regions):
            raise AssertionError("Allocation is outside linked RAM")
        rows.append({"address": address, "bytes": size})
    if len(rows) > 1:
        raise AssertionError("Duplicate owner response allocation")
    return rows[0] if rows else None


def verify_artifact(artifact, owner):
    artifact, owner = Path(artifact), Path(owner).resolve()
    sys.path.insert(0, str(owner / "tests/rpc-handler"))
    from list_wire import verify_response_storage

    config = dict(
        re.findall(
            r"^(CONFIG_\w+)=(.+)$", (artifact / "zephyr/.config").read_text(), re.M
        )
    )
    response = input_allocation((artifact / "zephyr/zmk.map").read_text())
    enabled = config.get("CONFIG_ZMK_RUNTIME_MACRO") == "y"
    rpc = config.get("CONFIG_ZMK_RUNTIME_MACRO_STUDIO_RPC") == "y"
    if rpc:
        assert response is not None, "Missing linked macro response"
        verify_response_storage(
            response["bytes"],
            int(config["CONFIG_ZMK_RUNTIME_MACRO_COUNT"]),
            int(config["CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN"]),
            4,
        )
    else:
        assert response is None, "Disabled macro RPC retains response storage"
    cache = (artifact / "CMakeCache.txt").read_text()
    nm = re.search(r"^CMAKE_NM:FILEPATH=(.+)$", cache, re.M)
    assert nm and Path(nm.group(1)).is_absolute(), "Missing selected ARM nm"
    result = subprocess.run(
        [nm.group(1), "-S", "--defined-only", str(artifact / "zephyr/zmk.elf")],
        capture_output=True,
        text=True,
        check=True,
    )
    (artifact / "macro-memory-symbols.txt").write_text(result.stdout)
    if response:
        name = "zmk_rpc_custom_subsystem_response_buffer_cormoran__runtime_macro"
        symbols = {
            (int(row[0], 16), int(row[1], 16), row[3])
            for line in result.stdout.splitlines()
            if len(row := line.split()) == 4
        }
        assert (response["address"], response["bytes"], name) in symbols, (
            "ELF/map response mismatch"
        )
    commands = json.loads((artifact / "compile_commands.json").read_text())
    sources = {}
    for selected, path in [
        (enabled, "src/runtime_macro.c"),
        (enabled, "src/runtime_macro_dt_defaults.c"),
        (enabled, "src/behaviors/behavior_runtime_macro.c"),
        (rpc, "src/studio/runtime_macro_handler.c"),
    ]:
        rows = [row for row in commands if Path(row["file"]).resolve() == owner / path]
        assert len(rows) == int(selected), (
            "Compiled macro source selection mismatch: " + path
        )
        if selected:
            sources[path] = hashlib.sha256((owner / path).read_bytes()).hexdigest()
    usage = {
        "response": response,
        "source_sha256": sources,
        "elf_sha256": hashlib.sha256(
            (artifact / "zephyr/zmk.elf").read_bytes()
        ).hexdigest(),
        "scope": "This linked ARM response allocation only; not player/pool total or stack/heap peak",
    }
    (artifact / "macro-static-memory.json").write_text(
        json.dumps(usage, indent=2) + "\n"
    )
    return usage

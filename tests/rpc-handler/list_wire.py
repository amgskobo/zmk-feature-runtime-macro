"""Independent protobuf oracle for synthetic macro metadata and read failures."""

import importlib.util
import re
import subprocess


def load_protocol(work, root):
    destination = work / "python-protocol"
    destination.mkdir()
    subprocess.run(
        [
            "protoc",
            "-I" + str(root / "proto"),
            "--python_out=" + str(destination),
            str(root / "proto/cormoran/runtime_macro/runtime_macro.proto"),
        ],
        check=True,
        timeout=60,
    )
    path = destination / "cormoran/runtime_macro/runtime_macro_pb2.py"
    spec = importlib.util.spec_from_file_location("macro_wire_oracle", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expected_response(protocol, count, name_max, macro_bytes, mode):
    response = protocol.Response()
    if mode == "iterator_error":
        response.error.message = "Runtime macro RPC failed: -5"
    else:
        result = response.list_macros
        result.max_macro_bytes = macro_bytes
        result.max_name_length = name_max
        for slot in range(count):
            if mode == "empty" or (mode == "holes" and slot in (1, 3)):
                continue
            summary = result.macros.add()
            summary.slot = slot
            summary.name = "".join(
                chr(ord("A") + (slot + i) % 26) for i in range(name_max)
            )
            summary.encoded_size = 0 if slot == 2 else 0xFFFFFFFF - slot
            summary.has_unsaved_changes = slot % 2 == 1
    return response.SerializeToString(deterministic=True)


def verify_vectors(output, protocol, count, name_max, macro_bytes):
    rows = re.findall(r"^WIRE (\w+) ([0-9a-f]+)$", output, re.M)
    if [name for name, _ in rows] != ["maximum", "holes", "empty", "iterator_error"]:
        raise AssertionError("Missing/duplicate ordered macro list vectors")
    for name, encoded in rows:
        if bytes.fromhex(encoded) != expected_response(
            protocol, count, name_max, macro_bytes, name
        ):
            raise AssertionError(
                f"Macro list wire mismatch: count={count} name={name_max} mode={name}"
            )
    marker = f"runtime macro list wire: PASS count={count} name={name_max} bytes={macro_bytes}"
    if output.count(marker) != 1:
        raise AssertionError("Missing/duplicate macro list completion")
    sizes = re.findall(r"^runtime macro response bytes: (\d+)$", output, re.M)
    if len(sizes) != 1:
        raise AssertionError("Missing/duplicate macro response allocation")
    alignments = re.findall(r"^runtime macro response alignment: (\d+)$", output, re.M)
    if len(alignments) != 1:
        raise AssertionError("Missing/duplicate macro response ABI alignment")
    verify_response_storage(int(sizes[0]), count, name_max, int(alignments[0]))


def verify_response_storage(size, count, name_max, alignment=4):
    # Natural uint32 alignment; no packed/unaligned fields or narrowed sizes.
    aligned_name_end = (1 + name_max + 1 + 3) // 4 * 4
    summary_size = (aligned_name_end + 4 + 1 + 3) // 4 * 4
    if alignment not in (4, 8):
        raise AssertionError(f"Unmeasured Macro response ABI alignment: {alignment}")
    # The existing streamed GetMacro member aligns the response union to a
    # pointer:4 on ARM/native32,8 on native64. Its payload is smaller than Status.
    payload = max(100, 12 + count * summary_size)
    expected = alignment + (payload + alignment - 1) // alignment * alignment
    if size != expected:
        raise AssertionError(
            f"Configured Macro Response RAM: align={alignment} count={count} name={name_max} bytes={size}"
        )

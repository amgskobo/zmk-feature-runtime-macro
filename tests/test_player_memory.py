"""Compile the real private action type against the selected core binding ABI.

These are allocation checks, not firmware execution or stack/heap measurements.
The original separate delay/binding members must fail the named RAM bound on
ARM and native32. Native64 alignment is checked without claiming an ARM saving.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from review.test_playback_regressions import declaration

ROOT = Path(__file__).resolve().parent.parent


class PlayerMemoryContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output = Path(tempfile.mkdtemp(prefix="runtime-macro-player-memory-"))
        cls.source = Path(
            os.environ.get("RUNTIME_MACRO_PLAYER_SOURCE", ROOT / "src/runtime_macro.c")
        ).resolve()
        selected = subprocess.run(
            ["west", "list", "zmk", "-f", "{abspath}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        cls.binding = (
            Path(selected.stdout.strip()).resolve() / "app/include/zmk/behavior.h"
        )
        cls.inputs = {
            str(path): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (cls.source, cls.binding)
        }
        print(f"Player allocation evidence: {cls.output}", flush=True)
        (cls.output / "inputs.json").write_text(json.dumps(cls.inputs, indent=2) + "\n")

    def compile_abi(self, compiler, flags, name):
        selected = shutil.which(compiler)
        self.assertIsNotNone(selected, "Required compiler unavailable: " + compiler)
        for local_ids in (0, 1):
            with self.subTest(abi=name, local_ids=local_ids):
                stem = self.output / f"{name}-local-ids-{local_ids}"
                source = stem.with_suffix(".c")
                source.write_text(
                    "#include <stdbool.h>\n#include <stdint.h>\n"
                    "typedef uint16_t zmk_behavior_local_id_t;\n"
                    f"#define IS_ENABLED(x) {local_ids}\n"
                    + declaration(self.binding, "struct", "zmk_behavior_binding")
                    + declaration(self.source, "struct", "runtime_macro_queue_item")
                    + "_Static_assert(sizeof(struct runtime_macro_queue_item) <= "
                    "sizeof(struct zmk_behavior_binding) + "
                    "_Alignof(struct zmk_behavior_binding), "
                    '"Runtime Macro decoded action RAM");\n'
                    "char runtime_macro_action_size[sizeof(struct runtime_macro_queue_item)];\n"
                    "char runtime_macro_binding_size[sizeof(struct zmk_behavior_binding)];\n"
                )
                command = [
                    selected,
                    *flags,
                    "-std=c11",
                    "-Wall",
                    "-Wextra",
                    "-Werror",
                    "-c",
                    str(source),
                    "-o",
                    str(stem.with_suffix(".o")),
                ]
                result = subprocess.run(command, capture_output=True, text=True)
                (stem.with_suffix(".json")).write_text(
                    json.dumps(
                        {
                            "command": command,
                            "exit": result.returncode,
                            "inputs": self.inputs,
                        },
                        indent=2,
                    )
                    + "\n"
                )
                (stem.with_suffix(".log")).write_text(result.stdout + result.stderr)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                symbols = subprocess.check_output(
                    ["nm", "-S", "--defined-only", str(stem.with_suffix(".o"))],
                    text=True,
                )
                (stem.with_suffix(".symbols")).write_text(symbols)
                print(
                    f"PASS allocation abi={name} local_ids={local_ids}\n{symbols}",
                    flush=True,
                )
        self.assertEqual(
            self.inputs,
            {
                str(path): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in (self.source, self.binding)
            },
            "Allocation inputs changed during compilation",
        )

    def test_arm(self):
        self.compile_abi("arm-zephyr-eabi-gcc", ["-mcpu=cortex-m4", "-mthumb"], "arm")

    def test_native32(self):
        self.compile_abi("cc", ["-m32"], "native32")

    def test_native64(self):
        self.compile_abi("cc", ["-m64"], "native64")


if __name__ == "__main__":
    unittest.main()

import platform
import os
import tempfile
import subprocess
import unittest
from pathlib import Path

from dataclasses import dataclass

from native_verifier import verify_native
from test_native_verifier import NativeVerifierContract as NativeVerifierContract
from test_timeout_width import TimeoutWidth as TimeoutWidth

from test_build_budget import BuildBudgetContract as BuildBudgetContract

THIS_DIR = Path(__file__).resolve().parent.parent


def run_west(args: list[str]) -> subprocess.CompletedProcess[str]:
    if args and args[0] == "zmk-build":
        parallelism = int(os.environ.get("OWNER_TEST_BUILD_PARALLELISM", "1"))
        if parallelism < 1:
            raise ValueError("OWNER_TEST_BUILD_PARALLELISM must be a positive integer")
        args = [args[0], "--parallelism", str(parallelism), *args[1:]]
    return subprocess.run(
        ["west", *args],
        capture_output=True,
        text=True,
        cwd=THIS_DIR,
    )


@dataclass
class NotFound:
    text: str


@dataclass
class ConfigAndDeviceTree:
    # Expected rows in .config
    config: list[str | NotFound]
    # Expected rows in devicetree_generated.h
    device: list[str | NotFound]


class WestCommandsTests(unittest.TestCase):
    WEST_TOPDIR: Path
    BUILD_DIR: Path

    @classmethod
    def setUpClass(cls):
        cls.WEST_TOPDIR = Path(run_west(["topdir"]).stdout.strip())
        requested_output = os.environ.get("OWNER_TEST_OUTPUT")
        if requested_output:
            cls.BUILD_DIR = Path(requested_output).resolve()
            cls.BUILD_DIR.mkdir(parents=True, exist_ok=False)
        else:
            cls.BUILD_DIR = Path(tempfile.mkdtemp(prefix=THIS_DIR.name + "-tests-"))
        print(f"Owner test output: {cls.BUILD_DIR}", flush=True)

    @unittest.skipUnless(
        platform.system() == "Linux", "zmk-test is only supported on Linux"
    )
    def test_zmk_test(self):
        test_build_dir = self.BUILD_DIR / THIS_DIR.name

        result = run_west(["zmk-test", "tests", "-m", ".", "-d", str(test_build_dir)])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        verify_native(test_build_dir, THIS_DIR / "tests")
        self.assertIn("PASS: test", result.stdout, result.stdout + result.stderr)
        self.assertIn("PASS: studio", result.stdout, result.stdout + result.stderr)
        self.assertNotIn("FAILED: ", result.stdout, result.stdout + result.stderr)

    @unittest.skipUnless(platform.system() == "Linux", "queue boundaries require Linux")
    def test_queue_pressure(self):
        result = subprocess.run(
            ["bash", "tests/queue-pressure/run.sh", str(self.WEST_TOPDIR)],
            env={
                **os.environ,
                "RUNTIME_MACRO_PRESSURE_OUTPUT": os.environ.get(
                    "RUNTIME_MACRO_PRESSURE_OUTPUT",
                    str(self.BUILD_DIR / "queue-pressure"),
                ),
            },
            capture_output=True,
            text=True,
            cwd=THIS_DIR,
        )
        (self.BUILD_DIR / "test_queue_pressure.log").write_text(
            result.stdout + result.stderr, encoding="utf-8"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for scenario in ("taps", "held", "delete"):
            self.assertEqual(
                result.stdout.count(
                    "PASS runtime macro queue pressure scenario=" + scenario
                ),
                3,
            )

    @unittest.skipUnless(platform.system() == "Linux", "host build requires Linux")
    def test_rpc_handler(self):
        result = subprocess.run(
            ["python3", str(THIS_DIR / "tests" / "rpc-handler" / "run.py")],
            capture_output=True,
            text=True,
            cwd=THIS_DIR,
        )
        (self.BUILD_DIR / "test_rpc_handler.log").write_text(
            result.stdout + result.stderr, encoding="utf-8"
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_zmk_build(self):
        self._test_zmk_build(
            {
                "runtime_macro_board_feature_disabled": ConfigAndDeviceTree(
                    config=[
                        'CONFIG_ZMK_KEYBOARD_NAME="Module Test"',
                        "CONFIG_ZMK_USB=y",
                        "CONFIG_ZMK_BLE=y",
                        "# CONFIG_ZMK_RUNTIME_MACRO is not set",
                    ],
                    device=[
                        "DT_COMPAT_HAS_OKAY_zmk_keymap",
                    ],
                ),
                "runtime_macro_board_with_rpc": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_RUNTIME_MACRO=y",
                        "CONFIG_ZMK_RUNTIME_MACRO_STUDIO_RPC=y",
                        "CONFIG_ZMK_BEHAVIOR_LOCAL_ID_TYPE_CRC16=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_STUDIO_RPC=y",
                        "# CONFIG_ZMK_STUDIO_LOCKING is not set",
                        "CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=192",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_LARGE_VALUE_MAX_SIZE=256",
                        # The handlers keep large step buffers off the RPC
                        # thread stack, so the module builds at the 4096 default
                        # (no bump needed - regression guard for the GetMacro
                        # RPC-thread stack overflow).
                        "CONFIG_ZMK_STUDIO_RPC_THREAD_STACK_SIZE=4096",
                        "CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES=256",
                        "CONFIG_ZMK_RUNTIME_MACRO_POOL_BYTES=1024",
                    ],
                    device=[],
                ),
                "runtime_macro_board_without_rpc": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_RUNTIME_MACRO=y",
                        "CONFIG_ZMK_RUNTIME_MACRO_TEST=y",
                        "CONFIG_ZMK_BEHAVIOR_LOCAL_ID_TYPE_CRC16=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS=y",
                        "# CONFIG_ZMK_STUDIO is not set",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_LARGE_VALUE_MAX_SIZE=256",
                        NotFound("CONFIG_ZMK_RUNTIME_MACRO_STUDIO_RPC"),
                    ],
                    device=[],
                ),
                "custom_settings_board": ConfigAndDeviceTree(
                    config=[
                        # Verify that zmk-feature-custom-settings is present and enabled
                        "zmk-feature-custom-settings",
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_RUNTIME_MACRO=y",
                        "CONFIG_ZMK_RUNTIME_MACRO_STUDIO_RPC=y",
                        "CONFIG_ZMK_BEHAVIOR_LOCAL_ID_TYPE_CRC16=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_STUDIO_RPC=y",
                        "# CONFIG_ZMK_STUDIO_LOCKING is not set",
                        "CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=192",
                        "CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=2048",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_LARGE_VALUE_MAX_SIZE=256",
                        # The handlers keep large step buffers off the RPC
                        # thread stack, so the module builds at the 4096 default
                        # (no bump needed - regression guard for the GetMacro
                        # RPC-thread stack overflow).
                        "CONFIG_ZMK_STUDIO_RPC_THREAD_STACK_SIZE=4096",
                    ],
                    device=[],
                ),
                "runtime_macro_board_dt_defaults": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_ZMK_RUNTIME_MACRO=y",
                        "CONFIG_ZMK_BEHAVIOR_LOCAL_ID_TYPE_CRC16=y",
                        "CONFIG_ZMK_CUSTOM_SETTINGS_LARGE_VALUE_MAX_SIZE=256",
                    ],
                    device=[
                        # Verify the devicetree default macro node in the
                        # runtime-macro-dt-defaults snippet was matched and compiled.
                        "DT_COMPAT_HAS_OKAY_cormoran_runtime_macro_default",
                    ],
                ),
            }
        )

    def _test_zmk_build(
        self, artifacts_and_expected_build_params: dict[str, ConfigAndDeviceTree]
    ):

        result = run_west(
            [
                "zmk-build",
                "tests/zmk-config",
                "-q",
                "-P",
                "1",
                "-d",
                str(self.BUILD_DIR),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        for artifact, entries in artifacts_and_expected_build_params.items():
            artifact_dir = self.BUILD_DIR / artifact / "zephyr"
            config_path = artifact_dir / ".config"
            device_tree_path = (
                artifact_dir
                / "include"
                / "generated"
                / "zephyr"
                / "devicetree_generated.h"
            )
            self._test_strings_in_file(
                config_path, entries.config, f"{artifact} config"
            )
            if entries.device:
                self._test_strings_in_file(
                    device_tree_path, entries.device, f"{artifact} device tree"
                )
            self.assertTrue(
                (artifact_dir / "zmk.uf2").exists(),
                f"{artifact} zmk.uf2 is missing in {artifact_dir}",
            )

    def _test_strings_in_file(
        self, file_path: Path, expected_strings: list[str | NotFound], hint: str
    ):
        self.assertTrue(file_path.exists(), f"{hint}: {file_path} is missing")
        file_text = file_path.read_text()

        for expected in expected_strings:
            if isinstance(expected, NotFound):
                if expected.text in file_text:
                    self.fail(
                        f"{hint}: {expected.text} found in {file_path}, but it should not be present"
                    )
            else:
                if expected not in file_text:
                    self.fail(f"{hint}: {expected} not found in {file_path}")


if __name__ == "__main__":
    unittest.main()

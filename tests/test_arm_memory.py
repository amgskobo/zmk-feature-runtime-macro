import sys
from pathlib import Path
import unittest

from arm_memory import input_allocation


class ArmResponseMemoryContract(unittest.TestCase):
    def test_abi_floors_and_original_budget_control(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent / "rpc-handler"))
        from list_wire import verify_response_storage

        for size, count, name, alignment in [
            (104, 1, 1, 4),
            (112, 1, 1, 8),
            (304, 8, 24, 4),
            (312, 8, 24, 8),
            (720, 16, 32, 4),
            (728, 16, 32, 8),
        ]:
            verify_response_storage(size, count, name, alignment)
        for size, alignment in [(784, 4), (792, 8)]:
            with self.assertRaisesRegex(
                AssertionError, "Configured Macro Response RAM"
            ):
                verify_response_storage(size, 8, 24, alignment)

    def test_wrapped_owner_allocation_ignores_discarded_rows(self):
        section = (
            ".bss.zmk_rpc_custom_subsystem_response_buffer_cormoran__runtime_macro"
        )
        text = f"RAM 0x20000000 0x40000 xrw\n {section}\n 0x0 0x310 app/libapp.a(runtime_macro_handler.c.obj)\n {section}\n 0x20000000 0x130 app/libapp.a(runtime_macro_handler.c.obj)\n"
        self.assertEqual(input_allocation(text), {"address": 0x20000000, "bytes": 304})

    def test_missing_regions_duplicate_and_outside_ram_fail_closed(self):
        row = " .bss.zmk_rpc_custom_subsystem_response_buffer_cormoran__runtime_macro 0x20000000 0x130 app/libapp.a(runtime_macro_handler.c.obj)\n"
        for text in [
            row,
            "RAM 0x20000000 0x40000 xrw\n" + row + row,
            "RAM 0x20000000 0x100 xrw\n" + row,
        ]:
            with self.subTest(text=text), self.assertRaises(AssertionError):
                input_allocation(text)

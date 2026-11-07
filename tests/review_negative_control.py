"""Restore one reviewed macro defect in an isolated owner copy."""

import argparse
from pathlib import Path


def replace_once(source: str, before: str, after: str) -> str:
    if source.count(before) != 1:
        raise SystemExit("expected exactly one reviewed source boundary")
    return source.replace(before, after)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("owner", type=Path)
    parser.add_argument(
        "fault",
        choices=(
            "borrowed-name",
            "truncate-name",
            "get-admission",
            "encode-lock",
            "web-lock",
            "timer-cleanup",
            "rename-persist-mode",
            "native-sanitizer-admission",
        ),
    )
    args = parser.parse_args()
    root = args.owner.resolve()
    owner = Path(__file__).resolve().parents[1]
    if root.is_relative_to(owner) or not (root / "src/runtime_macro.c").is_file():
        raise SystemExit("negative control requires an isolated owner source copy")
    if args.fault in ("borrowed-name", "truncate-name", "rename-persist-mode"):
        target = root / "src/runtime_macro.c"
    elif args.fault in ("web-lock", "timer-cleanup"):
        target = root / "web/src/useSessionRpc.ts"
    elif args.fault == "native-sanitizer-admission":
        target = root / "tests/native_verifier.py"
    else:
        target = root / "src/studio/runtime_macro_handler.c"
    source = target.read_text()
    if args.fault == "native-sanitizer-admission":
        start = source.index('            if re.search(\n                r"^(?:==')
        end = source.index('            if re.search(r"\\bFAIL:", raw):', start)
        source = source[:start] + source[end:]
    elif args.fault == "borrowed-name":
        start = source.index(
            "    char public_key[RUNTIME_MACRO_MAX_KEY_LEN];",
            source.index("int zmk_runtime_macro_name_for_slot("),
        )
        end = source.index("    return 0;", start)
        source = (
            source[:start]
            + """    const char *public_key = zmk_custom_setting_public_key(&runtime_macros.slots[slot].setting);
    snprintf(name, name_capacity, "%s", strip_prefix(public_key));
"""
            + source[end:]
        )
    elif args.fault == "truncate-name":
        start = source.index(
            "    size_t size = strlen(resolved);",
            source.index("int zmk_runtime_macro_name_for_slot("),
        )
        end = source.index("    return 0;", start)
        source = (
            source[:start]
            + '    snprintf(name, name_capacity, "%s", resolved);\n'
            + source[end:]
        )
    elif args.fault == "rename-persist-mode":
        source = replace_once(
            source,
            "return zmk_custom_setting_keyspace_rename(&runtime_macros, old_key, new_key, mode);",
            "(void)mode;\n    return zmk_custom_setting_keyspace_rename(\n"
            "        &runtime_macros, old_key, new_key, ZMK_CUSTOM_SETTING_WRITE_MODE_MEMORY);",
        )
    elif args.fault == "get-admission":
        source = replace_once(
            source,
            "ret = count_steps(get_macro_stream.encoded, get_macro_stream.size, &step_count);",
            "ret = 0; /* Deliberately defer malformed-body failure to encoding. */\n    step_count = 0;\n    (void)step_count;",
        )
    elif args.fault == "encode-lock":
        source = replace_once(
            source,
            "if (zmk_studio_core_get_lock_state() != ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED)",
            "if (false && zmk_studio_core_get_lock_state() != ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED)",
        )
    elif args.fault == "timer-cleanup":
        source = replace_once(
            source,
            "window.clearTimeout(timer);",
            "void timer; /* Deliberately leave the owned deadline scheduled. */",
        )
    else:
        source = replace_once(source, "!subscribed ||", "!subscribed || true ||")
    target.write_text(source)
    print("Restored only the selected reviewed defect in isolated owner:", args.fault)


if __name__ == "__main__":
    main()

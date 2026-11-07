# ZMK Runtime Macro

![ZMK Version](https://img.shields.io/badge/ZMK-master-blue)

Runtime Macro is a ZMK module that lets you create and edit small macros at runtime through the unofficial custom ZMK Studio RPC protocol.

Macros are **created, renamed, and deleted by name** (e.g. `"hello"`, stored as the [zmk-feature-custom-settings](https://github.com/amgskobo/zmk-feature-custom-settings) keyspace entry `macro/hello` under subsystem `cormoran__runtime_macro`). Once created, a macro's steps are read and edited by **slot number**, not name - see the note on the operational RPCs below. A keymap binding also only takes a **number**:

```dts
&rmacro 0
```

That number is the macro's **slot index** - a stable position (0 to `CONFIG_ZMK_RUNTIME_MACRO_COUNT - 1`) assigned when the macro is created and unchanged across reboots. It is **not** something you choose ahead of time: after creating a macro, check the Web UI's macro list (or the `ListMacros` RPC response) to see which slot it landed in, then bind that number in your keymap.

Each macro's body is a compact binary blob supporting:

- behavior down
- behavior up
- behavior tap using the global `tap_ms` setting
- delay in milliseconds, at most 60000 per step (`ZMK_RUNTIME_MACRO_DELAY_MS_MAX`): playback waits in ZMK's shared behavior queue, which holds every other macro back meanwhile
- packed `&kp` tap sequence using the global `tap_ms` setting, at most 64 keys
  per step; longer runs use multiple steps

Every macro's name + body together share one RAM pool - see [Macro Size Limits](#macro-size-limits) below.

Tap duration is a scalar custom setting, `tap_ms` (0 to 10000 ms), in the same subsystem. If one step needs a different duration, encode it as down, delay, then up.

## User Guide

This fork requires Custom Settings with
`zmk_custom_setting_keyspace_rename()`: renaming must preserve the macro's slot,
body and storage identity. The production import and isolated tests both select
`amgskobo/zmk-feature-custom-settings` at
`c4071b095c3007d1deb055c609603ca9b5897d14`. The older cormoran
`c6a7fef3a3be3d3ace5de9a4b0628c6418cd1f3f` does not provide that API.
Do not substitute create/delete for rename, since that can move the slot used
by an existing `&rmacro N` binding.

The selected commit also provides `zmk_custom_setting_copy_public_key()` and
local-notification authorization at encoding time. Both dependency manifests
select that same revision, including the key-copy and notification
lifetime fixes required by this module.

Prepare the exact Custom Settings commit from the declared fork URL and verify
its full identity. An existing local checkout or cache does not establish fresh
remote availability. Use the Runtime Macro branch below with the tested DYA
revision; the isolated manifest pins that same core. Local development may
select these exact revisions as explicit module overrides in the build workflow.

```yml
manifest:
  remotes:
    - name: amgskobo
      url-base: https://github.com/amgskobo
    - name: cormoran
      url-base: https://github.com/cormoran
  projects:
    - name: zmk-feature-runtime-macro
      remote: amgskobo
      revision: codex/runtime-macro-review
      import: true
    - name: zmk
      remote: cormoran
      revision: e5c9b6915b56801193e359dd9bad4a167ce0d1b8
      import:
        file: app/west.yml
```

Enable the module and Studio RPC in `config/<shield>.conf`.

```conf
CONFIG_ZMK_RUNTIME_MACRO=y
CONFIG_ZMK_BEHAVIOR_LOCAL_ID_TYPE_CRC16=y
CONFIG_ZMK_STUDIO=y
CONFIG_ZMK_RUNTIME_MACRO_STUDIO_RPC=y
CONFIG_ZMK_STUDIO_RPC_RX_BUF_SIZE=192
CONFIG_ZMK_STUDIO_RPC_CUSTOM_SUBSYSTEM_REQUEST_PAYLOAD_MAX_BYTES=192
CONFIG_ZMK_LOW_PRIORITY_THREAD_STACK_SIZE=2048
# Required alongside the defaults below (see "Macro Size Limits"):
CONFIG_ZMK_CUSTOM_SETTINGS_LARGE_VALUE_MAX_SIZE=256
```

The Studio RPC handlers keep their large per-macro buffers (a full step list is
~4.6 KB) off the RPC thread stack, so the module runs at the default
`CONFIG_ZMK_STUDIO_RPC_THREAD_STACK_SIZE=4096` - no stack bump is required.
(Earlier versions staged a macro on the stack and needed
`CONFIG_ZMK_STUDIO_RPC_THREAD_STACK_SIZE=8192`; forgetting it froze the keyboard
with a `K_ERR_STACK_CHK_FAIL` watchdog reset. That is no longer necessary.)

Include the behavior definition and bind a macro slot in your keymap.

```dts
#include <behaviors.dtsi>
#include <behaviors/runtime_macro.dtsi>

/ {
    keymap {
        compatible = "zmk,keymap";

        default_layer {
            bindings = <
                &rmacro 0
            >;
        };
    };
};
```

An unbound/empty slot plays nothing - so `&rmacro 0` is harmless on a freshly flashed board with no macros created yet.

Open the Web UI from the ZMK Studio custom subsystem list, connect over serial, then:

1. **Create** a macro by typing a name and clicking **Create** - it appears in the macro list with the slot number it was assigned.
2. Edit its steps, then use **Write Memory** for a temporary update or **Save** for persistent storage.
3. Bind that macro's slot number (`&rmacro <slot>`) in your keymap.
4. **Rename**, **Reset to Default**, or **Delete** a macro any time from the editor.

The editor starts fresh when the RPC connection, subsystem index, discovered
subsystem catalog or Studio authorization lifetime changes. It retires pending editor requests, clears their
deadlines and stops sending subsequent steps from an old write. An RPC already
sent may still take effect on the device. A full body write clears the old steps
in memory, then appends the new steps in order. Each intermediate body is a
prefix of the intended result, so old steps and placeholders cannot consume
the new body's action or byte budget. **Save** persists the completed body;
**Write Memory** leaves it pending. Connection retirement, timeout or any other failure does not roll
back requests already accepted. Reconnect and reread before retrying a failed
write. This UI behavior does not make multi-request writes atomic or establish
general concurrent registry publication during playback.

Within one session, the latest macro selection owns the displayed body. A slow
older reply or refresh cannot replace that selection, and controls stay busy
until every outstanding editor operation has finished. Invalid step edits show
an error without closing the editor; body writes remain disabled until corrected.
Rename and refresh preserve unsubmitted body and JSON drafts for the current
macro. Edits made while an older write or read is pending also remain in the
editor; completing that write saves its submitted version, not the newer draft.
Names, the next creation name and the global tap setting also keep independent
drafts, so a completed request or metadata refresh cannot clear newer input.
An explicit macro selection or a new connection starts a different editor.
Locking also clears the displayed body and drafts immediately; the editor opens
a fresh session after unlocking. An old full-body write never resumes after a
lock/unlock cycle. Requests already sent may still have affected the keyboard.
Create opens the new macro only if no later macro selection was made while
that request was pending; otherwise the current selection and draft remain.
Delays must be whole milliseconds from 0 through 60000, and `tap_ms` must be a
whole number from 0 through 10000. These bounds are checked before sending the
corresponding write.

Memory updates become pending custom setting changes; use **Save Pending** to persist all pending runtime macro changes, or **Discard Pending** to restore the saved values. Macros with such in-memory-only changes are marked with an "unsaved" dot in the list (the `ListMacros` response reports this per macro as `has_unsaved_changes`).

**Unlocking:** the firmware permits `ListMacros` and `GetMacroGlobalSettings` while locked; they return only metadata (slot, name, size, unsaved flag, and global limits), never a macro's contents. The browser editor retires its form on a lock notification and waits for unlock. Reading a specific macro's steps (`GetMacro`) or making any change (create/edit/rename/delete/reset/save/discard, `set_tap_ms`) requires an unlocked Studio session and is otherwise rejected with an "unlock required" error. The same holds for the generic custom settings RPC: the macro keyspace is registered with secure read and write permission. The selected registry must also enforce that permission when asynchronous body notifications are encoded.

Create/Delete/Rename are macro-domain RPCs on this module's own subsystem (`CreateMacro`/`DeleteMacro`/`RenameMacro`), addressing a macro by its **name**. A client never needs to know that macros are stored as zmk-feature-custom-settings keyspace entries under the `macro/` prefix - the storage is an implementation detail, and no separate custom-settings RPC call is required. `RenameMacro` renames the entry in place in one write: the macro keeps its slot (so `&rmacro N` bindings keep working) and its body. Validation or allocation refusal leaves it unchanged. With `persist: true`, a storage error retains the new name in RAM as an unsaved change. A backend refusal before writing keeps the previous durable name, as the owner's controlled backend verifies; arbitrary physical storage errors provide no atomic durability guarantee. Save retries the rename and discard reloads the persisted name. No change event is raised for that failed write, so API clients must reread after a persistence error. The current Web editor renames in memory (`persist: false`) and then uses Save Pending for persistence. This uses `zmk_custom_setting_keyspace_rename()` from the custom settings fork.

`ResetMacro` restores a macro to its compile-time state, addressing it by **slot number**. If a [devicetree default](#devicetree-default-macros) declares a macro of the same name, its body is overwritten with that default; `persist: false` keeps that body in memory and `persist: true` saves it. Without a matching default, a memory-only reset is refused without changing the macro. Set `persist: true` to delete it durably, or use the explicit Delete action. The Web editor uses memory-only Reset to Default and keeps a macro without a default unchanged.

This module's own operational RPCs - `GetMacro`, `SetMacroStepCount`, `SetMacroStep`, and `AppendMacroStep` - address the macro to read or edit by its **slot number**, the same numeric value used for the keymap binding, not by name. Discover a macro's slot from the `ListMacros` response (the `CreateMacro` status message also names the slot it just assigned); an unbound or out-of-range slot is rejected with a clear error rather than silently doing nothing.

Slot names are copied under the registry guard. A retained name exceeding the
current limit or the caller's buffer is refused instead of truncated to another
macro's name. GetMacro checks the complete stored wire structure before choosing
its success response, so an invalid retained/generic-written body returns a
valid RPC error and remains unchanged. Body encoding also checks unlock when
the steps callback begins; bytes already emitted cannot be recalled, and this
does not establish cancellation at every subsequent transport wait.

The runtime macro RPC also exposes `MacroGlobalSettings`, containing `tap_ms` and `max_entries`. The get request returns the whole global settings message so future global settings can be added together; writes are per key, such as `set_tap_ms`. `max_entries` is read-only and reports the configured maximum number of macros that can exist at once (`CONFIG_ZMK_RUNTIME_MACRO_COUNT`).

## Devicetree Default Macros

By default no macros exist, so a freshly flashed board needs a Studio connection before `&rmacro` does anything anywhere. To ship a macro that already works out of the box, declare a **devicetree default**: a factory macro defined at compile time in your `.keymap`/`.overlay`, with no Studio connection required and no extra Kconfig option to enable.

Add one `cormoran,runtime-macro-default` node per macro, anywhere under `/ { ... }` (it doesn't need to live inside `keymap` or `behaviors`). The simplest case just types text:

```dts
/ {
    runtime_macro_defaults {
        rmacro_default_0 {
            compatible = "cormoran,runtime-macro-default";
            macro-name = "Email";
            text = "user@example.com";
        };
    };
};
```

After flashing, open the Web UI (or the `ListMacros` RPC) to see which slot `"Email"` was assigned, then bind `&rmacro <that slot>` in your keymap - pressing it types `user@example.com` immediately, before ever opening the Web UI to edit it.

For steps other than plain text - modifier holds, other behaviors, explicit delays - use `bindings`, which reuses ZMK's native macro vocabulary so there's nothing new to learn. This example (added as another node next to `rmacro_default_0` above, inside the same `runtime_macro_defaults` container) holds Shift for one key, then taps `w` and `Enter` (handy as a Vim `:w<Enter>` save macro):

```dts
rmacro_default_1 {
    compatible = "cormoran,runtime-macro-default";
    macro-name = "Vim save";
    bindings = <&macro_press &kp LSHFT>
             , <&macro_tap &kp SEMI>
             , <&macro_release &kp LSHFT>
             , <&macro_wait_time 5>
             , <&macro_tap &kp W>
             , <&kp RET>;
};
```

Each comma-separated entry is one binding, same as a keymap's `bindings` list. `&macro_tap` / `&macro_press` / `&macro_release` switch the mode applied to the entries that follow (starting mode is tap) and stay in effect until changed again - the trailing `<&kp RET>` above is still a tap because mode was last set to tap. `&macro_wait_time <ms>` inserts an explicit delay. Any other behavior binding (`&kp`, `&mo`, ...) is encoded using its behavior local ID, and plain-ASCII `&kp` taps made while in tap mode are packed exactly like `text`, so mixing `text` and `bindings` in the same macro (`text` is always encoded first) doesn't cost extra bytes.

| property     | meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `macro-name`  | The macro's name (its keyspace key, `macro/<name>`). Defaults to the node name. Must be unique.    |
| `text`        | Plain ASCII text, encoded first as a packed key-tap sequence (same encoding the Web UI uses).      |
| `bindings`    | ZMK-native macro steps, encoded after `text`.                                                      |
| `wait-ms`     | Delay inserted between consecutive non-packed `bindings` steps. Default `0` (none).                |

At least one of `text` or `bindings` must be set.

**A devicetree default is seeded, not persisted.** On every boot, after settings load, each `cormoran,runtime-macro-default` node whose name has no live macro yet is created in memory (not saved to flash). This means:

- Editing a devicetree default's body from the Web UI and clicking **Save** creates a real, persisted macro under that name - from then on, the persisted value wins every boot (the seed step only fires when no macro of that name already exists).
- **Deleting** a devicetree default from the Web UI removes it only for the current session - it comes back, un-persisted, on the next reboot. To remove a devicetree default permanently, remove its node from the devicetree instead.
- A devicetree default's assigned slot is **not guaranteed to be the same every boot** if other macros are created/deleted around it - it depends on which slots are already occupied by persisted macros at boot time. On a device with no persisted macros, devicetree defaults are seeded in devicetree declaration order into the first available slots, which is stable in practice; always double check via the Web UI/RPC list rather than assuming a fixed number.
- A default that fails to encode or exceeds `CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES` (for example an unsupported character in `text`, or too much `bindings` content) is skipped with a log at boot - it does not fail the build, and does not prevent the other defaults from installing.

## Binary Format

Each stored macro body is a byte array:

```text
version: u8 = 1
steps...
```

Step fields use unsigned base-128 varints.

```text
down:         opcode=1, behavior_id, param1, param2
up:           opcode=2, behavior_id, param1, param2
tap:          opcode=3, behavior_id, param1, param2
delay:        opcode=4, delay_ms
key sequence: opcode=5, byte_length, packed_key_bytes...
```

The key sequence opcode is optimized for consecutive `&kp` taps that use HID keyboard usages with no modifier or left shift. Each packed key byte uses bit 7 for left shift and bits 0-6 for the HID keyboard usage ID, so common ASCII-producing taps cost one byte per key plus the opcode and length bytes. During playback each packed key is expanded to a normal `&kp <keycode>` tap using the global `tap_ms` value.

## Macro Size Limits

Every macro's name + body together draw from **one shared RAM pool** sized by `CONFIG_ZMK_RUNTIME_MACRO_POOL_BYTES` (default 1024 bytes), instead of each of the `CONFIG_ZMK_RUNTIME_MACRO_COUNT` slots reserving its own worst-case buffer. A short macro costs close to its actual name+body bytes; a long one can use much more, up to a per-macro ceiling:

| Kconfig                                                                              | Meaning                                                                                                                                                | Default |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `CONFIG_ZMK_RUNTIME_MACRO_COUNT`                                                     | How many macros can exist at once (bounds the fixed slot-descriptor array, independent of the byte pool below).                                        | 8       |
| `CONFIG_ZMK_RUNTIME_MACRO_NAME_MAX_LEN`                                              | Longest a macro's name may be, in bytes (at most 32, what Studio messages carry).                                                                        | 24      |
| `CONFIG_ZMK_RUNTIME_MACRO_POOL_BYTES`                                                | Total bytes shared by every macro's name + body combined.                                                                                               | 1024    |
| `CONFIG_ZMK_RUNTIME_MACRO_MAX_BYTES`                                                 | Largest a single macro's encoded body may be. Also sizes playback/RPC staging buffers.                                                                  | 256     |
| `CONFIG_ZMK_CUSTOM_SETTINGS_LARGE_VALUE_MAX_SIZE` (from zmk-feature-custom-settings) | Must be raised to at least `MAX_BYTES` (see the `.conf` snippet above) - it caps every large/pooled setting in the firmware, not just this module's.    | 64      |

Raise `POOL_BYTES` if you want many long macros to coexist; raise `MAX_BYTES` (and `LARGE_VALUE_MAX_SIZE` alongside it) if a single macro needs to be longer than 256 bytes. Keep `MAX_BYTES` no larger than you actually need - it sizes the transient playback buffer and the Studio RPC step-staging buffers even for short macros. A longer macro can decode into more actions than `CONFIG_ZMK_RUNTIME_MACRO_QUEUE_SIZE` (default 64) holds; raise that limit alongside `MAX_BYTES` when needed. Temporary saturation of ZMK's shared behavior queue is handled by delayed retries and does not require raising the decoded-action limit.

If the pool is full, creating or updating a macro fails and the Web UI shows **"Macro pool full: delete or shrink another macro"** - the macro's previous value is left untouched. The Web UI also shows the pool's current usage (e.g. "Shared macro pool: 300/1024 B used") next to the macro list. Raising `CONFIG_ZMK_RUNTIME_MACRO_COUNT` costs a small, fixed amount of RAM per extra slot regardless of the pool budget - it does not affect how many bytes of macro content fit.

## Upgrading from a pre-keyspace release

This module's macro storage uses the keyspace feature of [zmk-feature-custom-settings](https://github.com/amgskobo/zmk-feature-custom-settings), with the shared pool and limits described above. Upgrading from the former numeric-slot storage is a **breaking storage-schema and RPC change**:

- Previously-recorded macros (stored per numeric slot as `names.<i>` / `macros.<i>`) are **not migrated** and are silently dropped on upgrade - recreate your macros after flashing.
- Macros are now created/deleted/renamed by **name**, not by a fixed slot index; a keymap binding's numeric parameter is now an assigned slot you look up after creating a macro, not a slot you write directly into.
- The RPC protocol replaced the old `SetMacroName`/`DeleteMacro` with name-keyed `CreateMacro`/`DeleteMacro`/`RenameMacro` (macro lifecycle is now handled entirely by this module's subsystem - no generic `CreateSetting`/`DeleteSetting` call needed), renamed some fields (`index` → `slot`, `max_macro` → `max_entries`, `MacroSlot` → `MacroDetail`), and addresses `GetMacro`/`SetMacroStepCount`/`SetMacroStep`/`AppendMacroStep` by `slot` (not `name`) - regenerate any custom RPC client against the new `.proto`.

## Development

Playback decodes the body once, then retains its next action while the shared
ZMK behavior queue is full. It retries from delayed work without replaying
accepted presses or losing their releases. A new playback stays busy until
the completion marker executes at the end of the shared queue. Deleting the
stored macro does not discard actions already decoded for a playback. This adds no idle
timer or heap allocation. It does not bound queue/transport latency or add an
abort API. See [the real-kernel pressure check](tests/queue-pressure/README.md)
and run `bash tests/queue-pressure/run.sh /absolute/resolved/west/workspace`.

```bash
pre-commit run
python3 -m unittest discover -s tests -p test_owner.py
west zmk-build tests/zmk-config
west zmk-test tests -m .
cd web && npm test
```

The Web UI can import and export the macro step subset from the Keyboard Abyss keybindings schema. Runtime behavior bindings are represented as valid `raw` bindings using `local-id:<behavior_id> <param1> <param2>`.

Playback remains busy until a completion marker reaches the end of the shared
behavior queue, including pre-existing queued work. Temporary queue saturation
yields and resumes at the first unqueued action without losing a tap release.

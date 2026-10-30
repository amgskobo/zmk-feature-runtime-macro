# Owner tests

This repository owns its executable test logic and fixtures under `tests/`.

## Current test ownership and compatibility

This owner supports DYA custom Studio RPC. Stock ZMK is NOT APPLICABLE;
no feature-disabled stock check is required or counted as compatibility.

Canonical entries (run from the repository root):

```bash
python3 -m unittest discover -v -s tests -p test_owner.py
bash tests/run-web.sh
```

[maintenance.json](maintenance.json) records supported cores, current commands
and explicit gaps. It is a reference map, not a passing test or a claim that
registration/coverage totals establish completeness. Preserve ordered outputs,
raw timestamps and the first failure. Read actual dependencies before execution.

`OWNER_TEST_OUTPUT=/absolute/new/directory` retains owner native/build outputs.
An existing directory fails before tests. Without it a fresh temporary directory
is printed and retained. No shared build directory is deleted. Use
`PYTHONPATH=tests python3 -m unittest -v test_owner.WestCommandsTests.<method>`
for a focused case; discovery runs the complete documented class.

Web assertions and Jest configuration live in `tests/web/`; application source
and installed dependencies remain in `web/`. The package scripts only dispatch
the owner configuration. No dependencies are installed implicitly by the tests.

The native verifier runs each built binary three times in independent empty
initial-flash directories, retaining raw output before filtering. It checks real
process exits, fatal assertions and every linked checked-init result before
comparing unchanged owner snapshots. A SYS_INIT error cannot be hidden by a
later matching key trace. Native scheduling and controlled APIs still do not
establish physical transport/retention. Test-only core/tool dependencies are
pinned; update pins only after reviewing the new sources and rerunning this
owner matrix. No network updates are implicit in the owner test command.

`tests/rpc-handler/run.py` compiles the real Studio RPC handler with the real
nanopb codec, optimized and with ASan/UBSan, against a controlled macro store.
While Studio is locked every request that reads macro steps or changes
anything is refused before it reaches the store, and ListMacros and
GetMacroGlobalSettings still answer. Unlocked, lifecycle errors map to their
own messages, the step editor's append/replace/resize rewrites produce the
exact byte stream, GetMacro streams the same reply as the expected steps, a
delay above `ZMK_RUNTIME_MACRO_DELAY_MS_MAX` is refused with its own message,
and a body with an overflowing varint is refused. Builds whose slot count or name
length the RPC messages cannot carry must fail.

The dt-defaults case also installs a 70-character text default with
`CONFIG_ZMK_RUNTIME_MACRO_QUEUE_SIZE=80`, which must be split into
KEY_TAP_SEQUENCE steps of at most 64 keys so Studio can open it.

Renaming keeps a macro's slot, so `&rmacro N` bindings keep working. This
needs the `zmk_custom_setting_keyspace_rename()` API of the custom settings
fork. Both the production import and isolated test manifest pin
`amgskobo/zmk-feature-custom-settings` at
`b91a8ceb0a57a0cf41b34270752d79463e2848fa`, which contains the API.
The previous cormoran `c6a7fef` selection does not implement it and fails enabled
board/native links; those failures remain valid regression evidence.

Prepare the selected public dependency commit in a fresh isolated container
workspace. Verify the resolved production and test manifests, clean checkout,
source hashes and absence of implicit CMake overrides before the canonical run.
Do not replace the declared selection or copy a dirty sibling into the dependency.
Dependency preparation is explicit; ordinary tests do not fetch or update inputs.
The selected registry includes mutation serialization and notification lifetime
fixes as well as rename. This owner still tests its own playback/RPC boundaries;
registry tests and physical acceptance are separate evidence.

## Reproducible isolated checks

Use this owner's `west/west-test-isolated.yml` and its pinned test dependency
manifest. Test ZMK is `e5c9b6915b56801193e359dd9bad4a167ce0d1b8`;
Zephyr is `10ba6d0cb38bc3d258775d27982f707599320085`. Resolve the
manifest and verify actual checkout identities before running. Do not inherit
global CMake module overrides or moving production dependency references into
these isolated fixtures. The CI SDK image is pinned by digest in
`.github/workflows/zmk-module.yml`; production dependency manifests are separate.

Use a new `OWNER_TEST_OUTPUT` directory for every complete owner run. Native
repeats reuse one compiled binary with independent initial-flash state; keep
the first failure and raw combined stdout/stderr order. DYA-only compatibility
still means no stock-ZMK test requirement.

The test/tool static CI job installs pre-commit 4.7.0 and uses the pinned
Ruff/clang-format/formatting hooks. Its SKIP list avoids repeating the firmware
and Web jobs. Local full pre-commit execution may run those functional hooks;
prepare Web dependencies with the normal package lifecycle first where present.
A successful hook exit must also leave source inputs unchanged. Snapshot and
event-pattern bytes are excluded from whitespace rewriting.

## 32-bit timeout arithmetic

Variable millisecond reservations use a private owner header and preserve the
full uint32 input range, exact ceiling and configured kernel tick ABI. Fractional
products and divisions use uint32; only the required tick result is widened.
Zero/forever handling, callback ownership, cancellation and output policy remain
at their existing call sites. This introduces no new limit on timer settings.

`test_timeout_width.py` runs in the canonical container owner entry. It compares every
0..65535 interval, full-width boundaries and 65536 deterministic full-width
samples at 14 rates against an independent wide oracle, for both tick forms.
Full retains optimized, ASan/UBSan, measured nonzero complete header line/branch
coverage and m32 object/numeric execution. Four identified arithmetic faults
must produce three qualified assertion failures per tick form. A numerically
correct wide-divider control must fail the object-width guard. Existing output,
state, timing and supported-core assertions remain enabled. Kernel/physical
acceptance remains separate from this numerical and object-code check.

The owner command boundary limits `zmk-build` to one target at a time by
default. `OWNER_TEST_BUILD_PARALLELISM` selects an explicit positive target
count; account for compiler jobs and concurrent owners in the global budget.
`tests/test_build_budget.py` checks default/explicit forwarding and rejects
invalid budgets before launching west. The canonical owner entry includes
these controls without dropping any native or board scenario.

Native result admission requires every `native_sim.keymap` fixture to have a
matching binary. `required_hooks.json` names the expected checked initialization
hooks and required feature/role configuration. Fixture-bound declarations also
reject missing configuration when both the request and build omit it; excluded
roles cannot replace the requested role. The verifier retains all three raw
runs before comparing unchanged ordered snapshots and rejects logged failures,
fatal output and missing/nonzero completions. `tests/test_native_verifier.py`
owns eleven real-ELF admission controls, including a deliberately missing
native scenario, wrong-role and unrelated-fixture controls.

`bash tests/run-web.sh` is the canonical schema-generation/Web test entry.
It runs all configured Jest scenarios in one worker process. The pre-commit
Jest hook dispatches this same owner entry so nested workers do not multiply
the global container budget. Build and lint retain their separate package entries.

## Web request lifetime and numeric boundaries

`web/sessionLifecycle.spec.tsx` exercises the production editor through the
locked provider and generated wire messages with a controlled RPC transport.
Connection, subsystem-index and catalog changes must reset forms and retire
pending creates and partially dispatched body writes. Latest-selection and
refresh controls retain the chosen macro; independent reads cannot release a
pending write's busy state. Create and rename keep the resulting macro selected.
Unmount and completion clear request deadlines; the five-second timeout still
reports a failure. Synchronous transport errors and rejected promises release
their deadlines and restore controls, including rejection with undefined, null
or false. These values must never be decoded as a successful reply. StrictMode
replay and unrelated provider updates remain usable.

The same fixture keeps the editor alive for invalid delays, binding fields and
packed keys, refuses writes before resize, and permits recovery after correction.
Fractional and out-of-range tap durations never reach the transport. The
fractional-tap case preserves an existing rejection as a positive control.
`web/macroCodecBounds.spec.ts` rejects overflowing fifth varint bytes in delay,
binding and packed-sequence lengths, while retaining valid full uint32 decoding
and the firmware-compatible overlong-zero form. Editor delay limits remain a
separate rule from the raw binary codec's uint32 range.

The regressions fail against the original editor/decoder before the fixes;
valid decoder inputs, timeout reporting, StrictMode and unrelated updates are
positive controls. These are controlled DOM/transport checks. They do not
establish physical serial delivery or rollback of already-dispatched requests.
Retirement stops subsequent requests; resize/step writes remain non-atomic.
Run build and lint separately with `npm --prefix web run build` and
`npm --prefix web run lint` in the prepared container.

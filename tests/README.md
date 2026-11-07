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
process exits, sanitizer diagnostics, fatal assertions and every linked checked-init result before
comparing unchanged owner snapshots. A SYS_INIT error cannot be hidden by a
later matching key trace. Native scheduling and controlled APIs still do not
establish physical transport/retention. Test-only core/tool dependencies are
pinned; update pins only after reviewing the new sources and rerunning this
owner matrix. No network updates are implicit in the owner test command.

`tests/test_native_verifier.py` compiles recovering ASan and UBSan controls.
Each control must really diagnose its fault, return zero, complete its checked
init and emit the unchanged key trace before the verifier rejects it. ASan
reports on stdout and UBSan on stderr; the verifier retains their combined raw
output. Sanitizer names and configuration text without diagnostic syntax remain
valid. All earlier exit, role/configuration, hook, fixture, snapshot, fresh-state
and unchanged-binary assertions remain required. For retained control inputs,
set `NATIVE_VERIFIER_CONTROL_OUTPUT` to a fresh output parent outside the source.
The `native-sanitizer-admission` isolated fault removes only that diagnostic
check; exactly the two recovering-sanitizer rejection assertions must fail while
the other verifier controls complete. Replay each retained control binary in
three fresh directories against the fixed verifier without recompilation.

Combined native ASan/UBSan runs can diagnose the selected DYA core's
`kscan_mock.c:103` signed shift even when recovery lets initialization and the
snapshot finish. Such a run is rejected, never a clean native PASS. Keep core,
dependency and owner diagnostics separately classified with the captured source
location and hash. Strict compiler flags and runtime halt options are separate
properties; inspect the native simulator's Make-built sources as well as CMake's
compilation database. The standalone queue and pressure launchers select normal
builds, while the handler, timeout and review sanitizer entries compile with
`-fno-sanitize-recover=all`; those entries do not declare a recovering profile.

The production and isolated-test manifests select Custom Settings
`c4071b095c3007d1deb055c609603ca9b5897d14`. That dependency provides
`zmk_custom_setting_copy_public_key()` and local notification authorization at
encoding, alongside same-slot rename. An explicit working override is a
different source snapshot; record its complete identity and do not treat it as
the committed pin. Review future dependency changes before advancing the pin.

The slot-addressing fixture retains its earlier write/read, freed-slot and range
assertions and adds caller-buffer refusal, a retained larger-limit name, and a
deterministic metadata interleave around the former borrowed-key API. The
real-codec handler fixture keeps its overflowing-varint input but now requires
a valid error response before framing success, rather than accepting a broken
response encoder. Unknown opcode/version, truncated varints/bindings/packed keys
and invalid packed values receive the same exact error with unchanged bodies.
An admitted valid reply is locked before encoding, then unlocked as its positive
control. The Web lifecycle suite covers a delayed body reply and a partial write
across batched lock/unlock, while preserving existing draft and timeout controls.

`python3 tests/review_negative_control.py "$ISOLATED_OWNER" FAULT` changes only
the selected boundary in a separate source copy. `borrowed-name` and
`truncate-name` must fail the unchanged slot-addressing native fixture.
`get-admission` and `encode-lock` must fail the intended real-codec assertions
through `tests/rpc-handler/run.py --source "$ISOLATED_OWNER/src/studio/runtime_macro_handler.c"`.
`web-lock` must fail the two lock lifecycle regressions through the canonical
Web entry from the isolated owner. `timer-cleanup` omits only deadline cleanup
and must fail the retained zero-timer assertions after lock/unmount, even after
fake microtasks have been drained. An executable assertion failure is required;
link or setup failures are BLOCKED. Existing numerical/width and admission
negative controls remain required.

`tests/rpc-handler/run.py` compiles the real Studio RPC handler with the real
nanopb codec, optimized and with ASan/UBSan, against a controlled macro store.
It also checks that memory-only reset without a devicetree default preserves the
macro, that memory reset with a default remains supported, and that explicit
persistent reset can delete. A 2048-byte capacity variant rejects stack frames
larger than 2048 bytes and runs the same handler scenarios. Dependency paths for
the review fixtures are resolved from the selected west workspace by the owner
entry; callers need not provide `ZMK_ROOT` or `NANOPB_ROOT` for that entry.
While Studio is locked every request that reads macro steps or changes
anything is refused before it reaches the store, and ListMacros and
GetMacroGlobalSettings still answer. Unlocked, lifecycle errors map to their
own messages, the step editor's append/replace/resize rewrites produce the
exact byte stream, GetMacro streams the same reply as the expected steps, a
delay above `ZMK_RUNTIME_MACRO_DELAY_MS_MAX` is refused with its own message,
and a body with an overflowing varint is refused. Builds whose slot count or name
length the RPC messages cannot carry must fail.

### Retained RPC-handler evidence and focused variants

Run these commands inside the prepared container and selected west workspace.
`tests/rpc-handler/run.py --output "$FRESH_OUTPUT"` retains its generated
nanopb C/headers and controlled headers, copied generator, selected source inputs,
executables, compiler commands/stdout/stderr, binary SHA-256 files, runtime logs
and `results.json`. The manifest records canonical/focused scope, source and
dependency input hashes, command/cwd/environment overrides, elapsed time and
actual exits. Runtime stdout/stderr share one ordered log. Compile refusals keep
their distinct stderr files. Input drift fails the run without erasing an earlier
failure. The absolute output directory must be fresh and outside owner sources;
existing directories and links are rejected before tool invocation.

Without `--output`, temporary cleanup and the default matrix remain unchanged.
The default `--variant all` still runs the optimized, ASan/UBSan and large-body
handler binaries once each, compiles the accepted32-byte name variant, and checks
both17-slot and33-byte-name compiler refusals using their existing diagnostics.
All compiler flags, C assertions and default execution counts are retained.

`--variant optimized`, `sanitized` or `large-body` selects one executable case.
`--variant max-name` is compile-only acceptance; `--variant oversize` retains
both intentional compile-refusal controls. Every focused run is labelled
`canonical full matrix NOT RUN` and cannot replace the canonical owner entry.

For example, prepare one isolated `get-admission` or `encode-lock` source with
the existing helper, then retain each required executable variant separately:

```bash
python3 tests/rpc-handler/run.py \
  --source "$ISOLATED_OWNER/src/studio/runtime_macro_handler.c" \
  --variant sanitized --output "$FRESH_OUTPUT"
```

A deliberate assertion failure leaves that command nonzero while retaining
`rpc-handler-sanitized`, its `.sha256` file, `run-sanitized.log` and the exact
command/environment in `results.json`. Keep that first result; do not rebuild or
reuse the output directory to obtain the remaining trials. Verify the binary
hash and execute it in two new initial-state directories in the same prepared
container. For the sanitized variant the runner explicitly sets
`ASAN_OPTIONS=detect_leaks=0`; retain any recorded UBSan/LSan options as well.

```bash
(cd "$FRESH_OUTPUT" && sha256sum -c rpc-handler-sanitized.sha256)
for repeat in 2 3; do
  mkdir "$FRESH_OUTPUT/sanitized-run-$repeat"
  if (cd "$FRESH_OUTPUT/sanitized-run-$repeat" && \
      ASAN_OPTIONS=detect_leaks=0 "$FRESH_OUTPUT/rpc-handler-sanitized") \
      >"$FRESH_OUTPUT/run-sanitized-$repeat.log" 2>&1; then
    result=0
  else
    result=$?
  fi
  printf '%s\n' "$result" >"$FRESH_OUTPUT/run-sanitized-$repeat.exit"
done
```

Repeat the procedure with `optimized` and `large-body`, preserving each exact
binary and its own fresh evidence. Require the intended C assertion in all three
logs: `get-admission` fails the error-response discriminator assertion, and
`encode-lock` fails `!encode_reply(reply, sizeof(reply), &reply_size)`. A nonzero
runner exit, sanitizer setup failure, compiler refusal or unrelated crash is
insufficient. The larger-body frame guard and name/slot capacity controls remain
separate legitimate compiler checks.

The dt-defaults case also installs a 70-character text default with
`CONFIG_ZMK_RUNTIME_MACRO_QUEUE_SIZE=80`, which must be split into
KEY_TAP_SEQUENCE steps of at most 64 keys so Studio can open it.
The Studio fixture independently uses action capacity 80 to require a single
65-key packed step to be rejected by public validation/create/write. A 64-key
step and a split 64+1 body remain valid, retain their exact bytes, and stream
through the registered handler, framework callback and real nanopb codec.

Renaming keeps a macro's slot, so `&rmacro N` bindings keep working. This
needs the `zmk_custom_setting_keyspace_rename()` API of the custom settings
fork. Both the production import and isolated test manifest pin
`amgskobo/zmk-feature-custom-settings` at
`c4071b095c3007d1deb055c609603ca9b5897d14`, which contains the API.
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

An optional sanitizer build of the full DYA native app also executes core code
outside this owner's control. The selected mock scanner uses a signed
`1 << 31` expression in `app/module/drivers/kscan/kscan_mock.c`; UBSan can stop
there before a required fixture completes. Preserve that failure and report
the combined native lane as BLOCKED by the dependency. Keep assertions and
required features enabled. An ASan-only native run, optimized native run and
the independent real-kernel queue/handler/timeout sanitizer checks have separate
identities and cannot turn that blocked lane into PASS. Native mock builds use
their selected 64-bit ABI; ARM board compilation and the explicitly declared
host `-m32` timeout checks remain separate.

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

`tests/web/sessionLifecycle.spec.tsx` exercises the production editor through the
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

The request lifetime exposes a frozen resource interface over private mutable
authorization/cancellation state. Lock callbacks retire that resource synchronously;
they do not mutate a React memoized value. Cleanup/setup replay can reactivate
the same resource only for the same lifetime, while every lock transition and
connection/catalog replacement gets a distinct resource.

Modern Jest's timer count includes fake microtask jobs as well as scheduled
timeouts. The selected Sinon implementation adds its job queue to the timer heap
count, while Jest `runAllTicks()` calls only `runMicrotasks()`. React's `act`
schedules fake `queueMicrotask` checks, so drain those jobs before asserting that
no deadline remains. The original zero assertions stay intact. Positive controls
queue a microtask, drain it without advancing `Date.now()`, and require a real
unresolved RPC's five-second timeout to remain counted as one; unmount must then
leave zero. The partial-write lock case likewise requires one live deadline
before retirement, and the delayed-body case checks zero before its late reply.
No `clearAllTimers`, clock advance or permissive count is used to hide a leak.

The same fixture keeps the editor alive for invalid delays, binding fields and
packed keys, refuses writes before resize, and permits recovery after correction.
Fractional and out-of-range tap durations never reach the transport. The
fractional-tap case preserves an existing rejection as a positive control.
`tests/web/macroCodecBounds.spec.ts` rejects overflowing fifth varint bytes in delay,
binding and packed-sequence lengths, while retaining valid full uint32 decoding
and the firmware-compatible overlong-zero form. Editor delay limits remain a
separate rule from the raw binary codec's uint32 range.

Settled replies are checked against the operation's success envelope before
the editor consumes them. The same lifecycle fixture covers empty and unknown
protobuf replies, wrong-operation replies, an ambiguous success envelope and
missing global settings. A rejected list keeps its catalog and body draft;
missing settings keep the previous global tap/pool metadata. Rename cannot
optimistically change the selection, confirm success or issue refreshes after
an invalid reply. Empty and whitespace-only server errors stay visible.
These ten regressions fail their DOM/state assertions against the original
editor. A valid empty catalog, empty status and successful recovery remain positive controls,
along with all earlier lifecycle cases. Already dispatched requests retain the
existing non-atomic device-side limit.

The regressions fail against the original editor/decoder before the fixes;
valid decoder inputs, timeout reporting, StrictMode and unrelated updates are
positive controls. These are controlled DOM/transport checks. They do not
establish physical serial delivery or rollback of already-dispatched requests.
Retirement stops subsequent requests; resize/step writes remain non-atomic.
Draft regressions cover rename/refresh, a pending body read and a pending Save,
including independently edited JSON text. The full-rewrite case moves a
63-key sequence across a delay boundary with a 64-action oracle: clearing the
old body and appending final prefixes must succeed without a transient overflow.
Partial resize/replace/append RPC semantics remain covered by the real-handler
fixture; Web full writes no longer retain old steps or add placeholders.
Name and next-creation-name controls retain edits made during Rename/Create.
Global tap controls preserve unsent values across another action, a pending
metadata read, and the completion of an older tap Save before Refresh.
Pending Create also preserves a later explicit macro selection and its JSON
draft, while the unchanged automatic-selection control still opens a new
macro when no later selection was made.
Run build and lint separately with `npm --prefix web run build` and
`npm --prefix web run lint` in the prepared container.

## Additional playback completion controls

`tests/playback` retains 33-tap press/release recovery under queue pressure and
checks busy-state retention behind an unrelated 500 ms queued wait. It links the
actual DYA behavior queue, emits a required completion marker and is repeated
three times by the native verifier. `tests/review` retains 32/33/64-tap producer
controls, packed/nonpacked default waits and 31/32/33-byte real nanopb name bounds.
The canonical owner entry dispatches these alongside all existing assertions.

## Persistent rename integration and coverage boundaries

`test_persist_rename_recovery()` in the existing checked registry fixture uses
the selected Custom Settings implementation and controlled settings backend.
A pre-write `-EIO` must reach the macro caller while the new RAM name remains
dirty at the same slot with exact body bytes. The previous durable blob stays
exact for this backend refusal. Discard reloads the old name; a second refusal
followed by Save persists the new name. The independent global tap value stays
unchanged. This adds coverage of existing behavior, not a production rename fix
or a physical durability claim. Registry event semantics remain the dependency
owner's responsibility.

The `rename-persist-mode` negative control changes only the delegated mode to
MEMORY in an isolated source copy. The checked fixture must fail with
`Persistent rename refusal lost RAM/durable identity: ret=0 attempt=0` and a
nonzero `runtime_macro_test_init` completion in three runs of one binary.
A build failure or unrelated assertion does not qualify.

| Implementation family | Existing owner fixtures and limits |
| --- | --- |
| Name/slot/pool and persistence | `tests/ztest/runtime_macro_test.c`: normal lifecycle, duplicate/invalid/range/capacity refusal, copied names, slot reuse, independent tap scalar, exact body round trips, Save/Discard and rename refusal/recovery. Controlled storage does not establish physical NVS retention or concurrent lifecycle publication. |
| Ordered playback and held releases | `tests/playback`, `tests/queue-pressure`, `tests/review` and `tests/queue-kernel`: 32/33/64 taps, explicit holds, queue pressure, deletion after decode, pre-existing waits, exact ordered edges and released HID state. There is no public abort API or arbitrary behavior-resource cleanup guarantee. |
| Protocol and access gates | `tests/studio` and `tests/rpc-handler`: real nanopb, 64-key packing, malformed stored bodies, locked admission, callback-start unlock check, partial edits/reset, 2048-byte body/frame guard and name/slot wire limits. Mid-stream transport cancellation remains unverified. |
| Time arithmetic and ABI | `tests/test_timeout_width.py`: independent full-width ceiling oracle, 14 rates, both tick forms, optimized/sanitizer/coverage/host-m32 and named numerical/object-width controls. This private arithmetic helper is not used by the current completion-marker player; these results do not measure playback latency. |
| Web request/draft ownership | `tests/web/sessionLifecycle.spec.tsx` and codec fixtures: connection/catalog/lock retirement, timeout/unmount, late replies, independent selection/body/JSON/name/tap drafts, validated full-prefix writes and failure recovery. Controlled DOM/RPC results do not establish browser/device delivery or rollback of dispatched requests. |

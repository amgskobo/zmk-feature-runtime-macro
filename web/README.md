# Runtime Macro Web UI

React + TypeScript UI for editing runtime macros over the custom Studio RPC subsystem `cormoran__runtime_macro`.

Run these entries inside a prepared Docker environment from `web/`; keep
installed dependencies and build outputs in the container or a named volume.

```bash
npm ci
npm run generate
npm test
npm run build
```

The protobuf schema is defined in `../proto/cormoran/runtime_macro/runtime_macro.proto`.

The UI edits macro names and compact encoded macro bodies. It can import/export the supported Keyboard Abyss macro step subset: `down`, `up`, `tap`, and `delay`.

## Console privacy

The local Vite plugin replaces the two locked Studio SDKs' exception log
arguments with fixed error categories. Messages, stacks, causes, device/profile
names and arbitrary error names are not SDK console arguments. New SDK console
sites stop the build for privacy review. Excluding the SDKs from development
prebundling applies the same transform in development and production. Transport,
exception propagation and visible UI messages are preserved. Browser/framework
diagnostics and unrelated browser extensions remain separate domains.

## Dependency security

`package.json` overrides the Studio client's transitive `protobufjs` dependency
to `7.6.5`, including the patched UTF-8 helper. Use `npm ci` with this lockfile.
After changing dependencies, run `npm audit --omit=dev`, the Web tests and the
production build.

## Editor request lifetime

Changing the connection or discovered subsystem catalog starts a fresh editor
and retires pending work. Late responses cannot restore an old form or continue
its remaining step writes. The latest selection owns the displayed body, and
finishing another read does not enable writes while an earlier write is pending.
Every request has a five-second deadline that is cleared on completion,
replacement or unmount.

Core lock notifications retire pending calls synchronously and clear the editor
body and drafts. Unlock starts a different request lifetime and reloads a fresh
editor; a previous write cannot send its remaining resize/append operations.
This includes a lock and unlock delivered before the next React render. The
request already dispatched may have modified the keyboard.

A request already sent may still modify the device. Full body updates clear
the old steps in memory and append the new steps; only the completed body is
persisted by Save. Intermediate prefixes fit within the final body's action
and byte budgets. These separate RPCs have no transaction rollback; reread after reconnect or
failure before retrying. Session retirement provides no device-side cancellation.

Rename and refresh keep the current macro's unsubmitted body and JSON draft.
An older read or save completion does not replace edits made while it was
pending. Selecting another macro or replacing the connection retires that
editor as before. Save submits the version present when it was pressed.
Name, next-creation-name and global tap edits have independent ownership too;
metadata reads and successful older requests preserve newer field drafts.
Completing Create opens its new macro only when the user has not selected
another macro since that request started.

Invalid edits show an error and keep the editor available for correction. Delay
steps accept integer milliseconds from 0 through 60000; tap duration accepts
0 through 10000. Binding and packed-key validation runs before any body resize.
The binary decoder separately rejects uint32 overflow without narrowing valid
uint32 values. Owner fixtures in `../tests/web/` cover these boundaries and
session behavior; `bash tests/run-web.sh` from the repository root runs them.

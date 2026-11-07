# Runtime Macro Web UI

React + TypeScript UI for editing runtime macros over the custom Studio RPC subsystem `cormoran__runtime_macro`.

Run these entries inside a prepared Docker environment from `web/`; keep
installed dependencies and build outputs in the container or a named volume.

```bash
npm ci
npm run generate
npm test
npm run build
npm run lint
```

The protobuf schema is defined in `../proto/cormoran/runtime_macro/runtime_macro.proto`.

The UI edits macro names and compact encoded macro bodies. It can import/export the supported Keyboard Abyss macro step subset: `down`, `up`, `tap`, and `delay`.

## Console privacy

`src/installConsolePrivacy.ts` installs the runtime console guard before the
application starts, in development and production. It wraps debug, log, info,
warn and error. A first string argument is preserved as a fixed label; later
strings are redacted and errors become fixed categories. Plain-object keys stay
visible while their values are processed by the same bounded redaction rule.
`../tests/web/sdkConsole.spec.ts` parses the two locked SDKs' shipped JavaScript
and requires the five reviewed console sites with literal first labels. A new
or changed site fails that test for review. Transport, exception propagation and
visible UI messages remain unchanged. These checks do not establish privacy for
arbitrary first labels, browser/framework diagnostics or unrelated extensions.

## Dependency security

`package.json` overrides the Studio client's transitive `protobufjs` dependency
to `7.6.5`, including the patched UTF-8 helper. Use `npm ci` with this lockfile.
After changing dependencies, run both `npm audit` and `npm audit --omit=dev`,
retain their separate outputs, and run the Web tests, production build and lint.
The production-only audit omits development tools. Compatible transitive updates
keep the declared direct tools, Studio SDK/hook commits and protobuf override
unchanged; they do not clear the remaining full-audit findings in the selected
Jest and TypeScript ESLint dependency chains. Review any tool or incompatible
dependency update separately instead of using `npm audit fix --force`.

## Editor request lifetime

Changing the connection or discovered subsystem catalog starts a fresh editor
and retires pending work. Late responses cannot restore an old form or continue
its remaining step writes. The latest selection owns the displayed body, and
finishing another read does not enable writes while an earlier write is pending.
Every request has a five-second deadline that is cleared on completion,
replacement or unmount.

Replies must contain exactly the success message for the requested operation;
the global-settings reply also needs its settings submessage. Empty, unknown,
wrong-operation and ambiguous success envelopes are errors. A rejected catalog
reply preserves the current list and draft, and rejected global settings retain
the previous global metadata. Mutations require a status reply before the
editor confirms success or refreshes. Empty or whitespace-only server errors
have a visible fallback message. An invalid reply cannot undo a request already
accepted by the keyboard; reread before retrying after a protocol failure.

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

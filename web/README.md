# Runtime Macro Web UI

React + TypeScript UI for editing runtime macros over the custom Studio RPC subsystem `cormoran__runtime_macro`.

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

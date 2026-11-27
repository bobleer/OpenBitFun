# native-ui

Cargo package: `openbitfun-native-ui`. Compiles a `NativeUI` card, a TSX module
the Agent writes, into the card factory the NSH clients run:
`(function (__rt, __nsh, __base, __plot, __kit) { ...; return Card; })`.

## Boundaries

- Pure in memory: oxc parses and strips types; JSX becomes the same
  fine-grained `nsh:rt` calls the NSH bundler emits (a getter per dynamic
  prop, a thunk per dynamic child). No file, network or process IO.
- Imports are limited to `nsh`, `nsh/base`, `nsh/base/plot` and the client kit
  `openbitfun/genui` (`KIT_EXPORTS`). Errors name the line and what to change,
  because the model that wrote the source reads them.
- The factory format (`FORMAT`) and `KIT_API` are a cross-version contract:
  transcripts keep factories, so kit exports are additive and a new format is a
  new identifier that older clients show as unsupported.

## Verification

```bash
cargo test -p openbitfun-native-ui
node scripts/generate-genui-kit.mjs --check
```

# Test profile

`profile.ml` is MyLifeOrganized's own demo profile — the sample data MLO ships
for new users ("Business and Career", "Project X1", …). No personal data; safe
to publish. It has two jobs:

- **Source fixture for the real-exe tests:** the `mlo` test project
  (`pnpm test:mlo`) copies it to a temp directory per run and never touches the
  original (`mcp-server/test/mlo/helpers.ts`).
- **Development data file:** when `MLO_DATA_FILE` is unset, the server defaults
  to this file in repo checkouts (`mcp-server/src/config.ts`), so `pnpm dev` and
  agent sessions exercise the demo tree instead of a real profile.

`export.xml` is the reference `-saveXML` export of `profile.ml` — the
ground-truth example of the XML schema documented in `docs/xml-format.md`.
`mcp-server/test/fixtures/export.xml` is a copy of it used by the unit tests.

Some tests assert specific demo captions ("Business and Career",
"PMI certification", "Finish the presentation") — keep those tasks present if
you edit the profile. To regenerate the exports after changing it (close MLO
first; `-saveXML` never overwrites, so delete the targets):

```powershell
& "C:\Program Files (x86)\MyLifeOrganized.net\MLO\mlo.exe" profile.ml -saveXML="export.xml" -console
Copy-Item export.xml ..\mcp-server\test\fixtures\export.xml
```

`profile.ml.bak-*` files are write-pipeline backups (the MCP server drops one
next to the data file on every write). They are git-ignored and safe to delete.

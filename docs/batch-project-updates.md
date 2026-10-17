# Batch IEC source editing (preview → apply)

This branch is **stacked** on `feat/codesys-iec-objects-and-snapshots`
(PR #3), which depends on PR #2 and PR #1. Review and merge
those branches in dependency order before merging this feature.

## New tools

- `preview_project_changes`: read 1–20 existing IEC objects (POU, GVL, DUT,
  Method, Property), resolve their exact paths, and return the original and
  proposed source contents plus SHA-256 hashes. Does not intentionally save.
- `apply_project_changes`: require the original project SHA-256 and every
  modified code section's SHA-256 from the preview. Refuse stale input,
  create one verified backup, validate *every* object before writing any
  section, perform all edits in one CODESYS script, read back the edits,
  optionally compile, and save **once**.

Only existing textual IEC objects can be updated. Creating/deleting objects,
device tree editing, online downloads and PLC write/force actions are not
part of this feature.

## Example: Preview

Call `preview_project_changes`:

```json
{
  "projectFilePath": "D:/PLC/Machine.project",
  "changes": [
    {
      "action": "update",
      "objectType": "POU",
      "path": "Application/FB_Axis",
      "implementationCode": "// Updated motion logic"
    },
    {
      "action": "update",
      "objectType": "GVL",
      "path": "Application/GVL_Motion",
      "declarationCode": "VAR_GLOBAL\n    xReady : BOOL;\nEND_VAR"
    }
  ]
}
```

The response contains `projectSha256` and an array of object changes, each
with `sections.declaration` and/or `sections.implementation`. Each section
contains `beforeCode`, `afterCode`, `beforeSha256`, `afterSha256`,
lengths and a `changed` flag. Inspect the preview before applying.

## Apply

Call `apply_project_changes` with the *same* edits and the exact original
hashes from preview. This example uses placeholders for the hash strings;
replace them with real 64-character hexadecimal values:

```json
{
  "projectFilePath": "D:/PLC/Machine.project",
  "expectedProjectSha256": "<64-char sha256 from preview>",
  "compileAfterApply": true,
  "changes": [
    {
      "objectType": "POU",
      "path": "Application/FB_Axis",
      "implementationCode": "// Updated motion logic",
      "expectedImplementationSha256": "<original section hash>"
    },
    {
      "objectType": "GVL",
      "path": "Application/GVL_Motion",
      "declarationCode": "VAR_GLOBAL\n    xReady : BOOL;\nEND_VAR",
      "expectedDeclarationSha256": "<original section hash>"
    }
  ]
}
```

`compileAfterApply` is **true by default**. The CODESYS message store is
queried after attempting to clear old messages and performing the build.
Missing or unreadable compiler diagnostics, unrecognized severity values and
nonzero compiler error counts **prevent the explicit project save**.
`compileAfterApply: false` allows saving without verifying compilation;
only use this consciously, e.g. while editing unfinished project code.

All edits are performed in one script invocation, not 20 separate IDE
launches. The call may take up to 4 minutes. Each distinct project uses an
exclusive `*.codesys-mcp.lock` file to refuse overlapping *batch* operations.
Other CODESYS tools, external editors and independently running processes do
not necessarily honor that lock.

## Safety and limits

- One SHA-256 verified project-file backup is created in
  `.codesys-mcp-backups/` **before** every apply.
- The original project and modified source hashes must match their preview.
- The system checks all paths and sections before attempting a write.
- Direct descendant traversal follows a unique first path component. Ambiguous
  paths and duplicate targets fail; path labels such as `objectType` are not
  proof of the actual IEC object class.
- If one change fails *after* writing has begun, CODESYS may have partial
  in-memory modifications. The tool does **not** automatically restore a
  `.project` file or claim a transactional rollback.
- On compilation failure, no explicit save is called, but there may be
  other CODESYS side effects. Inspect the returned `failurePhase` and backup
  path, close any affected CODESYS sessions, and restore files manually after
  confirming they are not in use.
- The lock remains if the Node process crashes. Confirm no CODESYS or batch
  job is running before manually removing a stale lock.
- The preview version hash covers the on-disk file, while section hashes catch
  changes in the IDE object model. Unsaved unrelated objects may not be
  detected; use a disposable, consistently saved test project.
- Backups are binary file copies, not full CODESYS project archives or a
  database transaction. No automatic production-equipment rollback is implied.

## Validation before use

`npm test` runs the TypeScript compiler and tests input validation, source
hashes, lock coordination, Unicode payload encoding, preview-only behavior,
backups, and failure reporting.

**CODESYS V3.5 SP21 integration has not been verified.** On Windows, test a
disposable project with (1) a valid two-POU update, (2) stale file hash,
(3) stale source-section hash, (4) missing POU, (5) a deliberate ST compile
error, (6) Unicode comments, and (7) a forced timeout. Inspect the project
contents and backup for every failure. Do not test on a live industrial
machine before validating the exact Scripting Engine version and behavior.

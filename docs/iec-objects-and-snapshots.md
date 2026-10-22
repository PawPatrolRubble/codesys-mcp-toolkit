# IEC object and safe project operations

This work is **stacked** on the read/build branch (draft PR #2), which is
stacked on the safety branch (draft PR #1). Do not merge the feature branch
directly into main before reviewing and verifying its dependencies.

## New MCP tools

| Tool | Purpose |
|---|---|
| `create_gvl` | Create a global variable list under a project/application/folder |
| `create_dut` | Create a STRUCT, ENUM, Union or Alias (Alias requires `baseType`) |
| `create_interface` | Create an IEC interface |
| `create_persistent_vars` | Create a persistent GVL |
| `create_project_snapshot` | Create a verified local project backup |
| `preview_pou_code_change` | Read a POU and preview exact before/after source sections |
| `list_libraries` | List installed references on the selected library-manager parent |
| `add_library` | Reference one unambiguously matching installed CODESYS library |
| `remove_library` | Remove an exact listed reference, requiring `confirmRemoval: true` |

The existing `set_pou_code` operation now also creates a backup before
modifying its target.

## Snapshot semantics

A snapshot is a binary copy of the existing `.project` file saved under
`.codesys-mcp-backups/` beside the source, with a unique name and SHA-256
checksum. The source file is not overwritten. Snapshot creation rejects symlinks
and unsupported file extensions.

**Important:** These are file-level backups, not transactional CODESYS project
archives. They do not provide transaction rollback, and there is no automatic
restore in this PR. Close or save the project consistently before relying on a
snapshot. Multiple independent MCP server processes can still conflict.

## Examples

Create a global variable list:

```json
{"projectFilePath":"C:/Projects/Machine.project",
 "parentPath":"Application","name":"GVL_Motion"}
```

Create an enum data type:

```json
{"projectFilePath":"C:/Projects/Machine.project",
 "parentPath":"Application","name":"E_CylinderState",
 "dutType":"Enumeration"}
```

Before modifying existing ST code, call `preview_pou_code_change` with the
new declaration and/or implementation. Omitted sections remain untouched.
The preview does not modify the CODESYS project.

For `remove_library`, first list exact names with `list_libraries` and pass
`confirmRemoval: true` explicitly.

## Required integration validation

These tools have no actual CODESYS V3.5 SP21 Scripting Engine tests yet.
Validate against a **disposable** offline project: create each type; inspect
the project tree; compile; verify backup bytes; add/list/remove an installed
test library; and confirm malformed paths and duplicate objects fail without
modifying the test project.

Do not automate PLC download, start/stop or online forcing using this branch.

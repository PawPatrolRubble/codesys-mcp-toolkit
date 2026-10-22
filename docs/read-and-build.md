# Read-only CODESYS tools and compile diagnostics

This feature branch is stacked on `fix/codesys-mcp-safety-and-phase-a` (draft PR #1).
Review and merge the safety fixes first. Retarget this PR to `main` after PR #1
merges, or allow GitHub to update the base automatically.

## MCP tools

### `get_pou_code`

Inputs: `projectFilePath`, `pouPath` (for example `Application/FB_Axis`).
Returns JSON with `name`, `path`, `declaration` and `implementation`.
Nullable fields mean that the object has no textual section. Read errors are
reported as MCP errors, not returned as example code.

### `get_project_structure`

Inputs: `projectFilePath`, optional `maxDepth` (default 12, maximum 25)
and `maxObjects` (default 1000, maximum 3000).
Returns a bounded hierarchical JSON object with a `truncated` flag.
The tool is read-only.

### `compile_project`

Returns JSON containing `status` (`success`, `failed`, `unverified`),
`application`, error/warning counts, messages (severity/category/object/
position/text), and any failures to read message categories.

- Build errors or fatal errors cause an MCP error.
- Incomplete, inconsistent, or unavailable diagnostics also cause an MCP error.
- Compiler warnings are returned without marking a verified zero-error build as failed.
- Messages are collected from CODESYS message categories after `build()`;
  older messages from the current IDE instance or noncompiler categories may be
  present. These are conservatively treated as errors rather than ignored.
  Category-specific clearing and before/after attribution are future improvements.
- This executes the CODESYS executable using its Scripting Engine. It is **not**
  a PLC online command, nor a substitute for testing the control logic.

## Validation

`npm test` compiles TypeScript and runs Node-based regression tests against
the diagnostic parser, Unicode handling and missing-output cases.

CODESYS V3.5 SP21 integration is **not yet tested**. Before relying on these
tools, open a disposable project on Windows, compile a known-good program,
then introduce a deliberate ST syntax error and confirm the exact message,
location and `isError` result. Also test a project with Chinese comments.

Do not use these changes to download, start or control a live industrial machine.

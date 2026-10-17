# IDE Attached bridge — SP21-compatible first version

This branch is stacked on PR #4. It implements a deliberately **user-triggered**
bridge to an already-running CODESYS IDE. No new IDE process is launched.

## Why manual triggering?

CODESYS Scripting Engine APIs have UI-thread requirements. Older implementations
used the system.execute_on_primary_thread API; reports indicate it is unavailable
on some SP21 installations. Long-running Python loops can restrict the IDE UI.
This first version therefore runs a bounded script on the IDE thread each time
the user explicitly invokes it. Always-on automation requires a supported IDE
extension and version-specific integration testing.

## Setup on Windows

1. Start the MCP server with --workspace pointing to the directory containing
   the intended Machine.project. Open Machine.project in CODESYS IDE.
2. Call **ide_bridge_setup**. It creates:
   .codesys-mcp/ide-bridge/execute_pending.py
   .codesys-mcp/ide-bridge/secret.key
   .codesys-mcp/ide-bridge/requests/
   .codesys-mcp/ide-bridge/results/
3. Call **ide_preview_project_changes** with projectFilePath and changes.
   This queues a signed preview request and returns a request id and script path.
4. In the SAME CODESYS IDE, choose Tools > Scripting > Execute Script File,
   and open the generated execute_pending.py file. It handles up to 10
   pending requests and terminates; it never keeps the UI occupied polling.
5. Call **ide_get_bridge_result** with the request id. Inspect each section's
   beforeCode, afterCode, and beforeSha256.
6. Call **ide_apply_project_changes** with the same changes plus each
   expectedDeclarationSha256 or expectedImplementationSha256 from the preview.
7. Run execute_pending.py again from the same IDE. Retrieve the result with
   **ide_get_bridge_result**, inspect the updated ST source in the IDE,
   compile from the IDE and **manually save** the project if approved.

Example preview request:

    {
      "projectFilePath": "Machine.project",
      "changes": [
        {
          "objectType": "POU",
          "path": "Application/FB_Axis",
          "implementationCode": "xReady := TRUE;"
        }
      ]
    }

Apply request: identical object/path/new code, plus the exact
"expectedImplementationSha256" from the preview's "beforeSha256" field.

## Safety properties and limitations

- The bridge accesses **scriptengine.projects.primary** in the IDE executing
  the script. The actual project path MUST match the queued request.
- Preview and apply operate against in-memory source, including currently
  unsaved edits. Every apply checks the original section hashes first.
- The script preflights all objects before changing any. If a replacement
  fails mid-batch it attempts best-effort in-memory restoration, reporting
  any restoration failures. No atomic rollback is promised.
- Edits intentionally remain UNSAVED. No PLC download, login, start, stop,
  force, compile or file-level project overwrite is performed by the bridge.
- Request envelopes and responses use HMAC-SHA256 with a local 32-byte
  random secret. Requests expire after 10 minutes and have bounded payloads.
  Keep the .codesys-mcp directory private; its secret is a local credential.
- Incoming messages contain only structured IEC edits, not executable Python.
- An IDE command only processes requests if the user runs the bridge script.
  To reduce clicks, configure the script as an IDE toolbar/menu shortcut.
- This first version updates existing textual POU, GVL, DUT, method and
  property sections. It cannot create/delete objects via the IDE yet.
- Target project must lie under the MCP --workspace directory. Adjust
  --workspace if projects live elsewhere.
- Standalone/headless tools remain separate. IDE Attached errors do NOT
  cause silent fallback to a second CODESYS instance.
- If the IDE project contains unsaved edits, a disk-only backup would not
  capture them. This bridge does not pretend otherwise.

## Verification

Run npm ci then npm test. The regression suite executes the exact generated
bridge Python script with a mock scriptengine.projects.primary object. It
verifies Unicode source read/write, stale hashes, wrong active project,
request tampering, result tampering, and non-saving behavior.

**Real CODESYS V3.5 SP21 integration remains unverified.** First test on a
disposable local project. Confirm the created script can be invoked through
Tools > Scripting, returns authenticated results, changes the visible POU,
does not write the .project file, and leaves manual IDE Save available.

## Future fully automatic IDE mode

Implement an IDE add-in using the CODESYS Automation Platform extension SDK,
with a local IPC listener and proper UI-thread dispatch. That is distinct
from a Python polling loop and requires testing with the exact CODESYS build.

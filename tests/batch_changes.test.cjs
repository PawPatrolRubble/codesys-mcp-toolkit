const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
    prepareBatchChanges, buildBatchScript, sha256, withProjectLock,
    hashProjectFile, executeBatchOperation
} = require("../dist/batch_operations.js");

const minimal = { path: "Application/FB_Axis", objectType: "POU", implementationCode: "x := TRUE; // 中文" };
const fakeEnsure = 'import os\nPROJECT_FILE_PATH = __import__("base64").b64decode("{PROJECT_FILE_PATH}").decode("utf-8")';

async function withTemporaryProject(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codesys-batch-test-"));
    const project = path.join(dir, "Machine.project");
    await fs.writeFile(project, Buffer.from("fake CODESYS project binary\0", "utf8"));
    try {
        return await fn(project, dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}
function parseRecord(output, marker) {
    const record = output.split(/\r?\n/).filter(x => x.startsWith(marker));
    if (record.length !== 1) throw Error("Missing or repeated result record");
    return JSON.parse(record[0].slice(marker.length));
}
const withHash = {
    ...minimal, expectedImplementationSha256: sha256("old IEC implementation")
};
function fakeReport(mode, projectHash, changes, overrides = {}) {
    return {
        mode, status: mode === "apply" ? "saved" : "preview",
        project: "Machine.project", saved: mode === "apply",
        projectSha256: projectHash, projectSha256After: projectHash,
        changes: changes.map(c => ({
            path: c.path, objectType: c.objectType,
            sections: {
                implementation: {
                    beforeSha256: sha256("old IEC implementation"),
                    afterSha256: sha256(c.implementationCode ?? ""),
                    beforeLength: 22, afterLength: (c.implementationCode ?? "").length,
                    changed: true,
                    beforeCode: "old IEC implementation",
                    afterCode: c.implementationCode
                }
            }
        })), ...overrides
    };
}
test("rejects duplicate IEC paths, including case-insensitive aliases", () => {
    assert.throws(() => prepareBatchChanges([minimal, {...minimal,path:"application\\fb_axis"}], "preview"), /Repeated/);
});
test("rejects missing updates, invalid paths, and unsupported object type", () => {
    assert.throws(() => prepareBatchChanges([{objectType:"POU",path:"Application/FB"}], "preview"), /No code/);
    assert.throws(() => prepareBatchChanges([{...minimal,path:"Application/../FB"}], "preview"), /Invalid IEC/);
    assert.throws(() => prepareBatchChanges([{...minimal,objectType:"Runtime"}], "preview"), /Invalid IEC/);
});
test("rejects more than twenty changes", () => {
    assert.throws(() => prepareBatchChanges(Array(21).fill(minimal), "preview"), /1–20/);
});
test("preview needs no expected hashes; apply needs a source hash for every written section", () => {
    assert.equal(prepareBatchChanges([minimal], "preview").length, 1);
    assert.throws(() => prepareBatchChanges([minimal], "apply"), /expectedImplementationSha256/);
    assert.doesNotThrow(() => prepareBatchChanges([withHash], "apply"));
    assert.throws(() => prepareBatchChanges([{
        ...withHash, declarationCode:"VAR END_VAR"
    }], "apply"), /expectedDeclarationSha256/);
});
test("batch Python script base64-encodes all proposed ST and Unicode input", () => {
    const python = buildBatchScript(fakeEnsure, "C:\\PLC\\设备.project",
        {mode:"preview",changes:[minimal]});
    assert.doesNotMatch(python, /x := TRUE; \/\/ 中文/);
    assert.doesNotMatch(python, /设备\.project/);
    assert.match(python, /#|import sys, os, json, hashlib/);
    const request = python.match(/REQUEST = json\.loads\(base64\.b64decode\("([^"]+)"\)/);
    assert.ok(request);
    const payload = JSON.parse(Buffer.from(request[1], "base64").toString("utf8"));
    assert.equal(payload.changes[0].implementationCode, minimal.implementationCode);
});
test("generated CODESYS Python is syntactically valid", t => {
    const script = buildBatchScript(fakeEnsure, "C:/PLC/Test.project",
        {mode:"apply", expectedProjectSha256:"a".repeat(64), changes:[withHash]});
    const run = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
        {input:script,encoding:"utf8"});
    if (run.error?.code === "ENOENT") return t.skip("python3 unavailable on this workstation");
    assert.equal(run.status, 0, run.stderr);
});
test("batch lock prevents a second writer and cleans up after failure", async () => {
    await withTemporaryProject(async file => {
        await withProjectLock(file, async () => {
            await assert.rejects(() => withProjectLock(file, async () => 1), /locked/);
        });
        await assert.rejects(() => withProjectLock(file, async () => { throw Error("intentional"); }), /intentional/);
        await withProjectLock(file, async () => {});
        await assert.rejects(() => fs.stat(file + ".codesys-mcp.lock"), {code:"ENOENT"});
    });
});
test("preview does not create a backup or mutate the project", async () => {
    await withTemporaryProject(async file => {
        const hash = await hashProjectFile(file);
        let executed = 0;
        const answer = await executeBatchOperation(file, {mode:"preview",changes:[minimal]},
            fakeEnsure, async () => {
                executed++;
                return {success:true, output:"MCP_BATCH_JSON:" +
                    JSON.stringify(fakeReport("preview", hash, [minimal])) +
                    "\nSCRIPT_SUCCESS: Batch operation completed."};
            }, parseRecord);
        assert.equal(answer.isError, false, answer.text);
        assert.equal(executed, 1);
        assert.equal(await hashProjectFile(file), hash);
        await assert.rejects(() => fs.stat(path.join(path.dirname(file),".codesys-mcp-backups")), {code:"ENOENT"});
    });
});
test("apply creates exactly one verified project backup", async () => {
    await withTemporaryProject(async file => {
        const hash = await hashProjectFile(file);
        let invoked = 0;
        const answer = await executeBatchOperation(file, {
            mode:"apply",changes:[withHash],expectedProjectSha256:hash,
            compileAfterApply:false
        }, fakeEnsure, async (script, timeout) => {
            invoked++;
            assert.equal(timeout, 240000);
            return {success:true, output:"MCP_BATCH_JSON:" +
                JSON.stringify(fakeReport("apply", hash, [withHash])) +
                "\nSCRIPT_SUCCESS: Batch operation completed."};
        }, parseRecord);
        assert.equal(answer.isError, false, answer.text);
        assert.equal(invoked, 1);
        const record = JSON.parse(answer.text);
        assert.equal(record.backupSha256, hash);
        assert.equal(sha256(await fs.readFile(record.backup)), hash);
    });
});
test("file-hash mismatch prevents both backup and execution", async () => {
    await withTemporaryProject(async file => {
        let invoked = false;
        const answer = await executeBatchOperation(file, {
            mode:"apply",changes:[withHash],expectedProjectSha256:"0".repeat(64)
        }, fakeEnsure, async () => {invoked = true; throw Error("must not execute");}, parseRecord);
        assert.equal(answer.isError, true);
        assert.equal(invoked, false);
        await assert.rejects(() => fs.stat(path.join(path.dirname(file),".codesys-mcp-backups")), {code:"ENOENT"});
    });
});
test("failed apply reports original backup without claiming that a rollback happened", async () => {
    await withTemporaryProject(async file => {
        const hash = await hashProjectFile(file);
        const answer = await executeBatchOperation(file, {
            mode:"apply",changes:[withHash],expectedProjectSha256:hash
        }, fakeEnsure, async () => ({
            success:false, output:"MCP_BATCH_JSON:" + JSON.stringify(fakeReport(
                "apply", hash, [withHash], {saved:false,status:"failed",failurePhase:"compiling",error:"Bad ST"}
            )) + "\nSCRIPT_ERROR: failed"
        }), parseRecord);
        assert.equal(answer.isError, true);
        const result = JSON.parse(answer.text);
        assert.equal(result.saved, false);
        assert.equal(result.failurePhase, "compiling");
        assert.equal(result.backupSha256, hash);
    });
});

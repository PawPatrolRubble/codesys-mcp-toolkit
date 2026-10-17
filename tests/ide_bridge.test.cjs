const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sha256 } = require("../dist/batch_operations.js");
const {
    bridgeLocation, setupIdeBridge, queueIdeRequest,
    getIdeResult, readAuthenticatedPayload
} = require("../dist/ide_bridge.js");

const PY_AVAILABLE = spawnSync("python3", ["--version"], {encoding:"utf8"}).status === 0;
const ORIGINAL = "x := FALSE; // 中文注释";
const UPDATED = "x := TRUE; // AI change";

const MOCK_SCRIPT_ENGINE = [
"import os, json",
"state_file = os.environ['CODESYS_MOCK_STATE']",
"with open(state_file, 'r', encoding='utf-8') as src: state = json.load(src)",
"class TextSection:",
"    @property",
"    def text(self): return state['implementation']",
"    def replace(self, content):",
"        state['implementation'] = content",
"        with open(state_file, 'w', encoding='utf-8') as dest: json.dump(state, dest)",
"class Object:",
"    def __init__(self, name, children=None):",
"        self._name = name",
"        self._children = children or []",
"    def get_name(self): return self._name",
"    def get_children(self, recursive):",
"        if not recursive: return self._children",
"        result = []",
"        for child in self._children:",
"            result.append(child)",
"            result.extend(child.get_children(True))",
"        return result",
"class POU(Object):",
"    def __init__(self):",
"        super().__init__('FB_Axis')",
"        self.textual_implementation = TextSection()",
"fb = POU()",
"app = Object('Application', [fb])",
"class Project(Object):",
"    def __init__(self):",
"        super().__init__('Machine', [app])",
"        self.path = os.environ['CODESYS_MOCK_PROJECT']",
"    def save(self): raise AssertionError('IDE bridge must not save project')",
"class Projects:",
"    primary = Project()",
"projects = Projects()"
].join("\n");

async function fixture(work) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codesys-ide-bridge-"));
    const project = path.join(workspace, "Machine.project");
    const stateFile = path.join(workspace, "fake-ide-state.json");
    const mockEngine = path.join(workspace, "scriptengine.py");
    try {
        await fs.writeFile(project, "FAKE CODESYS FILE");
        await fs.writeFile(stateFile, JSON.stringify({ implementation: ORIGINAL }));
        await fs.writeFile(mockEngine, MOCK_SCRIPT_ENGINE);
        const location = await setupIdeBridge(workspace);
        await work({workspace, project, stateFile, location});
    } finally {
        await fs.rm(workspace, { recursive:true, force:true });
    }
}
function execIde({workspace,project,stateFile,location}) {
    const p = spawnSync("python3", [location.script], {
        encoding:"utf8", cwd:workspace, env:{
            ...process.env, PYTHONPATH:workspace, CODESYS_MOCK_STATE:stateFile, CODESYS_MOCK_PROJECT:project
        }
    });
    assert.equal(p.status, 0, p.stderr + "\n" + p.stdout);
    return p.stdout;
}
function proposed(newCode = UPDATED) {
    return [{objectType:"POU",path:"Application/FB_Axis",implementationCode:newCode}];
}

test("setup generates one-shot script and stable local secret", async () => {
    await fixture(async ({workspace,location}) => {
        const key1 = await fs.readFile(path.join(location.directory,"secret.key"));
        assert.equal(key1.length, 32);
        const py = await fs.readFile(location.script,"utf8");
        assert.match(py,/CODESYS MCP IDE bridge processed/);
        assert.doesNotMatch(py,/__BRIDGE_DIR_B64__/);
        await setupIdeBridge(workspace);
        const key2 = await fs.readFile(path.join(location.directory,"secret.key"));
        assert.deepEqual(key1,key2);
    });
});

test("IDE preview reads current unsaved in-memory code and does not save", {skip:!PY_AVAILABLE}, async () => {
    await fixture(async f => {
        const queued = await queueIdeRequest(f.workspace,f.project,"preview",proposed());
        assert.equal((await getIdeResult(f.workspace,queued.id)).state,"pending");
        execIde(f);
        const done = await getIdeResult(f.workspace,queued.id);
        assert.equal(done.state,"completed");
        assert.equal(done.ok,true,done.error);
        assert.equal(done.result.status,"preview");
        assert.equal(done.result.saved,false);
        const section = done.result.changes[0].sections.implementation;
        assert.equal(section.beforeCode,ORIGINAL);
        assert.equal(section.afterCode,UPDATED);
        assert.equal(section.beforeSha256,sha256(ORIGINAL));
        assert.equal((await fs.readFile(f.stateFile,"utf8")).includes(ORIGINAL),true);
    });
});

test("IDE apply checks preview source hash and leaves changes unsaved", {skip:!PY_AVAILABLE}, async () => {
    await fixture(async f => {
        const cmd = proposed().map(x=>({...x,expectedImplementationSha256:sha256(ORIGINAL)}));
        const queued = await queueIdeRequest(f.workspace,f.project,"apply",cmd);
        execIde(f);
        const result = await getIdeResult(f.workspace,queued.id);
        assert.equal(result.ok,true,result.error);
        assert.equal(result.result.status,"applied_unsaved");
        assert.equal(result.result.saved,false);
        const state = JSON.parse(await fs.readFile(f.stateFile,"utf8"));
        assert.equal(state.implementation, UPDATED);
        assert.equal(await fs.readFile(f.project,"utf8"),"FAKE CODESYS FILE");
    });
});

test("stale source precondition refuses IDE apply", {skip:!PY_AVAILABLE}, async () => {
    await fixture(async f => {
        const queued=await queueIdeRequest(f.workspace,f.project,"apply",[
            {...proposed()[0],expectedImplementationSha256:"0".repeat(64)}
        ]);
        execIde(f);
        const result = await getIdeResult(f.workspace,queued.id);
        assert.equal(result.ok,false);
        assert.match(result.error,/Stale source/);
        assert.equal(JSON.parse(await fs.readFile(f.stateFile,"utf8")).implementation,ORIGINAL);
    });
});

test("wrong currently-open IDE project refuses all source updates", {skip:!PY_AVAILABLE}, async () => {
    await fixture(async f => {
        const second = path.join(f.workspace,"Other.project");
        await fs.writeFile(second, "SECOND FILE");
        const queued = await queueIdeRequest(f.workspace,second,"apply",[
            {...proposed()[0],expectedImplementationSha256:sha256(ORIGINAL)}
        ]);
        execIde(f);
        const result = await getIdeResult(f.workspace,queued.id);
        assert.equal(result.ok,false);
        assert.match(result.error,/Wrong IDE project/);
        assert.equal(JSON.parse(await fs.readFile(f.stateFile,"utf8")).implementation,ORIGINAL);
    });
});

test("tampered command signature is rejected before any IDE edit", {skip:!PY_AVAILABLE}, async () => {
    await fixture(async f => {
        const queued=await queueIdeRequest(f.workspace,f.project,"apply",[
            {...proposed()[0],expectedImplementationSha256:sha256(ORIGINAL)}
        ]);
        const file=path.join(f.location.directory,"requests",queued.id+".json");
        const envelope=JSON.parse(await fs.readFile(file,"utf8"));
        envelope.signature="0".repeat(64);
        await fs.writeFile(file,JSON.stringify(envelope));
        execIde(f);
        const result = await getIdeResult(f.workspace,queued.id);
        assert.equal(result.ok,false);
        assert.match(result.error,/signature mismatch/);
        assert.equal(JSON.parse(await fs.readFile(f.stateFile,"utf8")).implementation,ORIGINAL);
    });
});

test("response authentication detects tampering", {skip:!PY_AVAILABLE}, async () => {
    await fixture(async f => {
        const cmd=await queueIdeRequest(f.workspace,f.project,"preview",proposed());
        execIde(f);
        const file=path.join(f.location.directory,"results",cmd.id+".json");
        const content=JSON.parse(await fs.readFile(file,"utf8"));
        content.signature="a".repeat(64);
        await fs.writeFile(file,JSON.stringify(content));
        await assert.rejects(()=>getIdeResult(f.workspace,cmd.id),/authentication failed/);
    });
});

test("bridge refuses paths outside the configured workspace",async () => {
    await fixture(async f => {
        await assert.rejects(
            ()=>queueIdeRequest(f.workspace,path.join(path.dirname(f.workspace),"other.project"),"preview",proposed()),
            /inside --workspace/
        );
    });
});

test("bridge is a restricted workflow, not an arbitrary Python command runner",async () => {
    await fixture(async f => {
        const script=await fs.readFile(f.location.script,"utf8");
        assert.doesNotMatch(script,/exec\(|eval\(|execute_on_primary_thread|while True/);
        assert.match(script,/se\.projects\.primary/);
        assert.doesNotMatch(script,/project\.save\(/);
    });
});

test("request signatures are verifiable and cannot be replayed under another id",async () => {
    await fixture(async f => {
        const cmd=await queueIdeRequest(f.workspace,f.project,"preview",proposed());
        const env=await fs.readFile(path.join(f.location.directory,"requests",cmd.id+".json"),"utf8");
        const secret=await fs.readFile(path.join(f.location.directory,"secret.key"));
        const parsed=readAuthenticatedPayload(env,cmd.id,secret);
        assert.equal(parsed.mode,"preview");
        assert.throws(()=>readAuthenticatedPayload(env,"a".repeat(32),secret),/Invalid IDE/);
    });
});

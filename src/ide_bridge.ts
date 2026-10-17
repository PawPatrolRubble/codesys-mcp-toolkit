/**
 * Explicit, authenticated local-file IPC for the already open CODESYS IDE.
 * Never starts another CODESYS instance and never executes Python from requests.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { IDE_BRIDGE_ONCE_PY } from "./ide_bridge_script";
import { prepareBatchChanges, BatchChange } from "./batch_operations";

const REQUEST_ID = /^[a-f0-9]{32}$/;
const MAX_ENVELOPE_BYTES = 8_000_000;
const SHA256 = /^[a-f0-9]{64}$/i;

interface Envelope {
    version: 1;
    id: string;
    payload_b64: string;
    signature: string;
}
export interface BridgeLocation {
    directory: string;
    script: string;
}

export function bridgeLocation(workspace: string): BridgeLocation {
    const root = path.resolve(workspace);
    const directory = path.join(root, ".codesys-mcp", "ide-bridge");
    return { directory, script: path.join(directory, "execute_pending.py") };
}

function ensureProjectWithinWorkspace(workspace: string, projectFile: string): string {
    const root = path.resolve(workspace);
    const full = path.resolve(root, projectFile);
    const relative = path.relative(root, full);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("The IDE project must be inside --workspace. Change the MCP workspace instead.");
    }
    if (!full.toLowerCase().endsWith(".project"))
        throw new Error("IDE Attached currently supports saved .project paths only");
    return full;
}

function makeEnvelope(id: string, payload: unknown, secret: Buffer): Envelope {
    const payload_b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return {
        version: 1,
        id,
        payload_b64,
        signature: createHmac("sha256", secret).update(payload_b64, "ascii").digest("hex")
    };
}

export function readAuthenticatedPayload<T>(text: string, id: string, secret: Buffer): T {
    const env = JSON.parse(text) as Envelope;
    if (env.version !== 1 || env.id !== id || !REQUEST_ID.test(id) ||
        typeof env.payload_b64 !== "string" || typeof env.signature !== "string" ||
        !SHA256.test(env.signature)) throw new Error("Invalid IDE IPC message envelope");
    const expected = Buffer.from(createHmac("sha256", secret)
        .update(env.payload_b64, "ascii").digest("hex"), "hex");
    const actual = Buffer.from(env.signature, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        throw new Error("IDE IPC authentication failed");
    return JSON.parse(Buffer.from(env.payload_b64, "base64").toString("utf8")) as T;
}

async function readSecret(folder: string): Promise<Buffer> {
    const key = await fs.readFile(path.join(folder, "secret.key"));
    if (key.length !== 32) throw new Error("IDE bridge key invalid. Run ide_bridge_setup again.");
    return key;
}

export async function setupIdeBridge(workspace: string): Promise<BridgeLocation> {
    const loc = bridgeLocation(workspace);
    await fs.mkdir(path.join(loc.directory, "requests"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(loc.directory, "results"), { recursive: true, mode: 0o700 });
    const keyPath = path.join(loc.directory, "secret.key");
    try {
        await fs.writeFile(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
    }
    await readSecret(loc.directory);
    // Embed only a bridge-directory path. The runtime key is loaded from secret.key.
    const script = IDE_BRIDGE_ONCE_PY.replace("__BRIDGE_DIR_B64__",
        Buffer.from(loc.directory, "utf8").toString("base64"));
    const tmp = loc.script + "." + randomUUID() + ".tmp";
    await fs.writeFile(tmp, script, { flag: "wx", mode: 0o600 });
    await fs.rename(tmp, loc.script);
    return loc;
}

export async function queueIdeRequest(
    workspace: string,
    projectFilePath: string,
    mode: "preview" | "apply" | "probe",
    changes: BatchChange[] = []
): Promise<{ id: string; state: "queued"; script: string; project: string }> {
    const loc = bridgeLocation(workspace);
    await fs.access(loc.script);
    const secret = await readSecret(loc.directory);
    const project = ensureProjectWithinWorkspace(workspace, projectFilePath);
    const stat = await fs.lstat(project);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Target project must be an existing regular .project file");
    const validated = mode === "probe" ? [] : prepareBatchChanges(changes, mode);
    const id = randomUUID().replace(/-/g, "");
    const request = makeEnvelope(id, {
        mode,
        projectFilePath: project,
        changes: validated,
        expiresAt: Math.floor(Date.now() / 1000) + 600
    }, secret);
    const destination = path.join(loc.directory, "requests", id + ".json");
    const temp = destination + ".tmp";
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized, "utf8") > MAX_ENVELOPE_BYTES)
        throw new Error("IDE IPC request exceeds size limit");
    try {
        await fs.writeFile(temp, serialized, { flag: "wx", mode: 0o600 });
        await fs.rename(temp, destination);
    } catch (e) {
        await fs.unlink(temp).catch(() => undefined);
        throw e;
    }
    return { id, state: "queued", script: loc.script, project };
}

export async function getIdeResult(workspace: string, id: string): Promise<
    { state: "pending"; id: string; script: string } |
    { state: "completed"; id: string; ok: boolean; result?: unknown; error?: string }
> {
    if (!REQUEST_ID.test(id)) throw new Error("Invalid IDE request identifier");
    const loc = bridgeLocation(workspace);
    const file = path.join(loc.directory, "results", id + ".json");
    let content: string;
    try {
        const st = await fs.stat(file);
        if (st.size > MAX_ENVELOPE_BYTES * 3) throw new Error("IDE response exceeds size limit");
        content = await fs.readFile(file, "utf8");
    } catch (e: any) {
        if (e?.code === "ENOENT") {
            await fs.access(path.join(loc.directory, "requests", id + ".json"));
            return { state: "pending", id, script: loc.script };
        }
        throw e;
    }
    const secret = await readSecret(loc.directory);
    const payload = readAuthenticatedPayload<{ ok: boolean; result?: unknown; error?: string }>(content, id, secret);
    if (typeof payload.ok !== "boolean") throw new Error("Invalid IDE result");
    return {
        state: "completed", id, ok: payload.ok,
        result: payload.result, error: payload.error
    };
}

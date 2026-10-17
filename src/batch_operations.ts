import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { BATCH_SCRIPT_TEMPLATE } from "./batch_script";
import { snapshotProject } from "./project_safety";

export type IecObjectType = "POU" | "GVL" | "DUT" | "Method" | "Property";
export interface BatchChange {
    objectType: IecObjectType;
    path: string;
    declarationCode?: string;
    implementationCode?: string;
    expectedDeclarationSha256?: string;
    expectedImplementationSha256?: string;
}
export interface BatchRequest {
    mode: "preview" | "apply";
    changes: BatchChange[];
    expectedProjectSha256?: string;
    compileAfterApply?: boolean;
}
export interface BatchResult {
    mode: string;
    status: string;
    project: string;
    projectSha256?: string;
    projectSha256After?: string;
    saved: boolean;
    changes: Array<{
        path: string;
        objectType: string;
        sections: Record<string, {
            beforeSha256: string;
            afterSha256: string;
            beforeLength: number;
            afterLength: number;
            changed: boolean;
        }>
    }>;
    compile?: unknown;
    failurePhase?: string;
    error?: string;
    backup?: string;
    backupSha256?: string;
}
const SHA_256 = /^[0-9a-f]{64}$/i;
const OBJECT_TYPES = new Set(["POU", "GVL", "DUT", "Method", "Property"]);

export function sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

export function prepareBatchChanges(input: BatchChange[], mode: "preview" | "apply"): BatchChange[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
        throw new Error("Provide 1–20 IEC changes");
    }
    const seen = new Set<string>();
    return input.map((change, index) => {
        if (!change || !OBJECT_TYPES.has(change.objectType))
            throw new Error("Invalid IEC object type at item " + index);
        if (typeof change.path !== "string")
            throw new Error("Invalid object path at item " + index);
        const targetPath = change.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        const segments = targetPath.split("/");
        if (!targetPath || segments.some(x => !x || x === "." || x === ".." || /[\r\n\x00]/.test(x)))
            throw new Error("Invalid IEC path: " + change.path);
        const key = targetPath.toLowerCase();
        if (seen.has(key))
            throw new Error("Repeated IEC target in one batch: " + targetPath);
        seen.add(key);
        const hasDeclaration = change.declarationCode !== undefined;
        const hasImplementation = change.implementationCode !== undefined;
        if (!hasDeclaration && !hasImplementation)
            throw new Error("No code provided for " + targetPath);
        if (hasDeclaration && (typeof change.declarationCode !== "string" || change.declarationCode.length > 200_000))
            throw new Error("Invalid declaration code for " + targetPath);
        if (hasImplementation && (typeof change.implementationCode !== "string" || change.implementationCode.length > 200_000))
            throw new Error("Invalid implementation code for " + targetPath);
        if (mode === "apply") {
            if (hasDeclaration && !SHA_256.test(change.expectedDeclarationSha256 ?? ""))
                throw new Error("expectedDeclarationSha256 from preview is required for " + targetPath);
            if (hasImplementation && !SHA_256.test(change.expectedImplementationSha256 ?? ""))
                throw new Error("expectedImplementationSha256 from preview is required for " + targetPath);
        }
        const result: BatchChange = { objectType: change.objectType, path: targetPath };
        if (hasDeclaration) {
            result.declarationCode = change.declarationCode;
            if (mode === "apply") result.expectedDeclarationSha256 = change.expectedDeclarationSha256;
        }
        if (hasImplementation) {
            result.implementationCode = change.implementationCode;
            if (mode === "apply") result.expectedImplementationSha256 = change.expectedImplementationSha256;
        }
        return result;
    });
}

export function buildBatchScript(ensureSnippet: string, projectFile: string, request: BatchRequest): string {
    if (request.mode !== "preview" && request.mode !== "apply")
        throw new Error("Invalid batch mode");
    const changes = prepareBatchChanges(request.changes, request.mode);
    if (request.mode === "apply" && !SHA_256.test(request.expectedProjectSha256 ?? ""))
        throw new Error("expectedProjectSha256 from preview is required");
    const payload = {
        mode: request.mode,
        expectedProjectSha256: request.mode === "apply" ? request.expectedProjectSha256 : null,
        compileAfterApply: request.mode === "apply" ? request.compileAfterApply !== false : false,
        changes
    };
    if (!ensureSnippet.includes("{PROJECT_FILE_PATH}"))
        throw new Error("Cannot locate project path placeholder in CODESYS template");
    return BATCH_SCRIPT_TEMPLATE
        .replace("{ENSURE_PROJECT_OPEN_SNIPPET}", ensureSnippet)
        .replace("{PROJECT_FILE_PATH}", Buffer.from(projectFile, "utf8").toString("base64"))
        .replace("{BATCH_REQUEST_B64}", Buffer.from(JSON.stringify(payload), "utf8").toString("base64"));
}

export async function hashProjectFile(projectFile: string): Promise<string> {
    const fullPath = path.resolve(projectFile);
    if (path.extname(fullPath).toLowerCase() !== ".project")
        throw new Error("Expected a CODESYS .project file");
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Expected a regular project file, not a symlink");
    return sha256(await fs.readFile(fullPath));
}

export async function withProjectLock<T>(projectFile: string, work: () => Promise<T>): Promise<T> {
    const lockFile = path.resolve(projectFile) + ".codesys-mcp.lock";
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(lockFile, "wx", 0o600);
    } catch (e: any) {
        if (e?.code === "EEXIST")
            throw new Error("Project is locked by another batch request: " + lockFile + ". Check active jobs before manually removing a stale lock.");
        throw e;
    }
    try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        return await work();
    } finally {
        await handle.close();
        await fs.unlink(lockFile).catch(() => undefined);
    }
}

export async function executeBatchOperation(
    projectFile: string,
    request: BatchRequest,
    ensureSnippet: string,
    execute: (script: string, timeoutMs: number) => Promise<{ success: boolean; output: string }>,
    parse: <T>(output: string, marker: string) => T
): Promise<{ isError: boolean; text: string }> {
    try {
        const validated = prepareBatchChanges(request.changes, request.mode);
        const projectPath = path.resolve(projectFile);
        return await withProjectLock(projectPath, async () => {
            const before = await hashProjectFile(projectPath);
            if (request.mode === "apply" && before !== request.expectedProjectSha256?.toLowerCase()) {
                throw new Error("Project file SHA-256 changed since preview; refusing batch write");
            }
            // One backup for the entire apply. No partial writes if backup fails.
            const backup = request.mode === "apply" ? await snapshotProject(projectPath) : null;
            if (backup && backup.sha256 !== before)
                throw new Error("Project changed during backup. Backup: " + backup.backup);
            const script = buildBatchScript(ensureSnippet, projectPath, { ...request, changes: validated });
            const result = await execute(script, 240_000);
            let report: BatchResult;
            try {
                report = parse<BatchResult>(result.output, "MCP_BATCH_JSON:");
            } catch (e: any) {
                throw new Error("No usable CODESYS batch report: " + e.message +
                    (backup ? ". Backup: " + backup.backup : "") + ". Raw output: " + result.output);
            }
            if (!report || report.mode !== request.mode || !Array.isArray(report.changes) ||
                typeof report.saved !== "boolean" || typeof report.status !== "string" ||
                report.changes.length > validated.length)
                throw new Error("Invalid CODESYS batch result; source state may be uncertain" +
                    (backup ? ". Backup: " + backup.backup : ""));
            if (backup) {
                report.backup = backup.backup;
                report.backupSha256 = backup.sha256;
            }
            if (request.mode === "preview") {
                const after = await hashProjectFile(projectPath);
                if (before !== after) throw new Error("Project file changed during preview; results are stale");
                if (report.projectSha256 !== before) throw new Error("CODESYS preview hash mismatch");
                const allValid = result.success && report.status === "preview" &&
                    report.changes.length === validated.length;
                return { isError: !allValid, text: JSON.stringify(report, null, 2) };
            }
            const saved = result.success && report.status === "saved" && report.saved &&
                report.changes.length === validated.length &&
                typeof report.projectSha256After === "string";
            return { isError: !saved, text: JSON.stringify(report, null, 2) };
        });
    } catch (e: any) {
        return { isError: true, text: "Batch operation refused or failed: " + e.message };
    }
}

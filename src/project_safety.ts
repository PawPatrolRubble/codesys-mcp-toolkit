/**
 * Back up local CODESYS project files before MCP-initiated mutations.
 * Does not open CODESYS or change the source project.
 */
import { createHash, randomBytes } from "crypto";
import * as fs from "fs/promises";
import { constants as fsConstants } from "fs";
import * as path from "path";

export interface ProjectSnapshot {
    original: string;
    backup: string;
    sha256: string;
    size: number;
}

export async function snapshotProject(filePath: string): Promise<ProjectSnapshot> {
    const source = path.resolve(filePath);
    const info = await fs.lstat(source);
    if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Only regular .project files may be backed up");
    if (path.extname(source).toLowerCase() !== ".project")
        throw new Error("Expected a CODESYS .project file");
    const backupDir = path.join(path.dirname(source), ".codesys-mcp-backups");
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupName = path.basename(source) + "." + timestamp + "." + randomBytes(8).toString("hex") + ".bak";
    const backup = path.join(backupDir, backupName);
    await fs.copyFile(source, backup, fsConstants.COPYFILE_EXCL);
    try {
        const [originalData, backupData] = await Promise.all([fs.readFile(source), fs.readFile(backup)]);
        const originalHash = createHash("sha256").update(originalData).digest("hex");
        const backupHash = createHash("sha256").update(backupData).digest("hex");
        if (originalHash !== backupHash)
            throw new Error("Backup hash mismatch; source may have changed during copy");
        return { original: source, backup, sha256: originalHash, size: backupData.length };
    } catch (e) {
        await fs.unlink(backup).catch(() => undefined);
        throw e;
    }
}

export function previewCodeChange(
    existing: { declaration: string | null; implementation: string | null },
    updated: { declarationCode?: string; implementationCode?: string }
) {
    if (updated.declarationCode === undefined && updated.implementationCode === undefined)
        throw new Error("At least one source section must be provided");
    const nextDeclaration = updated.declarationCode === undefined ? existing.declaration : updated.declarationCode;
    const nextImplementation = updated.implementationCode === undefined ? existing.implementation : updated.implementationCode;
    return {
        declaration: { before: existing.declaration, after: nextDeclaration, changed: existing.declaration !== nextDeclaration },
        implementation: { before: existing.implementation, after: nextImplementation, changed: existing.implementation !== nextImplementation },
        changed: existing.declaration !== nextDeclaration || existing.implementation !== nextImplementation
    };
}

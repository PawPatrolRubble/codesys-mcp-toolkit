/**
 * Parse machine-readable, single-line JSON records printed by the CODESYS scripting engine.
 * Any missing or malformed record is an error: never assume a successful build from exit code alone.
 */
export function parseJsonRecord<T>(output: string, marker: string): T {
    const records = output.split(/\r?\n/).filter(line => line.startsWith(marker));
    if (records.length !== 1) {
        throw new Error("Expected exactly one " + marker + " record; received " + records.length);
    }
    try {
        return JSON.parse(records[0].slice(marker.length)) as T;
    } catch (error: any) {
        throw new Error("Malformed " + marker + " record: " + error.message);
    }
}

export interface BuildMessage {
    severity: string;
    category: string;
    object: string;
    position: string;
    text: string;
}
export interface BuildReport {
    application: string;
    diagnostics_available: boolean;
    errors: number;
    warnings: number;
    messages: BuildMessage[];
    categories_scanned: number;
    message_read_failures: string[];
}

export function evaluateBuild(output: string, scriptSuccess: boolean): {
    isError: boolean;
    text: string;
} {
    if (!scriptSuccess || !output.includes("SCRIPT_SUCCESS:")) {
        return { isError: true, text: "CODESYS build script failed:\n" + output };
    }
    let report: BuildReport;
    try {
        report = parseJsonRecord<BuildReport>(output, "MCP_BUILD_JSON:");
        if (
            typeof report.application !== "string" ||
            typeof report.diagnostics_available !== "boolean" ||
            !Number.isInteger(report.errors) || report.errors < 0 ||
            !Number.isInteger(report.warnings) || report.warnings < 0 ||
            !Number.isInteger(report.categories_scanned) ||
            !Array.isArray(report.messages) ||
            !Array.isArray(report.message_read_failures)
        ) {
            throw new Error("Invalid build-report fields");
        }
        for (const item of report.messages) {
            if (!item || !["severity", "category", "object", "position", "text"].every(k =>
                typeof (item as unknown as Record<string, unknown>)[k] === "string"
            )) throw new Error("Invalid build-message fields");
        }
        const errorCount = report.messages.filter(item => ["Error", "FatalError"].includes(item.severity)).length;
        const warningCount = report.messages.filter(item => item.severity === "Warning").length;
        if (errorCount !== report.errors || warningCount !== report.warnings) {
            throw new Error("Message counts do not match build result");
        }
    } catch (e: any) {
        return { isError: true, text: "Could not verify CODESYS compilation: " + e.message + "\n" + output };
    }
    const verified = report.diagnostics_available &&
        report.categories_scanned > 0 && report.message_read_failures.length === 0;
    const ok = verified && report.errors === 0;
    return {
        isError: !ok,
        text: JSON.stringify({
            status: !verified ? "unverified" : (ok ? "success" : "failed"),
            ...report
        }, null, 2)
    };
}

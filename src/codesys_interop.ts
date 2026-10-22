/**
 * CODESYS Interop Module
 * Handles direct interaction with the CODESYS executable via command-line scripts.
 *
 * This module manages:
 * - Creating temporary Python script files
 * - Executing them via CODESYS's scripting engine
 * - Capturing and processing results
 *
 * IMPORTANT: Path handling for Windows is critical - paths with spaces require
 * special handling to avoid the 'C:\Program' not recognized error.
 */

import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs'; // Import fs for existsSync check

// Define expected success/error markers from the Python scripts
const SCRIPT_SUCCESS_MARKER = 'SCRIPT_SUCCESS';
const SCRIPT_ERROR_MARKER = 'SCRIPT_ERROR';

/**
 * Executes a CODESYS Python script using the command line interface.
 *
 * @param scriptContent The Python script code to execute.
 * @param codesysExePath The full path to the CODESYS.exe executable (can contain spaces).
 * @param codesysProfileName The name of the CODESYS profile to use for scripting.
 * @returns A promise resolving to an object containing the success status and the script's output.
 *
 * NOTE: Using shell: true with careful command string quoting to handle
 * CODESYS argument parsing quirks when launched non-interactively.
 */
export async function executeCodesysScript(
    scriptContent: string,
    codesysExePath: string,
    codesysProfileName: string,
    timeoutMs: number = 60_000
): Promise<{ success: boolean; output: string }> {

    // --- Pre-checks ---
    if (!codesysExePath) throw new Error('CODESYS executable path was not provided.');
    if (!codesysProfileName) throw new Error('CODESYS profile name was not provided.');
    if (!fs.existsSync(codesysExePath)) throw new Error(`CODESYS executable not found at provided path: ${codesysExePath}`);
    // --- End Pre-checks ---

    const tempDir = os.tmpdir();
    const tempFileName = `codesys_script_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.py`;
    const tempFilePath = path.join(tempDir, tempFileName); // Path module uses OS-specific separators ('\' on Windows)

    let output = '';
    let stderrOutput = '';
    let success = false;
    let exitCode: number | null = null;

    const codesysDir = path.dirname(codesysExePath); // Directory containing CODESYS.exe

    try {
        const normalizedScriptContent = `# -*- coding: utf-8 -*-\n${scriptContent.replace(/\r\n/g, '\n')}`;

        // <<< --- ADDED SCRIPT CONTENT LOGGING --- >>>
        process.stderr.write(`INTEROP: Script content to be written (first 500 chars):\n`);
        process.stderr.write(`------ START SCRIPT (TEMP FILE) -----\n`);
        process.stderr.write(`${normalizedScriptContent.substring(0, 500)}\n`); // Log the first 500 chars
        process.stderr.write(`------ END SCRIPT SNIPPET (TEMP FILE) -----\n`);
        // <<< --- END SCRIPT CONTENT LOGGING --- >>>

        await writeFile(tempFilePath, normalizedScriptContent, 'utf8'); // Preserve Chinese and other Unicode
        process.stderr.write(`INTEROP: Temp script written: ${tempFilePath}\n`);


        // Avoid cmd.exe: pass executable and arguments separately to Node.
        const codesysArgs = [
            `--profile=${codesysProfileName}`,
            '--noUI',
            `--runscript=${tempFilePath}`,
        ];

        process.stderr.write(`INTEROP: Spawning CODESYS executable: ${codesysExePath}\n`);
        process.stderr.write(`INTEROP ENV: CWD before spawn: ${process.cwd()}\n`);
        process.stderr.write(`INTEROP ENV: Forcing CWD for spawn: ${codesysDir}\n`); // Re-enabled CWD change

        // --- Create modified environment (Re-enabled) ---
        const spawnEnv = { ...process.env };
        const pathSeparator = ';'; // Windows
        const originalPath = spawnEnv.PATH || '';
        spawnEnv.PATH = `${codesysDir}${pathSeparator}${originalPath}`; // Prepend CODESYS dir to PATH
        process.stderr.write(`INTEROP ENV: MODIFIED PATH for spawn (prepended): ${spawnEnv.PATH.substring(0, 100)}...\n`); // Re-enabled ENV change
        // --- End modified environment ---


        const spawnResult = await new Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }>((resolve) => {
            let stdoutData = '';
            let stderrData = '';
            let timedOut = false;
            let processClosed = false;
            let processError: Error | undefined;
            let killTimer: ReturnType<typeof setTimeout> | undefined;

            const controller = new AbortController();
            const timeoutSignal = controller.signal;
            const timeoutDuration = Math.max(10_000, Math.min(600_000, timeoutMs));

            // Pass the single command string, empty args array, and shell: true
            const childProcess = spawn(codesysExePath, codesysArgs, {
                 windowsHide: true,
                 signal: timeoutSignal,
                 cwd: codesysDir, // Re-enabled CWD change
                 env: spawnEnv,   // Re-enabled ENV change
                 shell: false     // Never pass arguments through a command shell
                });

            const timeoutId = setTimeout(() => {
                process.stderr.write('INTEROP: Process timeout reached.\n');
                timedOut = true;
                controller.abort();
            }, timeoutDuration);

            // --- Event Listeners (stdout, stderr, error, close, abort) ---
            childProcess.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdoutData += chunk;
                process.stderr.write(`INTEROP stdout chunk: ${chunk.length > 50 ? chunk.substring(0, 50) + '...' : chunk}\n`);
            });
            childProcess.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderrData += chunk;
                // Check for specific error patterns
                if (chunk.includes('--profile="profile name"')) { process.stderr.write(`>>>> INTEROP STDERR DETECTED Profile Error Message: ${chunk}\n`); }
                else if (chunk.includes('is not recognized')) { process.stderr.write(`>>>> INTEROP STDERR DETECTED 'not recognized' (shell issue?): ${chunk}\n`); }
                else if (chunk.includes('SyntaxErrorException')) { process.stderr.write(`>>>> INTEROP STDERR DETECTED Syntax Error: ${chunk}\n`); } // More specific check
                else { process.stderr.write(`INTEROP stderr chunk: ${chunk}\n`); }
            });
            childProcess.on('error', (spawnError) => {
                processError = spawnError;
                process.stderr.write(`INTEROP process error: ${spawnError.message}\n`);
                // AbortError can arrive before close; waiting for close ensures a running
                // CODESYS process has stopped before releasing a project lock.
            });
            childProcess.on('close', (code) => {
                processClosed = true;
                clearTimeout(timeoutId);
                if (killTimer) clearTimeout(killTimer);
                process.stderr.write(`INTEROP: Process closed code: ${code}\n`);
                resolve({
                    code,
                    stdout: stdoutData,
                    stderr: stderrData + (timedOut ? "\nTIMEOUT: CODESYS process terminated after timeout." : ""),
                    error: timedOut ? undefined : processError
                });
            });
            timeoutSignal.addEventListener('abort', () => {
                process.stderr.write('INTEROP: Abort signal sent; waiting for process closure.\n');
                killTimer = setTimeout(() => {
                    if (!processClosed) {
                        process.stderr.write('INTEROP: Escalating timed-out CODESYS process termination.\n');
                        childProcess.kill('SIGKILL');
                    }
                }, 2000);
            }, { once: true });
            // --- End Event Listeners ---
        });

        output = spawnResult.stdout;
        stderrOutput = spawnResult.stderr;
        exitCode = spawnResult.code;

        // --- Success Determination Logic ---
        success = false; // Assume failure unless proven otherwise
        if (stderrOutput.includes('TIMEOUT:')) {
            process.stderr.write('INTEROP: Failure determined by process timeout.\n');
        } else if (spawnResult.error) {
            process.stderr.write(`INTEROP: Failure determined by spawn error: ${spawnResult.error.message}\n`);
            if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: Spawn failed: ${spawnResult.error.message}\n${stderrOutput}`;
        } else if (stderrOutput.includes('is not recognized as an internal or external command')) {
             process.stderr.write("INTEROP: Failure determined by 'not recognized' error in stderr (shell:true quoting issue likely).\n");
             if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: Shell execution failed: ${stderrOutput}`;
        } else if (stderrOutput.includes('--profile="profile name"')) {
            process.stderr.write("INTEROP: Failure determined by CODESYS profile error message in stderr.\n");
             if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: ${stderrOutput}`;
        } else if (stderrOutput.includes('SyntaxErrorException')) { // Check for syntax error specifically
             process.stderr.write("INTEROP: Failure determined by CODESYS Script Syntax Error.\n");
             if (!stderrOutput.includes(SCRIPT_ERROR_MARKER)) stderrOutput = `SCRIPT_ERROR: ${stderrOutput}`; // Include the syntax error details
        } else {
            // A successful CODESYS script requires a zero exit status and an explicit
            // success marker; do not let a 0 exit status mask a reported script error.
            const sawSuccess = /^SCRIPT_SUCCESS:/m.test(output);
            const sawError = /^SCRIPT_ERROR:/m.test(output) || /^SCRIPT_ERROR:/m.test(stderrOutput);
            success = exitCode === 0 && sawSuccess && !sawError;
            if (!success) {
                stderrOutput = `SCRIPT_ERROR: Script failed (exit=${exitCode}, successMarker=${sawSuccess}, errorMarker=${sawError}).\n${stderrOutput}`;
            }
        }
        // --- End Success Determination ---

    } catch (error: any) {
        process.stderr.write(`INTEROP: Error during setup: ${error.message}\n${error.stack}\n`);
        stderrOutput = `SCRIPT_ERROR: Failed during script execution setup: ${error.message}`;
        success = false;
    } finally {
        // Cleanup: Attempt to delete the temporary script file
        try { await unlink(tempFilePath); process.stderr.write(`INTEROP: Temp script deleted: ${tempFilePath}\n`); }
        catch (cleanupError: any) { process.stderr.write(`INTEROP: Failed to delete temp file ${tempFilePath}: ${cleanupError.message}\n`); if (success) stderrOutput += `\nWARNING: Failed to delete temporary script file ${tempFilePath}. ${cleanupError.message}`; }
    }
    // Final output processing
    // Combine stderr and stdout only on failure to preserve clean success output
    const finalOutput = success ? output : `${stderrOutput}\n${output}`.trim();
    process.stderr.write(`INTEROP: Final Success: ${success}\n`);
    process.stderr.write(`INTEROP: Final Output Length: ${finalOutput.length}\n---\n`);
    return { success, output: finalOutput };
}
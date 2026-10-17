const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
const interop = fs.readFileSync(path.join(__dirname, '../src/codesys_interop.ts'), 'utf8');

test('create_project does not overwrite an existing .project', () => {
    assert.match(server, /os\.O_EXCL/);
    assert.match(server, /Refusing to overwrite existing project/);
    assert.doesNotMatch(server, /shutil\.copy2\(TEMPLATE_PROJECT_PATH, PROJECT_FILE_PATH\)/);
});

test('set_pou_code preserves omitted declaration and implementation sections', () => {
    assert.match(server, /DECLARATION_PRESENT = \{DECLARATION_PRESENT\}/);
    assert.match(server, /IMPLEMENTATION_PRESENT = \{IMPLEMENTATION_PRESENT\}/);
    assert.match(server, /if DECLARATION_PRESENT:/);
    assert.match(server, /if IMPLEMENTATION_PRESENT:/);
    assert.match(server, /declarationCode === undefined \? "False" : "True"/);
    assert.match(server, /implementationCode === undefined \? "False" : "True"/);
    assert.doesNotMatch(server, /has_declaration_content = 'DECLARATION_CONTENT'/);
});

test('MCP-generated code is transported as base64, not embedded Python quotes', () => {
    assert.match(server, /Buffer\.from\(declarationCode \?\? "", "utf8"\)\.toString\("base64"\)/);
    assert.match(server, /Buffer\.from\(implementationCode \?\? "", "utf8"\)\.toString\("base64"\)/);
    assert.match(server, /DECLARATION_CONTENT = __import__\("base64"\)\.b64decode/);
    assert.match(server, /IMPLEMENTATION_CONTENT = __import__\("base64"\)\.b64decode/);
});

test('source string arguments are not interpolated directly in Python literals', () => {
    for (const variable of ['POU_NAME', 'POU_FULL_PATH', 'PARENT_POU_FULL_PATH', 'PROPERTY_NAME', 'METHOD_NAME']) {
        assert.doesNotMatch(server, new RegExp(variable + ' = "' + '\\{' + variable + '\\}' + '"'));
    }
    assert.match(server, /Buffer\.from\(sanitizedPouPath, "utf8"\)\.toString\("base64"\)/);
});

test('Python scripts preserve UTF-8 CJK text', () => {
    assert.match(interop, /coding: utf-8/);
    assert.match(interop, /writeFile\(tempFilePath, normalizedScriptContent, 'utf8'\)/);
    assert.doesNotMatch(interop, /writeFile\(tempFilePath, normalizedScriptContent, 'latin1'\)/);
});

test('CODESYS process receives argv directly, without a shell', () => {
    assert.match(interop, /spawn\(codesysExePath, codesysArgs, \{/);
    assert.match(interop, /shell: false/);
    assert.doesNotMatch(interop, /spawn\(fullCommandString/);
});

test('CODESYS success requires an explicit success marker', () => {
    assert.match(interop, /success = exitCode === 0 && sawSuccess && !sawError/);
});

test('MCP transport is awaited', () => {
    assert.match(server, /await server\.connect\(transport\)/);
});

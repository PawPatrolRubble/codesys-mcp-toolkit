const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonRecord, evaluateBuild } = require('../dist/build_results.js');

function buildReport(overrides = {}) {
    return {
        application: 'Application',
        diagnostics_available: true,
        errors: 0, warnings: 0, messages: [],
        categories_scanned: 5,
        message_read_failures: [],
        ...overrides
    };
}
function script(report) {
    return 'MCP_BUILD_JSON:' + JSON.stringify(report) + '\nSCRIPT_SUCCESS: Build completed and diagnostic scan attempted.\n';
}

test('successful build with empty diagnostic messages', () => {
    const output = evaluateBuild(script(buildReport()), true);
    assert.equal(output.isError, false);
    assert.equal(JSON.parse(output.text).status, 'success');
});

test('compiler error is reported as an MCP error with IEC source position', () => {
    const report = buildReport({
        errors: 1,
        messages: [{ category: 'Build', severity: 'Error', object: 'FB_Axis',
            position: '12', text: "未知标识符 / Unknown identifier" }]
    });
    const output = evaluateBuild(script(report), true);
    assert.equal(output.isError, true);
    assert.equal(JSON.parse(output.text).messages[0].text, "未知标识符 / Unknown identifier");
    assert.equal(JSON.parse(output.text).status, 'failed');
});

test('warnings alone do not fail compilation', () => {
    const report = buildReport({
        warnings: 1,
        messages: [{ category: 'Build', severity: 'Warning', object: 'Main',
            position: '3', text: 'Unused variable' }]
    });
    const output = evaluateBuild(script(report), true);
    assert.equal(output.isError, false);
    assert.equal(JSON.parse(output.text).warnings, 1);
});

test('missing diagnostic marker fails closed', () => {
    assert.equal(evaluateBuild('SCRIPT_SUCCESS: Build initiated\n', true).isError, true);
});
test('malformed diagnostic JSON fails closed', () => {
    assert.equal(evaluateBuild('MCP_BUILD_JSON:not-json\nSCRIPT_SUCCESS: Build\n', true).isError, true);
});
test('zero diagnostic categories fails closed', () => {
    assert.equal(evaluateBuild(script(buildReport({ categories_scanned: 0 })), true).isError, true);
});
test('unavailable message storage fails closed', () => {
    assert.equal(evaluateBuild(script(buildReport({ diagnostics_available: false })), true).isError, true);
});
test('partial category scan fails closed', () => {
    assert.equal(evaluateBuild(script(buildReport({ message_read_failures: ['Unknown category'] })), true).isError, true);
});
test('false zero-error count cannot override error records', () => {
    const report = buildReport({ messages: [
        { category: 'Build', severity: 'FatalError', object: 'PLC_PRG', position: '1', text: 'Fatal' }
    ]});
    assert.equal(evaluateBuild(script(report), true).isError, true);
});
test('missing script success fails closed', () => {
    assert.equal(evaluateBuild('MCP_BUILD_JSON:' + JSON.stringify(buildReport()), true).isError, true);
    assert.equal(evaluateBuild(script(buildReport()), false).isError, true);
});
test('parseJsonRecord rejects duplicate records', () => {
    assert.throws(() => parseJsonRecord('MCP_POU_JSON:{}\nMCP_POU_JSON:{}', 'MCP_POU_JSON:'), /exactly one/);
});
test('UTF-8 read results round-trip in JSON record', () => {
    const result = { name: 'FB_气缸', path: 'Application/FB_气缸',
        declaration: 'VAR\n中文注释 : BOOL;\nEND_VAR', implementation: 'x := TRUE;' };
    assert.deepEqual(parseJsonRecord('MCP_POU_JSON:' + JSON.stringify(result), 'MCP_POU_JSON:'), result);
});

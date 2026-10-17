const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { snapshotProject, previewCodeChange } = require('../dist/project_safety.js');

test('snapshots preserve bytes and report verified SHA-256', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesys-mcp-test-'));
    try {
        const file = path.join(dir, 'Machine.project');
        const input = Buffer.from([0x01, 0x02, 0x7f, 0xe4, 0xb8, 0xad, 0x00]);
        await fs.writeFile(file, input);
        const first = await snapshotProject(file);
        const second = await snapshotProject(file);
        assert.notEqual(first.backup, second.backup);
        assert.equal(first.sha256, second.sha256);
        assert.deepEqual(await fs.readFile(first.backup), input);
        assert.equal(first.size, input.length);
        assert.deepEqual(await fs.readFile(file), input);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('snapshot refuses missing project or unsupported extension', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesys-mcp-test-'));
    try {
        await assert.rejects(() => snapshotProject(path.join(dir, 'missing.project')));
        const file = path.join(dir, 'not-a-project.txt');
        await fs.writeFile(file, 'data');
        await assert.rejects(() => snapshotProject(file), /Expected a CODESYS/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('snapshot refuses a symlink instead of following project aliases', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesys-mcp-test-'));
    try {
        const file = path.join(dir, 'real.project');
        const alias = path.join(dir, 'alias.project');
        await fs.writeFile(file, 'project');
        try {
            await fs.symlink(file, alias);
        } catch (e) {
            t.skip('Platform does not allow symlinks: ' + e.message);
            return;
        }
        await assert.rejects(() => snapshotProject(alias), /Only regular/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('preview preserves untouched IEC sections exactly', () => {
    const result = previewCodeChange(
        { declaration: 'VAR\n    x : BOOL;\nEND_VAR', implementation: '// 中文注释\nx := FALSE;' },
        { implementationCode: 'x := TRUE;' });
    assert.equal(result.declaration.changed, false);
    assert.equal(result.declaration.before, result.declaration.after);
    assert.equal(result.implementation.changed, true);
    assert.equal(result.implementation.before, '// 中文注释\nx := FALSE;');
});

test('preview distinguishes explicit clear from an omitted section', () => {
    const existing = { declaration: 'VAR\nEND_VAR', implementation: 'x := TRUE;' };
    const result = previewCodeChange(existing, { implementationCode: '' });
    assert.equal(result.implementation.after, '');
    assert.equal(result.declaration.after, existing.declaration);
});

test('preview rejects an empty write request', () => {
    assert.throws(() => previewCodeChange({ declaration: '', implementation: '' }, {}), /At least one/);
});

// End-to-end tests: official MCP SDK client -> packaged stdio server -> real x86
// BrawlLib worker -> synthetic game resources. No mocked application operations.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, open } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFixtures, arc, msbin } from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { server: { type: 'string' }, worker: { type: 'string' }, output: { type: 'string' } } });
const serverPath = resolve(values.server ?? join(here, '../server.mjs'));
const output = resolve(values.output ?? join(here, '../../artifacts/mcp-evidence'));
const runDirectory = join(output, `integration-${randomUUID()}`);
const root = join(runDirectory, 'allowed');
await writeFixtures(root);
await mkdir(join(root, 'exports'));
const sessions = [];
const checks = [];
const transcript = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const op = () => randomUUID();
async function check(name, action) {
  try { await action(); checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, status: 'failed', error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function connect(write = true) {
  const stderr = [];
  const args = [serverPath, '--root', root, ...(values.worker ? ['--worker', resolve(values.worker)] : []), ...(write ? ['--allow-write'] : [])];
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: dirname(serverPath), stderr: 'pipe' });
  const client = new Client({ name: 'brawlcrate-integration-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on('data', chunk => stderr.push(chunk.toString()));
  const session = { client, transport, stderr, args };
  sessions.push(session);
  return session;
}
async function rawCall(session, name, args = {}) {
  const result = await session.client.callTool({ name, arguments: args });
  transcript.push({ tool: name, arguments: args, result });
  return result;
}
async function call(session, name, args = {}) {
  const result = await rawCall(session, name, args);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.ok(result.structuredContent?.data && typeof result.structuredContent.data === 'object');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent.data;
}
async function fails(session, name, args, code) {
  const result = await rawCall(session, name, args);
  assert.equal(result.isError, true, 'Expected an actual MCP tool error');
  const error = JSON.parse(result.content[0].text).error;
  if (code) assert.equal(error.code, code, error.message);
  return error;
}
let main, readonly, archive, messages, status, exportedHash, beforeHash;
try {
  await check('connect the actual stdio entry point using the official SDK client', async () => { main = await connect(); });
  if (!main) throw new Error('Cannot continue without a connected application.');
  await check('discover exact capabilities and strict input/output schemas', async () => {
    assert.deepEqual(main.client.getServerCapabilities(), { tools: {}, resources: {}, prompts: {} });
    const listed = await main.client.listTools();
    assert.equal(listed.tools.length, 9);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.outputSchema.type, 'object');
      assert.equal(tool.annotations.openWorldHint, false);
    }
  });
  await check('status reports the actual BrawlLib version, instance and launch permissions', async () => {
    status = await call(main, 'get_status');
    assert.equal(status.mode, 'headless'); assert.equal(status.allow_write, true);
    assert.equal(status.brawllib_version, '0.42.0.1'); assert.equal(status.documents.length, 0);
  });
  await check('resource and prompt retrieval reflect state without opening a document', async () => {
    const resources = await main.client.listResources(); assert.equal(resources.resources.length, 1);
    assert.equal((await main.client.listResourceTemplates()).resourceTemplates.length, 1);
    const read = await main.client.readResource({ uri: 'brawlcrate://session/status' });
    assert.equal(JSON.parse(read.contents[0].text).instance_id, status.instance_id);
    assert.equal((await main.client.listPrompts()).prompts.length, 1);
    const prompt = await main.client.getPrompt({ name: 'inspect_archive', arguments: { path: 'nested.pac' } });
    assert.match(prompt.messages[0].content.text, /open_document/);
    assert.equal((await call(main, 'get_status')).documents.length, 0);
  });
  await check('open a real nested ARC and preserve the source hash', async () => {
    beforeHash = hash(await readFile(join(root, 'nested.pac')));
    archive = await call(main, 'open_document', { path: 'nested.pac' });
    assert.equal(archive.root.name, 'McpFixture'); assert.equal(archive.node_count, 4);
    assert.equal(archive.source_sha256, beforeHash); assert.equal(archive.revision, 0);
  });
  await check('reopen returns the same authoritative session document', async () => {
    const again = await call(main, 'open_document', { path: 'nested.pac' });
    assert.equal(again.document_id, archive.document_id);
    await fails(main, 'open_document', { path: 'nested.pac', format: 'msbin' }, 'UNSUPPORTED_OR_INVALID_FILE');
  });
  await check('pagination returns real children, stable IDs and end-of-list', async () => {
    const first = await call(main, 'list_children', { document_id: archive.document_id, limit: 2 });
    assert.deepEqual(first.items.map(n => n.name), ['First', 'Second']); assert.equal(first.next_offset, 2);
    const second = await call(main, 'list_children', { document_id: archive.document_id, offset: first.next_offset, limit: 2 });
    assert.equal(second.items[0].node_id, '2'); assert.equal(second.next_offset, null);
    assert.equal((await call(main, 'list_children', { document_id: archive.document_id, offset: 999 })).items.length, 0);
  });
  await check('document resource uses the same handle and revision', async () => {
    const result = await main.client.readResource({ uri: `brawlcrate://documents/${archive.document_id}` });
    assert.equal(JSON.parse(result.contents[0].text).revision, archive.revision);
  });
  await check('input validation rejects unknown fields, wrong types and excessive pages', async () => {
    await fails(main, 'get_status', { unexpected: true }, 'invalid_arguments');
    await fails(main, 'list_children', { document_id: archive.document_id, limit: 201 }, 'invalid_arguments');
    await fails(main, 'list_children', { document_id: archive.document_id, offset: -1 }, 'invalid_arguments');
    await fails(main, 'rename_node', { document_id: archive.document_id, name: 'Name', expected_revision: '0', operation_id: op() }, 'invalid_arguments');
    const longArguments = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i}${'x'.repeat(500)}`, true]));
    const boundedError = await fails(main, 'get_status', longArguments, 'invalid_arguments');
    assert.ok(boundedError.message.length <= 4096);
  });
  await check('unknown handles and wrong node kinds fail without side effects', async () => {
    await fails(main, 'get_document', { document_id: 'missing' }, 'DOCUMENT_NOT_FOUND');
    await fails(main, 'list_children', { document_id: archive.document_id, node_id: '99' }, 'NODE_NOT_FOUND');
    await fails(main, 'read_messages', { document_id: archive.document_id }, 'WRONG_NODE_TYPE');
  });
  await check('rename changes actual ARC state; exact retry is deduplicated', async () => {
    const args = { document_id: archive.document_id, name: 'RenamedViaMCP', expected_revision: 0, operation_id: op() };
    const first = await call(main, 'rename_node', args);
    assert.equal(first.revision, 1); assert.equal(first.node.name, args.name);
    assert.deepEqual(await call(main, 'rename_node', args), first);
    await fails(main, 'rename_node', { ...args, name: 'Different' }, 'OPERATION_CONFLICT');
    await fails(main, 'rename_node', { ...args, operation_id: op() }, 'STALE_REVISION');
    archive = await call(main, 'get_document', { document_id: archive.document_id });
    assert.equal(archive.dirty, true);
  });
  await check('duplicate sibling names and dirty close are rejected', async () => {
    await fails(main, 'rename_node', { document_id: archive.document_id, node_id: '0', name: 'Second', expected_revision: 1, operation_id: op() }, 'DUPLICATE_NAME');
    await fails(main, 'close_document', { document_id: archive.document_id, expected_revision: 1, operation_id: op() }, 'UNSAVED_CHANGES');
  });
  await check('export persists the native ARC header and never modifies its source', async () => {
    const args = { document_id: archive.document_id, path: 'exports/renamed.pac', expected_revision: 1, operation_id: op() };
    const first = await call(main, 'export_document', args);
    assert.deepEqual(await call(main, 'export_document', args), first);
    const bytes = await readFile(join(root, first.path));
    assert.equal(bytes.subarray(16, 64).toString('ascii').split('\0')[0], 'RenamedViaMCP');
    exportedHash = hash(bytes); assert.equal(first.sha256, exportedHash);
    assert.equal(hash(await readFile(join(root, 'nested.pac'))), beforeHash);
    assert.equal(first.revision, 2);
    await fails(main, 'export_document', { ...args, expected_revision: 2, operation_id: op() }, 'ALREADY_EXISTS');
    await fails(main, 'export_document', { ...args, path: 'nested.pac', expected_revision: 2, operation_id: op() }, 'ALREADY_EXISTS');
  });
  await check('reopen exported data through BrawlLib verifies persistent state', async () => {
    const reloaded = await call(main, 'open_document', { path: 'exports/renamed.pac' });
    assert.equal(reloaded.root.name, 'RenamedViaMCP'); assert.equal(reloaded.source_sha256, exportedHash);
    await call(main, 'close_document', { document_id: reloaded.document_id, expected_revision: 0, operation_id: op() });
  });
  await check('nested MSBin messages are read and edited through native nodes', async () => {
    messages = await call(main, 'open_document', { path: 'mixed.pac' });
    const read = await call(main, 'read_messages', { document_id: messages.document_id, node_id: '0/0' });
    assert.equal(read.items[0].text, 'Nested message');
    const changed = await call(main, 'set_message', { document_id: messages.document_id, node_id: '0/0', index: 0, text: 'Hej världen\nUpdated through MCP', expected_revision: 0, operation_id: op() });
    assert.equal(changed.text, 'Hej världen\r\nUpdated through MCP');
  });
  await check('unsafe text, unknown indexes and trailing empty messages are rejected before mutation', async () => {
    const args = { document_id: messages.document_id, node_id: '0/0', index: 0, expected_revision: 1, operation_id: op() };
    await fails(main, 'set_message', { ...args, text: '<color=bad>' }, 'invalid_arguments');
    await fails(main, 'set_message', { ...args, text: '', operation_id: op() }, 'INVALID_MESSAGE');
    await fails(main, 'set_message', { ...args, text: 'Normal', index: 99, operation_id: op() }, 'INDEX_OUT_OF_RANGE');
    await fails(main, 'set_message', { ...args, text: '界'.repeat(200), operation_id: op() }, 'invalid_arguments');
    assert.equal((await call(main, 'get_document', { document_id: messages.document_id })).revision, 1);
  });
  await check('concurrent conflicting edits serialize and exactly one revision wins', async () => {
    const args = { document_id: messages.document_id, node_id: '0/0', index: 0, expected_revision: 1 };
    const results = await Promise.all(['Concurrent A', 'Concurrent B'].map(text => rawCall(main, 'set_message', { ...args, text, operation_id: op() })));
    assert.equal(results.filter(r => !r.isError).length, 1);
    assert.equal(JSON.parse(results.find(r => r.isError).content[0].text).error.code, 'STALE_REVISION');
  });
  await check('nested edited messages survive export and application reopen', async () => {
    const expected = await call(main, 'read_messages', { document_id: messages.document_id, node_id: '0/0' });
    await call(main, 'export_document', { document_id: messages.document_id, path: 'exports/edited.pac', expected_revision: 2, operation_id: op() });
    const reopened = await call(main, 'open_document', { path: 'exports/edited.pac' });
    const actual = await call(main, 'read_messages', { document_id: reopened.document_id, node_id: '0/0' });
    assert.deepEqual(actual.items, expected.items);
    await call(main, 'close_document', { document_id: reopened.document_id, expected_revision: 0, operation_id: op() });
  });
  await check('read-only launch independently enforces edits and exports', async () => {
    readonly = await connect(false);
    const status = await call(readonly, 'get_status'); assert.equal(status.allow_write, false);
    const doc = await call(readonly, 'open_document', { path: 'empty.pac' });
    await fails(readonly, 'rename_node', { document_id: doc.document_id, name: 'Denied', expected_revision: 0, operation_id: op() }, 'READ_ONLY');
    await fails(readonly, 'export_document', { document_id: doc.document_id, path: 'exports/denied.pac', expected_revision: 0, operation_id: op() }, 'READ_ONLY');
    await call(readonly, 'close_document', { document_id: doc.document_id, expected_revision: 0, operation_id: op() });
  });
  await check('session handles cannot be used by another MCP connection', async () => {
    await fails(readonly, 'get_document', { document_id: archive.document_id }, 'DOCUMENT_NOT_FOUND');
    await assert.rejects(readonly.client.readResource({ uri: `brawlcrate://documents/${archive.document_id}` }));
  });
  await check('scope rejects traversal, absolute paths, ADS and Windows device names', async () => {
    for (const path of ['../outside.pac', resolve(root, 'empty.pac'), 'empty.pac:secret', 'NUL', './empty.pac', 'empty.pac.']) {
      await fails(main, 'open_document', { path }, 'PATH_DENIED');
    }
    await fails(main, 'export_document', { document_id: archive.document_id, path: '../escape.pac', expected_revision: 2, operation_id: op() }, 'PATH_DENIED');
    await fails(main, 'export_document', { document_id: archive.document_id, path: 'absent/output.pac', expected_revision: 2, operation_id: op() }, 'DIRECTORY_NOT_FOUND');
  });
  await check('directory junctions cannot escape the configured root', async () => {
    const outside = join(runDirectory, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'secret.pac'), arc('Outside'));
    await symlink(outside, join(root, 'junction'), 'junction');
    await fails(main, 'open_document', { path: 'junction/secret.pac' }, 'PATH_DENIED');
    await fails(main, 'export_document', { document_id: archive.document_id, path: 'junction/new.pac', expected_revision: 2, operation_id: op() }, 'PATH_DENIED');
  });
  await check('malformed binary input is rejected before unsafe native parsing', async () => {
    const badName = arc(); badName.fill(65, 16, 64);
    const badLength = arc('BadLength', [arc('Child')]); badLength.writeUInt32BE(0xffffffff, 68);
    const badCount = arc(); badCount.writeUInt16BE(65535, 6);
    const fixtures = [Buffer.from('not a game file'), arc().subarray(0, 32), badName, badLength, badCount, msbin(['unsafe<markup>']), msbin(['Trailing', ''])];
    for (let i = 0; i < fixtures.length; i++) {
      await writeFile(join(root, `bad-${i}.bin`), fixtures[i]);
      await fails(main, 'open_document', { path: `bad-${i}.bin` }, 'UNSUPPORTED_OR_INVALID_FILE');
    }
  });
  await check('file size and nesting bounds reject expensive inputs', async () => {
    const handle = await open(join(root, 'oversized.bin'), 'wx');
    try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await fails(main, 'open_document', { path: 'oversized.bin' }, 'FILE_SIZE');
    let nested = arc('Leaf'); for (let i = 0; i < 17; i++) nested = arc(`Depth${i}`, [nested]);
    await writeFile(join(root, 'deep.pac'), nested);
    await fails(main, 'open_document', { path: 'deep.pac' }, 'UNSUPPORTED_OR_INVALID_FILE');
  });
  await check('Unicode and line breaks survive actual MSBin decode', async () => {
    const unicode = await call(main, 'open_document', { path: 'unicode.msbin' });
    assert.equal(unicode.root.name, 'unicode.msbin');
    const read = await call(main, 'read_messages', { document_id: unicode.document_id });
    assert.equal(read.items[0].text, 'Hej världen'); assert.equal(read.items[2].text, 'こんにちは');
    assert.equal(read.items[1].text, 'First line\r\nSecond line');
    await call(main, 'close_document', { document_id: unicode.document_id, expected_revision: 0, operation_id: op() });
  });
  await check('document limit is bounded; reopening an existing handle still works', async () => {
    const ids = [];
    const count = (await call(readonly, 'get_status')).documents.length;
    for (let i = count; i < 8; i++) {
      await writeFile(join(root, `limit-${i}.pac`), arc(`Limit${i}`));
      ids.push((await call(readonly, 'open_document', { path: `limit-${i}.pac` })).document_id);
    }
    assert.equal((await call(readonly, 'open_document', { path: `limit-${count}.pac` })).document_id, ids[0]);
    await fails(readonly, 'open_document', { path: 'empty.pac' }, 'DOCUMENT_LIMIT');
    for (const document_id of ids) await call(readonly, 'close_document', { document_id, expected_revision: 0, operation_id: op() });
  });
  await check('closed handles expire and exact close retries return their receipt', async () => {
    const args = { document_id: archive.document_id, expected_revision: 2, operation_id: op() };
    const first = await call(main, 'close_document', args);
    assert.deepEqual(await call(main, 'close_document', args), first);
    await fails(main, 'get_document', { document_id: archive.document_id }, 'DOCUMENT_NOT_FOUND');
    await assert.rejects(main.client.readResource({ uri: `brawlcrate://documents/${archive.document_id}` }));
  });
  await check('restart invalidates handles and preserves exported storage', async () => {
    await main.client.close();
    const restarted = await connect();
    const restartedStatus = await call(restarted, 'get_status');
    assert.notEqual(restartedStatus.instance_id, status.instance_id); assert.equal(restartedStatus.documents.length, 0);
    await fails(restarted, 'get_document', { document_id: messages.document_id }, 'DOCUMENT_NOT_FOUND');
    const reopened = await call(restarted, 'open_document', { path: 'exports/renamed.pac' });
    assert.equal(reopened.root.name, 'RenamedViaMCP'); assert.equal(reopened.source_sha256, exportedHash);
  });
} catch (error) { checks.push({ name: 'suite execution', status: 'failed', error: error.stack }); }
finally {
  await Promise.all(sessions.map(async session => { try { await session.client.close(); } catch {} }));
  await writeFile(join(runDirectory, 'transcript.json'), JSON.stringify(transcript, null, 2));
  const result = {
    server: serverPath, worker: values.worker ?? 'packaged sibling worker', cwd: dirname(serverPath), node: process.version,
    sdk: '1.32.2', passed: checks.filter(c => c.status === 'passed').length, failed: checks.filter(c => c.status === 'failed').length,
    checks, stderr: sessions.map(s => s.stderr.join('')), fixturesAndExports: root,
    evidence: { sourceSha256: beforeHash, exportedSha256: exportedHash, sourceUnchanged: beforeHash === hash(await readFile(join(root, 'nested.pac'))) }
  };
  await writeFile(join(runDirectory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, failed: result.failed, evidence: runDirectory }));
  if (result.failed) process.exitCode = 1;
}

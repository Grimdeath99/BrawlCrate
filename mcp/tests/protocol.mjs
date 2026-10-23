#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import { writeFixtures } from './fixtures.mjs';

const { values } = parseArgs({ options: {
  server: { type: 'string' }, worker: { type: 'string' }, output: { type: 'string' }
}, strict: true });
if (!values.server || !isAbsolute(values.server) || (values.worker && !isAbsolute(values.worker)))
  throw new Error('Usage: node protocol.mjs --server ABSOLUTE_SERVER [--worker ABSOLUTE_EXE] [--output EVIDENCE_DIRECTORY]');
const output = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'brawlcrate-mcp-protocol-'));
await mkdir(output, { recursive: true });
const fixtureRoot = join(output, 'fixtures');
await writeFixtures(fixtureRoot);
const evidence = {
  server: values.server, worker: values.worker ?? 'packaged default', node: process.version,
  started_utc: new Date().toISOString(), checks: [], sessions: [],
  notes: ['Raw stdio JSON-RPC client, independent of the server SDK.',
    'Pre-initialization requests are intentionally not used.',
    'SDK stdio parse errors are verified as stderr diagnostics followed by successful recovery; a JSON-RPC parse-error reply is not claimed.']
};
const children = new Set();
async function check(name, body) {
  try {
    const details = await body();
    evidence.checks.push({ name, status: 'passed', ...(details === undefined ? {} : { details }) });
  } catch (error) {
    evidence.checks.push({ name, status: 'failed', error: error.message });
    throw error;
  }
}

function startSession(revision) {
  const args = [values.server, '--root', fixtureRoot, ...(values.worker ? ['--worker', values.worker] : [])];
  const child = spawn(process.execPath, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const record = { requested_revision: revision, pid: child.pid, command: process.execPath, arguments: args, transcript: [], stderr: '' };
  evidence.sessions.push(record);
  const pending = new Map();
  let sequence = 0;
  let failure;
  const exit = new Promise(resolveExit => child.once('close', (code, signal) => {
    record.exit = { code, signal };
    children.delete(child);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Server exited before its response (${code}, ${signal}): ${record.stderr}`));
    }
    pending.clear();
    resolveExit({ code, signal });
  }));
  child.once('error', error => { failure = error; });
  child.stdin.on('error', error => { failure ??= error; });
  child.stderr.on('data', data => {
    const text = data.toString('utf8');
    record.stderr += text;
    record.transcript.push({ direction: 'stderr', text });
  });
  createInterface({ input: child.stdout }).on('line', line => {
    record.transcript.push({ direction: 'stdout', line });
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0', 'Every stdout line must be a JSON-RPC message.');
      assert(!Array.isArray(message), 'JSON-RPC batches are not emitted.');
      assert(Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error'), 'Expected one result or error envelope.');
      const request = pending.get(message.id);
      assert(request, `Unexpected response ID ${message.id}`);
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message);
    } catch (error) {
      failure = error;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
      child.kill();
    }
  });
  return {
    child, record, exit,
    raw(line) {
      if (failure) throw failure;
      record.transcript.push({ direction: 'stdin', line });
      child.stdin.write(line + '\n');
    },
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = ++sequence;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}. ${record.stderr}`));
        }, 15000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
      });
    },
    async initialize() {
      const reply = await this.request('initialize', {
        protocolVersion: revision, capabilities: {}, clientInfo: { name: 'brawlcrate-raw-protocol-tests', version: '1.0.0' }
      });
      assert(!reply.error, JSON.stringify(reply));
      assert.equal(reply.result.protocolVersion, revision);
      assert.deepEqual(reply.result.capabilities, { tools: {}, resources: {}, prompts: {} });
      assert.equal(reply.result.serverInfo.name, 'brawlcrate');
      record.negotiated_revision = reply.result.protocolVersion;
      this.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      return reply.result;
    },
    async close() {
      child.stdin.end();
      let timer;
      try {
        const result = await Promise.race([exit, new Promise((_, reject) => {
          timer = setTimeout(() => { child.kill(); reject(new Error('Server did not exit within 5 seconds of stdin EOF.')); }, 5000);
        })]);
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
        if (failure) throw failure;
      } finally { clearTimeout(timer); }
    }
  };
}

function successful(reply) {
  assert(!reply.error, JSON.stringify(reply));
  return reply.result;
}
function applicationData(reply) {
  const result = successful(reply);
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent.data;
}
function protocolError(reply, code) {
  assert.equal(reply.error?.code, code, JSON.stringify(reply));
  assert.equal(typeof reply.error.message, 'string');
  assert(!Object.hasOwn(reply, 'result'));
}

async function workerInventory() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-Process -Name BrawlCrate.Mcp.Worker -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 10000 });
    const value = stdout.trim() ? JSON.parse(stdout) : [];
    return new Set(Array.isArray(value) ? value : [value]);
  } catch { return null; }
}

async function findWorker(parentPid, previousInventory) {
  if (process.platform !== 'win32') return { skipped: 'Windows process inventory is unavailable on this OS.' };
  // Get-Process needs no WMI service access. Use this fallback only when there is
  // exactly one newly observed worker; never guess among concurrent sessions.
  const inventory = await workerInventory();
  if (previousInventory && inventory) {
    const added = [...inventory].filter(pid => !previousInventory.has(pid));
    if (added.length === 1) return { pid: added[0] };
  }
  try {
    const command = `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Select-Object ProcessId,Name | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 10000
    });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const worker = list.find(item => item.Name === 'BrawlCrate.Mcp.Worker.exe');
    return worker ? { pid: worker.ProcessId } : { skipped: 'The OS inventory did not expose the worker child process.' };
  } catch (error) { return { skipped: `Process inventory unavailable: ${error.message}` }; }
}

try {
  const previousInventory = await workerInventory();
  const current = startSession('2025-11-25');
  await check('2025-11-25 initialization and exact capability declaration', () => current.initialize());
  await check('ping', async () => assert.deepEqual(successful(await current.request('ping')), {}));
  await check('tool catalogue and schemas', async () => {
    const result = successful(await current.request('tools/list'));
    assert.deepEqual(result.tools.map(tool => tool.name).sort(), [
      'close_document', 'export_document', 'get_document', 'get_status', 'list_children',
      'open_document', 'read_messages', 'rename_node', 'set_message'
    ]);
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.outputSchema.type, 'object');
      assert.equal(typeof tool.description, 'string');
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
    }
    assert.equal(result.nextCursor, undefined);
  });
  let instanceId;
  await check('get_status uses actual application worker', async () => {
    const status = applicationData(await current.request('tools/call', { name: 'get_status', arguments: {} }));
    assert.equal(status.mode, 'headless');
    assert.equal(status.application, 'BrawlCrate');
    assert.equal(status.allow_write, false);
    assert.match(status.instance_id, /^[a-f0-9]{32}$/);
    instanceId = status.instance_id;
  });
  await check('resources list, templates and authoritative status read', async () => {
    const resources = successful(await current.request('resources/list')).resources;
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, 'brawlcrate://session/status');
    assert.equal(resources[0].mimeType, 'application/json');
    const templates = successful(await current.request('resources/templates/list')).resourceTemplates;
    assert.equal(templates.length, 1);
    assert.equal(templates[0].uriTemplate, 'brawlcrate://documents/{document_id}');
    const resource = successful(await current.request('resources/read', { uri: resources[0].uri })).contents[0];
    assert.equal(resource.mimeType, 'application/json');
    assert.equal(JSON.parse(resource.text).instance_id, instanceId);
  });
  await check('prompt discovery/retrieval has no application side effect', async () => {
    const prompts = successful(await current.request('prompts/list')).prompts;
    assert.deepEqual(prompts.map(prompt => prompt.name), ['inspect_archive']);
    const prompt = successful(await current.request('prompts/get', { name: 'inspect_archive', arguments: { path: 'nested.pac' } }));
    assert.equal(prompt.messages[0].role, 'user');
    assert.match(prompt.messages[0].content.text, /open_document/);
    const status = applicationData(await current.request('tools/call', { name: 'get_status' }));
    assert.deepEqual(status.documents, []);
  });
  await check('unknown method returns -32601', async () => protocolError(await current.request('brawlcrate/unknown'), -32601));
  await check('unknown tool returns -32602', async () => protocolError(await current.request('tools/call', { name: 'not_a_tool' }), -32602));
  await check('malformed tool envelope returns -32602', async () => protocolError(await current.request('tools/call', { arguments: {} }), -32602));
  await check('invalid tool arguments are tool errors', async () => {
    const result = successful(await current.request('tools/call', { name: 'open_document', arguments: { path: 42 } }));
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'invalid_arguments');
  });
  await check('unknown resources and prompts return protocol errors', async () => {
    protocolError(await current.request('resources/read', { uri: 'brawlcrate://missing' }), -32002);
    protocolError(await current.request('prompts/get', { name: 'missing' }), -32602);
  });
  await check('malformed JSON diagnostic and subsequent request recovery', async () => {
    const previous = current.record.stderr.length;
    current.raw('{invalid json');
    assert.deepEqual(successful(await current.request('ping')), {});
    // stdout/stderr are separate OS pipes; the diagnostic may arrive after the response.
    if (current.record.stderr.length === previous) await new Promise(resolveWait => setTimeout(resolveWait, 100));
    assert.match(current.record.stderr.slice(previous), /MCP protocol error/);
  });
  const worker = await findWorker(current.child.pid, previousInventory);
  await check('stdin EOF exits server cleanly', () => current.close());
  if (worker.pid) {
    await check('worker process exits with its server', async () => {
      let running = true;
      try { process.kill(worker.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
      assert.equal(running, false, `Worker PID ${worker.pid} remains alive after server EOF.`);
      return { observed_worker_pid: worker.pid };
    });
  } else evidence.checks.push({ name: 'worker process exits with its server', status: 'skipped', reason: worker.skipped });
  const older = startSession('2024-11-05');
  await check('2024-11-05 negotiation and application call', async () => {
    await older.initialize();
    const status = applicationData(await older.request('tools/call', { name: 'get_status', arguments: {} }));
    assert.equal(status.mode, 'headless');
    assert.notEqual(status.instance_id, instanceId);
    assert.deepEqual(status.documents, []);
  });
  await check('older revision EOF exits cleanly', () => older.close());
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = error.stack;
  process.exitCode = 1;
} finally {
  for (const child of children) {
    child.stdin.end();
    child.kill();
  }
  evidence.completed_utc = new Date().toISOString();
  await writeFile(join(output, 'protocol-results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, passed: evidence.checks.filter(item => item.status === 'passed').length,
    failed: evidence.checks.filter(item => item.status === 'failed').length,
    skipped: evidence.checks.filter(item => item.status === 'skipped').length,
    evidence: join(output, 'protocol-results.json'), ...(evidence.failure ? { failure: evidence.failure } : {}) }, null, 2));
}

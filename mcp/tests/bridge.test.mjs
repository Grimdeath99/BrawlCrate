// These tests exercise only the IPC/lifecycle boundary with a deliberately slow
// disposable child. Actual BrawlLib effects are verified by integration.mjs.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WorkerBridge } from '../lib/worker-bridge.mjs';

const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe');
const enabled = process.platform === 'win32' && existsSync(csc);
const run = enabled ? test : test.skip;
let directory;
let worker;
let sequence = 0;

before(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), 'brawlcrate-mcp-bridge-'));
  worker = join(directory, 'BridgeFixture.exe');
  const source = join(directory, 'BridgeFixture.cs');
  await writeFile(source, `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
class BridgeFixture {
  static void Main(string[] args) {
    string root = args[1];
    File.WriteAllText(Path.Combine(root, "pid.txt"), Process.GetCurrentProcess().Id.ToString());
    if (File.Exists(Path.Combine(root, "stall-readiness"))) Thread.Sleep(5000);
    var json = new JavaScriptSerializer();
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.AutoFlush = true;
    string line;
    while ((line = Console.ReadLine()) != null) {
      var request = json.DeserializeObject(line) as Dictionary<string, object>;
      string method = (string)request["method"];
      var arguments = (Dictionary<string, object>)request["arguments"];
      File.AppendAllText(Path.Combine(root, "calls.jsonl"), line + "\\n");
      if (method == "delay") Thread.Sleep(Convert.ToInt32(arguments["milliseconds"]));
      if (method == "exit") Environment.Exit(27);
      if (method == "malformed") { output.WriteLine("not-json"); continue; }
      if (method == "oversized") { output.WriteLine(new string('x', 1048577)); continue; }
      if (method == "fail") {
        output.WriteLine(json.Serialize(new { id = request["id"], error = new { code = "EXPECTED_ERROR", message = "Fixture failure" } }));
      } else {
        output.WriteLine(json.Serialize(new { id = request["id"], result = new { pid = Process.GetCurrentProcess().Id, method = method, arguments = arguments } }));
      }
    }
  }
}`);
  const compiled = spawnSync(csc, ['/nologo', '/target:exe', `/out:${worker}`, '/reference:System.Web.Extensions.dll', source], {
    encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

after(async () => {
  if (directory) {
    assert.equal(dirname(resolve(directory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('brawlcrate-mcp-bridge-'));
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(t, timeoutMs = 3000) {
  const root = join(directory, `case-${++sequence}`);
  await mkdir(root);
  const bridge = new WorkerBridge({ worker, root, allowWrite: false, timeoutMs });
  t.after(() => bridge.close());
  const { pid } = await bridge.call('get_status', {});
  return { bridge, root, pid };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(message);
}

async function waitForExit(pid) {
  await waitFor(() => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, `Child process ${pid} did not exit.`);
}

run('serial IPC preserves real replies and application errors leave worker usable', async t => {
  const { bridge } = await fixture(t);
  await assert.rejects(bridge.call('fail', {}), error => error.code === 'EXPECTED_ERROR');
  const replies = await Promise.all([bridge.call('echo', { value: 'first' }), bridge.call('echo', { value: 'second' })]);
  assert.deepEqual(replies.map(reply => reply.arguments.value), ['first', 'second']);
});

run('queued cancellation never dispatches the cancelled operation', async t => {
  const { bridge, root } = await fixture(t);
  const running = bridge.call('delay', { milliseconds: 250 });
  const abort = new AbortController();
  const cancelled = assert.rejects(bridge.call('echo', { value: 'cancelled' }, abort.signal), error => error.code === 'cancelled');
  abort.abort();
  await Promise.all([running, cancelled]);
  assert.equal((await bridge.call('echo', { value: 'after' })).arguments.value, 'after');
  assert.equal((await readFile(join(root, 'calls.jsonl'), 'utf8')).includes('cancelled'), false);
});

run('active cancellation kills child and invalidates queued and future requests', async t => {
  const { bridge, root, pid } = await fixture(t);
  const abort = new AbortController();
  const running = assert.rejects(bridge.call('delay', { milliseconds: 5000 }, abort.signal), error => error.code === 'cancelled');
  const queued = assert.rejects(bridge.call('echo', {}), error => error.code === 'cancelled');
  await waitFor(async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).includes('delay'), 'Delay was not dispatched.');
  abort.abort();
  await Promise.all([running, queued]);
  await assert.rejects(bridge.call('get_status', {}), error => error.code === 'cancelled');
  await bridge.close();
  await waitForExit(pid);
});

run('active deadline kills child without automatically restarting or retrying', async t => {
  const { bridge, pid } = await fixture(t, 300);
  await assert.rejects(bridge.call('delay', { milliseconds: 5000 }), error => error.code === 'timeout');
  await assert.rejects(bridge.call('get_status', {}), error => error.code === 'timeout');
  await bridge.close();
  await waitForExit(pid);
});

run('queue applies a bounded 64-request admission limit', async t => {
  const { bridge } = await fixture(t);
  const running = bridge.call('delay', { milliseconds: 200 });
  const queued = Array.from({ length: 64 }, (_, index) => bridge.call('echo', { index }));
  await assert.rejects(bridge.call('echo', {}), error => error.code === 'busy');
  await running;
  const replies = await Promise.all(queued);
  assert.equal(replies.length, 64);
  assert.deepEqual(replies.map(reply => reply.arguments.index), Array.from({ length: 64 }, (_, index) => index));
});

for (const method of ['malformed', 'oversized']) {
  run(`${method} worker output invalidates session and cleans up child`, async t => {
    const { bridge, pid } = await fixture(t);
    await assert.rejects(bridge.call(method, {}), error => error.code === 'worker_protocol_error');
    await bridge.close();
    await waitForExit(pid);
  });
}

run('unexpected child exit rejects pending work', async t => {
  const { bridge, pid } = await fixture(t);
  await assert.rejects(bridge.call('exit', {}), error => error.code === 'worker_exited' || error.code === 'worker_unavailable');
  await bridge.close();
  await waitForExit(pid);
});

run('MCP client disconnect closes server and its child process', async t => {
  const root = join(directory, `case-${++sequence}`);
  await mkdir(root);
  const server = resolve(dirname(fileURLToPath(import.meta.url)), '../server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--root', root, '--worker', worker], stderr: 'pipe' });
  const client = new Client({ name: 'bridge-lifecycle-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const reply = await client.callTool({ name: 'get_status', arguments: {} });
  const pid = reply.structuredContent.data.pid;
  await client.close();
  await waitForExit(pid);
});

run('stdin EOF during worker readiness shuts down promptly', async t => {
  const root = join(directory, `case-${++sequence}`);
  await mkdir(root);
  await writeFile(join(root, 'stall-readiness'), '');
  const server = resolve(dirname(fileURLToPath(import.meta.url)), '../server.mjs');
  const child = spawn(process.execPath, [server, '--root', root, '--worker', worker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await waitFor(() => existsSync(join(root, 'pid.txt')), 'Readiness child did not start.');
  const pid = Number(await readFile(join(root, 'pid.txt'), 'utf8'));
  child.stdin.end();
  await waitFor(() => child.exitCode !== null, 'Server did not exit after stdin EOF during startup.');
  assert.equal(await exited, 0);
  await waitForExit(pid);
});

import { spawn } from 'node:child_process';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_QUEUE = 64;

export class WorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
  }
}

// BrawlLib is not thread safe. Only one request is ever in flight in its dedicated
// process. A timed-out active operation has an uncertain outcome, so the process
// is terminated and all document handles are invalidated instead of retrying.
export class WorkerBridge {
  #child;
  #queue = [];
  #active;
  #nextId = 0;
  #buffer = Buffer.alloc(0);
  #failure;
  #timeout;
  #exited;

  constructor({ worker, root, allowWrite, timeoutMs }) {
    this.#timeout = timeoutMs;
    this.#child = spawn(worker, ['--root', root, ...(allowWrite ? ['--allow-write'] : [])], {
      cwd: root,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.#exited = new Promise(resolve => this.#child.once('close', resolve));
    this.#child.stdout.on('data', chunk => this.#onData(chunk));
    // Drain diagnostics without placing application output on the MCP stream.
    this.#child.stderr.on('data', chunk => { process.stderr.write(chunk); });
    this.#child.stdin.on('error', () => this.#invalidate('worker_unavailable', 'The application worker input closed. Restart the MCP session.'));
    this.#child.on('error', error => this.#invalidate('worker_unavailable', `Cannot start the application worker: ${error.message}`));
    this.#child.on('exit', (code, signal) => this.#invalidate('worker_exited', `Application worker exited (${signal ?? code}). All document handles are invalid. Restart the MCP session.`));
  }

  call(method, args, signal) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(new WorkerError('cancelled', 'Request cancelled before execution.'));
    if (this.#queue.length >= MAX_QUEUE) return Promise.reject(new WorkerError('busy', 'Application request queue is full (64 queued requests).'));
    return new Promise((resolve, reject) => {
      const item = { id: ++this.#nextId, method, args, resolve, reject, signal };
      item.cancel = () => {
        if (item === this.#active) {
          this.#invalidate('cancelled', 'Active application request was cancelled. Its outcome may be uncertain; all document handles are invalid. Restart the MCP session and inspect any export before retrying.');
        } else {
          this.#removeQueued(item, new WorkerError('cancelled', 'Request cancelled before execution.'));
        }
      };
      item.timer = setTimeout(() => {
        if (item === this.#active) {
          this.#invalidate('timeout', 'Application request exceeded its deadline. Its outcome may be uncertain; all document handles are invalid. Restart the MCP session and inspect any export before retrying.');
        } else {
          this.#removeQueued(item, new WorkerError('timeout', 'Request exceeded its deadline while queued and was not executed.'));
        }
      }, this.#timeout);
      signal?.addEventListener('abort', item.cancel, { once: true });
      this.#queue.push(item);
      this.#dispatch();
    });
  }

  #removeQueued(item, error) {
    const index = this.#queue.indexOf(item);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#finish(item, error);
  }

  #finish(item, error, result) {
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.cancel);
    if (error) item.reject(error);
    else item.resolve(result);
  }

  #dispatch() {
    if (this.#active || this.#failure || this.#queue.length === 0) return;
    this.#active = this.#queue.shift();
    const { id, method, args } = this.#active;
    this.#child.stdin.write(JSON.stringify({ id, method, arguments: args }) + '\n');
  }

  #onData(chunk) {
    if (this.#failure) return;
    if (this.#buffer.length + chunk.length > MAX_LINE_BYTES) {
      this.#invalidate('worker_protocol_error', 'Application worker response exceeded the 1 MiB IPC limit.');
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let end;
    while ((end = this.#buffer.indexOf(10)) >= 0) {
      const line = this.#buffer.subarray(0, end).toString('utf8');
      this.#buffer = this.#buffer.subarray(end + 1);
      let reply;
      try {
        reply = JSON.parse(line);
        if (!this.#active || reply.id !== this.#active.id ||
            (!!Object.hasOwn(reply, 'error') === !!Object.hasOwn(reply, 'result')) ||
            (Object.hasOwn(reply, 'error') && (typeof reply.error?.code !== 'string' || typeof reply.error?.message !== 'string'))) {
          throw new Error('Unexpected application response envelope.');
        }
      } catch {
        this.#invalidate('worker_protocol_error', 'Application worker returned an invalid IPC response. All document handles are invalid.');
        return;
      }
      const item = this.#active;
      this.#active = undefined;
      this.#finish(item, reply.error ? new WorkerError(reply.error.code, reply.error.message) : undefined, reply.result);
      this.#dispatch();
    }
  }

  #invalidate(code, message) {
    if (this.#failure) return;
    this.#failure = new WorkerError(code, message);
    if (this.#active) this.#finish(this.#active, this.#failure);
    this.#active = undefined;
    for (const item of this.#queue) this.#finish(item, this.#failure);
    this.#queue = [];
    this.#buffer = Buffer.alloc(0);
    this.#child.stdin.destroy();
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill();
  }

  async close() {
    this.#invalidate('session_closed', 'MCP session closed. All document handles are invalid.');
    // Windows terminates the child directly; POSIX gets a bounded grace period.
    let timer;
    await Promise.race([this.#exited, new Promise(resolve => {
      timer = setTimeout(() => { this.#child.kill('SIGKILL'); resolve(); }, 1500);
    })]);
    clearTimeout(timer);
  }
}

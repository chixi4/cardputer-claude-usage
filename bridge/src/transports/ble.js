import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'ble-worker.js');

function nowIso() {
  return new Date().toISOString();
}

export class BLEManager {
  constructor({
    autoConnect = false,
    chunkSize = 18,
    scanTimeoutMs = 15_000,
  } = {}) {
    this.autoConnect = autoConnect;
    this.chunkSize = Math.max(8, Math.min(180, chunkSize));
    this.scanTimeoutMs = scanTimeoutMs;
    this.state = 'idle';
    this.lastError = null;
    this.lastConnectAttemptAt = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastWriteAt = null;
    this.bytesWritten = 0;
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.backoffMs = 5_000;
  }

  isConnected() {
    return this.state === 'connected';
  }

  status() {
    return {
      kind: 'ble',
      enabled: Boolean(this.autoConnect),
      state: this.state,
      adapter_state: null,
      device_name: 'Claude-Usage',
      service_uuid: 'cafe1234567812345678123456789abc',
      characteristic_uuid: 'cafe567812345678123456789abcdef0',
      connected: this.isConnected(),
      worker_pid: this.worker?.pid ?? null,
      last_error: this.lastError,
      last_connect_attempt_at: this.lastConnectAttemptAt,
      last_connected_at: this.lastConnectedAt,
      last_disconnected_at: this.lastDisconnectedAt,
      last_write_at: this.lastWriteAt,
      bytes_written: this.bytesWritten,
      chunk_size: this.chunkSize,
    };
  }

  ensureWorker() {
    if (this.worker && !this.worker.killed) return this.worker;

    const child = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        BLE_CHUNK_SIZE: String(this.chunkSize),
        BLE_SCAN_TIMEOUT_MS: String(this.scanTimeoutMs),
      },
    });

    this.worker = child;
    this.state = this.state === 'idle' ? 'worker-ready' : this.state;
    this.lastError = null;

    child.on('message', (message) => this.handleWorkerMessage(message));
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.worker = null;
      if (child.intentionalClose) {
        this.state = 'idle';
        this.lastDisconnectedAt = nowIso();
        return;
      }
      this.state = 'error';
      this.lastError = `BLE worker exited (${reason})`;
      this.lastDisconnectedAt = nowIso();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(this.lastError));
      }
      this.pending.clear();
      this.scheduleReconnect();
    });

    return child;
  }

  handleWorkerMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'status' && message.status) {
      this.applyWorkerStatus(message.status);
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) {
        if (message.status) this.applyWorkerStatus(message.status);
        pending.resolve(message.result ?? message.status ?? this.status());
      } else {
        this.lastError = message.error || 'BLE worker command failed';
        this.state = 'error';
        pending.reject(new Error(this.lastError));
      }
    }
  }

  applyWorkerStatus(status) {
    this.state = status.state || this.state;
    this.lastError = status.last_error || null;
    this.lastConnectAttemptAt = status.last_connect_attempt_at || this.lastConnectAttemptAt;
    this.lastConnectedAt = status.last_connected_at || this.lastConnectedAt;
    this.lastDisconnectedAt = status.last_disconnected_at || this.lastDisconnectedAt;
    this.lastWriteAt = status.last_write_at || this.lastWriteAt;
    this.bytesWritten = status.bytes_written ?? this.bytesWritten;
  }

  request(cmd, payload = {}, timeoutMs = 30_000) {
    const child = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BLE ${cmd} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, cmd, payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  startAutoConnect() {
    this.autoConnect = true;
    this.scheduleReconnect(500);
  }

  stopAutoConnect() {
    this.autoConnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect(delayMs = this.backoffMs) {
    if (!this.autoConnect || this.reconnectTimer || this.isConnected()) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.backoffMs = 5_000;
      } catch {
        this.backoffMs = Math.min(Math.round(this.backoffMs * 1.7), 60_000);
        this.scheduleReconnect(this.backoffMs);
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  async connect({ timeoutMs = this.scanTimeoutMs } = {}) {
    this.lastConnectAttemptAt = nowIso();
    this.state = 'connecting';
    const result = await this.request('connect', { timeoutMs }, timeoutMs + 5_000);
    this.applyWorkerStatus(result);
    return this.status();
  }

  async disconnect() {
    this.stopAutoConnect();
    if (!this.worker) {
      this.state = 'idle';
      this.lastDisconnectedAt = nowIso();
      return this.status();
    }

    await this.request('disconnect', {}, 5_000).catch((error) => {
      this.lastError = error.message;
    });
    this.worker.intentionalClose = true;
    this.worker.kill();
    this.worker = null;
    this.state = 'idle';
    this.lastDisconnectedAt = nowIso();
    return this.status();
  }

  async write(payloadLine) {
    if (!this.isConnected()) {
      throw new Error('BLE is not connected');
    }
    const result = await this.request('write', { payloadLine }, 15_000);
    this.applyWorkerStatus(result);
    return { ok: true, bytes: Buffer.byteLength(payloadLine) };
  }

  async stop() {
    this.stopAutoConnect();
    await this.disconnect().catch(() => {});
  }
}

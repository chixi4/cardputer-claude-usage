import { SerialPort } from 'serialport';

function portScore(port) {
  const text = [
    port.path,
    port.manufacturer,
    port.friendlyName,
    port.vendorId,
    port.productId,
  ].filter(Boolean).join(' ').toLowerCase();

  let score = 0;
  if (text.includes('303a')) score += 5;
  if (text.includes('esp')) score += 5;
  if (text.includes('usbmodem')) score += 3;
  if (text.includes('usbserial')) score += 2;
  if (text.includes('wch') || text.includes('ch340')) score += 2;
  return score;
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    port.open((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function writeAndDrain(port, payload) {
  return new Promise((resolve, reject) => {
    port.write(payload, (writeError) => {
      if (writeError) {
        reject(writeError);
        return;
      }
      port.drain((drainError) => {
        if (drainError) reject(drainError);
        else resolve();
      });
    });
  });
}

export class USBManager {
  constructor({ baudRate = 115_200, autoPath = '' } = {}) {
    this.baudRate = baudRate;
    this.autoPath = autoPath;
    this.port = null;
    this.path = null;
    this.state = 'idle';
    this.lastError = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastWriteAt = null;
    this.bytesWritten = 0;
  }

  isConnected() {
    return Boolean(this.port?.isOpen);
  }

  async listPorts() {
    const ports = await SerialPort.list();
    return ports
      .map((port) => ({
        path: port.path,
        manufacturer: port.manufacturer || null,
        serialNumber: port.serialNumber || null,
        vendorId: port.vendorId || null,
        productId: port.productId || null,
        score: portScore(port),
      }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }

  async choosePort(path) {
    if (path) return path;
    if (this.autoPath) return this.autoPath;
    const ports = await this.listPorts();
    const best = ports.find((port) => port.score > 0) || ports[0];
    if (!best) throw new Error('No serial ports were found');
    return best.path;
  }

  status() {
    return {
      kind: 'usb',
      state: this.isConnected() ? 'connected' : this.state,
      connected: this.isConnected(),
      path: this.path,
      baud_rate: this.baudRate,
      last_error: this.lastError,
      last_connected_at: this.lastConnectedAt,
      last_disconnected_at: this.lastDisconnectedAt,
      last_write_at: this.lastWriteAt,
      bytes_written: this.bytesWritten,
    };
  }

  async connect(path) {
    const selectedPath = await this.choosePort(path);
    if (this.isConnected() && this.path === selectedPath) return this.status();
    await this.disconnect().catch(() => {});

    this.state = 'connecting';
    this.lastError = null;
    const port = new SerialPort({
      path: selectedPath,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    port.on('error', (error) => {
      this.lastError = error.message;
      this.state = 'error';
    });
    port.on('close', () => {
      this.state = 'disconnected';
      this.lastDisconnectedAt = new Date().toISOString();
    });

    try {
      await openPort(port);
      await new Promise((resolve) => {
        port.set({ dtr: false, rts: false }, () => resolve());
      });
      this.port = port;
      this.path = selectedPath;
      this.state = 'connected';
      this.lastConnectedAt = new Date().toISOString();
      return this.status();
    } catch (error) {
      this.state = 'error';
      this.lastError = error.message;
      this.port = null;
      this.path = selectedPath;
      throw error;
    }
  }

  async disconnect() {
    const port = this.port;
    this.port = null;
    if (!port) return this.status();
    await new Promise((resolve) => {
      if (!port.isOpen) {
        resolve();
        return;
      }
      port.close(() => resolve());
    });
    this.state = 'idle';
    this.lastDisconnectedAt = new Date().toISOString();
    return this.status();
  }

  async write(payloadLine) {
    if (!this.isConnected()) {
      throw new Error('USB serial is not connected');
    }
    await writeAndDrain(this.port, payloadLine);
    this.bytesWritten += Buffer.byteLength(payloadLine);
    this.lastWriteAt = new Date().toISOString();
    this.lastError = null;
    return { ok: true, bytes: Buffer.byteLength(payloadLine) };
  }
}

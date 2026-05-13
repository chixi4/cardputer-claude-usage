import noble from '@abandonware/noble';

const BLE_SERVICE_UUID = 'cafe1234567812345678123456789abc';
const BLE_CHAR_UUID = 'cafe567812345678123456789abcdef0';
const BLE_DEVICE_NAME = 'Claude-Usage';
const CHUNK_SIZE = Math.max(8, Math.min(180, Number.parseInt(process.env.BLE_CHUNK_SIZE || '18', 10)));
const SCAN_TIMEOUT_MS = Number.parseInt(process.env.BLE_SCAN_TIMEOUT_MS || '15000', 10);

function cleanUuid(value) {
  return String(value || '').replaceAll('-', '').toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

class LowLevelBLE {
  constructor() {
    this.state = 'idle';
    this.lastError = null;
    this.lastConnectAttemptAt = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastWriteAt = null;
    this.bytesWritten = 0;
    this.peripheral = null;
    this.characteristic = null;
  }

  isConnected() {
    return Boolean(this.characteristic && this.peripheral?.state === 'connected');
  }

  status() {
    return {
      state: this.isConnected() ? 'connected' : this.state,
      adapter_state: noble.state,
      connected: this.isConnected(),
      last_error: this.lastError,
      last_connect_attempt_at: this.lastConnectAttemptAt,
      last_connected_at: this.lastConnectedAt,
      last_disconnected_at: this.lastDisconnectedAt,
      last_write_at: this.lastWriteAt,
      bytes_written: this.bytesWritten,
    };
  }

  async waitForPoweredOn(timeoutMs = 10_000) {
    if (noble.state === 'poweredOn') return;
    if (noble.state === 'poweredOff') throw new Error('Bluetooth is off in macOS settings');
    if (noble.state === 'unsupported') throw new Error('Bluetooth adapter is unsupported');

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Bluetooth adapter did not become ready (${noble.state})`));
      }, timeoutMs);
      const onState = (state) => {
        if (state === 'poweredOn') {
          cleanup();
          resolve();
        } else if (state === 'poweredOff' || state === 'unsupported') {
          cleanup();
          reject(new Error(`Bluetooth adapter is ${state}`));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        noble.removeListener('stateChange', onState);
      };
      noble.on('stateChange', onState);
    });
  }

  async startScanning() {
    if (noble.startScanningAsync) {
      await noble.startScanningAsync([BLE_SERVICE_UUID], false);
      return;
    }
    await new Promise((resolve, reject) => {
      noble.startScanning([BLE_SERVICE_UUID], false, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async stopScanning() {
    if (noble.stopScanningAsync) {
      await noble.stopScanningAsync().catch(() => {});
      return;
    }
    noble.stopScanning?.();
  }

  matchesDevice(peripheral) {
    const name = peripheral?.advertisement?.localName;
    const serviceUuids = peripheral?.advertisement?.serviceUuids || [];
    return name === BLE_DEVICE_NAME || serviceUuids.map(cleanUuid).includes(BLE_SERVICE_UUID);
  }

  async findPeripheral(timeoutMs) {
    this.state = 'scanning';
    await this.startScanning();

    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Cardputer BLE device not found after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        const onDiscover = (peripheral) => {
          if (!this.matchesDevice(peripheral)) return;
          cleanup();
          resolve(peripheral);
        };
        const cleanup = () => {
          clearTimeout(timer);
          noble.removeListener('discover', onDiscover);
        };
        noble.on('discover', onDiscover);
      });
    } finally {
      await this.stopScanning();
    }
  }

  async connect(timeoutMs = SCAN_TIMEOUT_MS) {
    if (this.isConnected()) return this.status();
    this.lastConnectAttemptAt = nowIso();
    this.lastError = null;

    try {
      this.state = 'waiting-adapter';
      await this.waitForPoweredOn(Math.min(timeoutMs, 10_000));
      const peripheral = await this.findPeripheral(timeoutMs);
      this.state = 'connecting';
      await peripheral.connectAsync();

      const services = await peripheral.discoverServicesAsync([BLE_SERVICE_UUID]);
      if (!services.length) throw new Error('Cardputer BLE service was not found');

      const characteristics = await services[0].discoverCharacteristicsAsync([BLE_CHAR_UUID]);
      if (!characteristics.length) throw new Error('Cardputer BLE write characteristic was not found');

      peripheral.removeAllListeners?.('disconnect');
      peripheral.on('disconnect', () => {
        this.peripheral = null;
        this.characteristic = null;
        this.state = 'disconnected';
        this.lastDisconnectedAt = nowIso();
        sendStatus();
      });

      this.peripheral = peripheral;
      this.characteristic = characteristics[0];
      this.state = 'connected';
      this.lastConnectedAt = nowIso();
      return this.status();
    } catch (error) {
      this.peripheral = null;
      this.characteristic = null;
      this.state = 'error';
      this.lastError = error.message;
      throw error;
    }
  }

  async disconnect() {
    const peripheral = this.peripheral;
    this.peripheral = null;
    this.characteristic = null;
    if (peripheral?.state === 'connected') {
      await peripheral.disconnectAsync().catch(() => {});
    }
    this.state = 'idle';
    this.lastDisconnectedAt = nowIso();
    return this.status();
  }

  async write(payloadLine) {
    if (!this.isConnected()) {
      throw new Error('BLE is not connected');
    }
    const data = Buffer.from(payloadLine, 'utf8');
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length));
      await this.characteristic.writeAsync(chunk, false);
      if (offset + CHUNK_SIZE < data.length) await sleep(8);
    }
    this.bytesWritten += data.length;
    this.lastWriteAt = nowIso();
    this.lastError = null;
    return this.status();
  }
}

const ble = new LowLevelBLE();

function sendStatus() {
  process.send?.({ type: 'status', status: ble.status() });
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return;
  const { id, cmd, payload = {} } = message;
  try {
    let result;
    if (cmd === 'connect') result = await ble.connect(payload.timeoutMs);
    else if (cmd === 'disconnect') result = await ble.disconnect();
    else if (cmd === 'write') result = await ble.write(payload.payloadLine);
    else if (cmd === 'status') result = ble.status();
    else if (cmd === 'stop') {
      result = await ble.disconnect();
      process.send?.({ id, ok: true, result, status: ble.status() });
      process.exit(0);
      return;
    } else {
      throw new Error(`Unknown BLE command: ${cmd}`);
    }
    process.send?.({ id, ok: true, result, status: ble.status() });
  } catch (error) {
    process.send?.({ id, ok: false, error: error.message, status: ble.status() });
  }
});

sendStatus();

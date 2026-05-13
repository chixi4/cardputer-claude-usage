# Claude Usage Monitor for Cardputer

[English](#english) | [中文](#中文)

---

<a id="english"></a>

# Claude Usage Monitor for Cardputer

Show Claude Pro/Max usage on an M5Stack Cardputer/Cardputer ADV. The Mac keeps
all Claude credentials; the Cardputer only receives a compact JSON line over
Bluetooth.

## Current Architecture

```text
Claude Code OAuth credentials on Mac
  -> local Node bridge calls Anthropic OAuth usage API
  -> desktop setup dashboard at http://localhost:8787/
  -> browser Web Bluetooth push to Cardputer
```

Claude tokens never go onto the ESP32.
The bridge does not open native BLE, USB, or Wi-Fi device transports; the browser
owns the Bluetooth permission and connection.

## Mac Bridge

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/bridge
npm install
npm start
```

Open:

```text
http://localhost:8787/
```

Useful checks:

```bash
curl http://localhost:8787/api/status
curl http://localhost:8787/api/usage
curl http://localhost:8787/api/device-payload
```

Optional LAN protection:

```bash
BRIDGE_TOKEN="choose-a-long-random-value" npm start
```

If `BRIDGE_TOKEN` is set, API calls need `X-Bridge-Token`.

## Data Source

The bridge reads OAuth credentials in this order:

1. `CLAUDE_USAGE_ACCESS_TOKEN` or `ANTHROPIC_ACCESS_TOKEN`
2. macOS Keychain item `Claude Code-credentials`
3. `~/.claude/.credentials.json`

It calls Anthropic's OAuth usage endpoint with the `oauth-2025-04-20` beta
header. This endpoint is community-discovered rather than a public stability
contract, so the dashboard surfaces real errors instead of silently pretending
demo data is live.

## Bluetooth Flow

- First use: open the dashboard, confirm Claude Auth, then click Scan and
  connect. Choose `Claude-Usage` in the browser Bluetooth picker.
- Later use: open the dashboard. Chrome/Edge can reuse the previously granted
  Bluetooth device and reconnect automatically.
- Wi-Fi and USB data paths are not part of this build.
- Web Bluetooth requires Chrome or Edge on macOS. Safari does not expose this
  API.

## Firmware Build And Flash

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/firmware
pio run -e m5stack-cardputer
pio run -e m5stack-cardputer -t upload --upload-port /dev/cu.usbmodem12201
```

If normal upload reaches `Running stub...` and then fails, this board has worked
with esptool's no-stub path:

```bash
/opt/homebrew/Cellar/platformio/6.1.19_1/libexec/bin/python \
  /Users/yuookie/.platformio/packages/tool-esptoolpy/esptool.py \
  --chip esp32s3 --port /dev/cu.usbmodem12201 --baud 115200 \
  --before default_reset --after hard_reset --no-stub write_flash -z \
  --flash_mode dio --flash_freq 80m --flash_size 8MB \
  0x0000 .pio/build/m5stack-cardputer/bootloader.bin \
  0x8000 .pio/build/m5stack-cardputer/partitions.bin \
  0xe000 /Users/yuookie/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin \
  0x10000 .pio/build/m5stack-cardputer/firmware.bin
```

## Device UI

The Cardputer shows:

- setup/waiting screen before data arrives
- BLE advertising/connected state
- malformed JSON and bridge error messages
- stale data warning after no fresh push
- actual battery level as four blocks; one-block and empty battery are red
- dimmed backlight after inactivity and lower brightness on low battery
- bottom status line for important states; when idle, it rotates the orange
  words every pseudo-random 5 to 15 seconds, matching the web preview seed

## Tests

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/bridge
npm run verify

cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/firmware
pio run -e m5stack-cardputer
```

The bridge tests cover payload framing, usage normalization, status API, and
push behavior. The firmware build is the regression gate for the embedded side.

---

<a id="中文"></a>

# Cardputer Claude 用量监控

在 M5Stack Cardputer / Cardputer ADV 上显示 Claude Pro/Max 的 API 用量。Mac 持有所有 Claude 凭证，Cardputer 仅通过蓝牙接收一行紧凑的 JSON 数据。

## 当前架构

```text
Mac 上的 Claude Code OAuth 凭证
  → 本地 Node 桥接调用 Anthropic OAuth 用量 API
  → 桌面仪表盘 http://localhost:8787/
  → 浏览器 Web Bluetooth 推送到 Cardputer
```

Claude Token 永远不会进入 ESP32。
桥接不直接操作蓝牙、USB 或 Wi-Fi 设备；蓝牙权限和连接由浏览器管理。

## Mac 桥接

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/bridge
npm install
npm start
```

打开：

```text
http://localhost:8787/
```

检查：

```bash
curl http://localhost:8787/api/status
curl http://localhost:8787/api/usage
curl http://localhost:8787/api/device-payload
```

局域网保护（可选）：

```bash
BRIDGE_TOKEN="设置一个随机长字符串" npm start
```

设置 `BRIDGE_TOKEN` 后，API 请求需要携带 `X-Bridge-Token` 头。

## 数据来源

桥接按以下顺序读取 OAuth 凭证：

1. 环境变量 `CLAUDE_USAGE_ACCESS_TOKEN` 或 `ANTHROPIC_ACCESS_TOKEN`
2. macOS 钥匙串条目 `Claude Code-credentials`
3. `~/.claude/.credentials.json` 文件

然后调用 Anthropic 的 OAuth 用量接口（使用 `oauth-2025-04-20` beta 头）。该接口是社区发现的，并非公开稳定合约，因此仪表盘会显示真实错误，而不是静默使用 Demo 数据。

## 蓝牙流程

- **首次使用**：打开仪表盘，确认 Claude 认证，点击"扫描并连接"，在浏览器蓝牙选择器中选择 `Claude-Usage`
- **后续使用**：打开仪表盘，Chrome/Edge 可复用已授权的蓝牙设备并自动重连
- **Wi-Fi 和 USB 数据通路不在本版本中**
- Web Bluetooth 需要 macOS 上的 Chrome 或 Edge，Safari 不支持此 API

## 固件编译与烧录

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/firmware
pio run -e m5stack-cardputer
pio run -e m5stack-cardputer -t upload --upload-port /dev/cu.usbmodem12201
```

如果正常上传卡在 `Running stub...` 后失败，可以用 esptool 的无 stub 方式烧录：

```bash
/opt/homebrew/Cellar/platformio/6.1.19_1/libexec/bin/python \
  /Users/yuookie/.platformio/packages/tool-esptoolpy/esptool.py \
  --chip esp32s3 --port /dev/cu.usbmodem12201 --baud 115200 \
  --before default_reset --after hard_reset --no-stub write_flash -z \
  --flash_mode dio --flash_freq 80m --flash_size 8MB \
  0x0000 .pio/build/m5stack-cardputer/bootloader.bin \
  0x8000 .pio/build/m5stack-cardputer/partitions.bin \
  0xe000 /Users/yuookie/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin \
  0x10000 .pio/build/m5stack-cardputer/firmware.bin
```

## 设备界面

Cardputer 屏幕显示：

- 数据到达前的设置/等待画面
- BLE 广播/连接状态
- JSON 格式错误和桥接错误信息
- 长时间未推送时的数据过期警告
- 实际电池电量（4 格显示，1 格及空电显示红色）
- 无操作时自动调暗背光，低电量时降低亮度
- 底部状态行显示重要状态；空闲时每 5-15 秒伪随机轮换橙色单词

## 测试

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/bridge
npm run verify

cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/firmware
pio run -e m5stack-cardputer
```

桥接测试覆盖了载荷组装、用量归一化、状态 API 和推送行为。固件编译是嵌入式端的回归门禁。

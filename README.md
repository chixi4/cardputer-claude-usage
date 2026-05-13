# Claude Usage Monitor for Cardputer

Show Claude Pro/Max usage on an M5Stack Cardputer/Cardputer ADV. The Mac keeps
all Claude credentials; the Cardputer only receives a compact JSON line over USB
serial or BLE.

## Current Architecture

```text
Claude Code OAuth credentials on Mac
  -> local Node bridge calls Anthropic OAuth usage API
  -> desktop setup dashboard at http://localhost:8787/
  -> USB serial push to Cardputer
  -> optional BLE push via isolated worker process
```

Claude tokens never go onto the ESP32.

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
curl -X POST "http://localhost:8787/api/push?mode=force&target=usb"
```

Optional LAN protection:

```bash
BRIDGE_TOKEN="choose-a-long-random-value" npm start
```

If `BRIDGE_TOKEN` is set, the dashboard has a local token box and API calls need
`X-Bridge-Token`.

## Data Source

The bridge reads OAuth credentials in this order:

1. `CLAUDE_USAGE_ACCESS_TOKEN` or `ANTHROPIC_ACCESS_TOKEN`
2. macOS Keychain item `Claude Code-credentials`
3. `~/.claude/.credentials.json`

It calls Anthropic's OAuth usage endpoint with the `oauth-2025-04-20` beta
header. This endpoint is community-discovered rather than a public stability
contract, so the dashboard surfaces real errors instead of silently pretending
demo data is live.

## Transport Choices

- USB serial is the reliable path. Connect the Cardputer by USB, select the
  `/dev/tty.usbmodem...` port in the dashboard, then push live data.
- BLE is optional. The bridge runs BLE scanning in a worker process so a native
  noble/macOS crash cannot take down the dashboard or USB path.
- Wi-Fi credentials are no longer needed for the current firmware.

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
- USB data-seen state
- malformed JSON and bridge error messages
- stale data warning after no fresh push
- actual battery level as four blocks; one-block and empty battery are red
- dimmed backlight after inactivity and lower brightness on low battery

## Tests

```bash
cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/bridge
npm run verify

cd /Users/yuookie/Documents/dev/cardputer/claude-usage-monitor/firmware
pio run -e m5stack-cardputer
```

The bridge tests cover payload framing, usage normalization, status API, and
push behavior. The firmware build is the regression gate for the embedded side.

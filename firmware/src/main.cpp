/**
 * claude-usage-monitor - Cardputer ADV firmware
 * Data source: USB serial + BLE. The Mac bridge keeps all Claude credentials.
 */
#include <M5Cardputer.h>
#include <ArduinoJson.h>
#include "ui_usage.h"
#include "ble_usage.h"

static constexpr unsigned long STALE_AFTER_MS = 150000;
static constexpr unsigned long BATTERY_POLL_MS = 15000;
static constexpr unsigned long FOOTER_POLL_MS = 10000;
static constexpr uint8_t BRIGHT_NORMAL = 92;
static constexpr uint8_t BRIGHT_DIM = 36;
static constexpr uint8_t BRIGHT_LOW = 24;

static UsageData usage;
static UsageData prevUsage;
static UiState ui;
static UiState prevUi;

static bool haveData = false;
static String serialBuf = "";
static unsigned long lastDataAtMs = 0;
static unsigned long lastBatteryPollMs = 0;
static unsigned long lastFooterMs = 0;
static unsigned long lastActivityMs = 0;
static uint8_t currentBrightness = 255;

static bool usageChanged() {
  return usage.currentUsed != prevUsage.currentUsed
    || usage.currentRemaining != prevUsage.currentRemaining
    || usage.currentResetsIn != prevUsage.currentResetsIn
    || usage.weeklyUsed != prevUsage.weeklyUsed
    || usage.weeklyRemaining != prevUsage.weeklyRemaining
    || usage.weeklyResetsIn != prevUsage.weeklyResetsIn
    || usage.model != prevUsage.model
    || usage.status != prevUsage.status
    || usage.source != prevUsage.source
    || usage.error != prevUsage.error
    || usage.stale != prevUsage.stale
    || usage.isDemo != prevUsage.isDemo;
}

static bool uiChanged() {
  return ui.bleConnected != prevUi.bleConnected
    || ui.bleAdvertising != prevUi.bleAdvertising
    || ui.usbSeen != prevUi.usbSeen
    || ui.batteryPct != prevUi.batteryPct
    || ui.batteryCharging != prevUi.batteryCharging
    || ui.lastError != prevUi.lastError
    || ui.hint != prevUi.hint;
}

static void savePrev() {
  prevUsage = usage;
  prevUi = ui;
}

static String jsonString(JsonDocument& doc, const char* key, const char* fallback = "") {
  const char* value = doc[key] | fallback;
  return String(value);
}

static bool parseData(const String& line, const char* transport) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    ui.lastError = String("Bad ") + transport + " JSON";
    Serial.printf("[data] parse error from %s: %s\n", transport, err.c_str());
    return false;
  }

  usage.currentUsed = doc["cu"] | -1;
  usage.currentRemaining = doc["cr"] | -1;
  usage.currentResetsIn = jsonString(doc, "ri");
  usage.weeklyUsed = doc["wu"] | -1;
  usage.weeklyRemaining = doc["wr"] | -1;
  usage.weeklyResetsIn = jsonString(doc, "wi");
  usage.model = jsonString(doc, "m");
  usage.status = jsonString(doc, "s", "live");
  usage.source = jsonString(doc, "src");
  usage.error = jsonString(doc, "err");
  usage.ageSeconds = doc["age"] | -1;
  usage.stale = doc["stale"] | false;
  usage.isDemo = doc["d"] | false;

  const bool hasUsage = usage.currentUsed >= 0 || usage.weeklyUsed >= 0;
  if (!hasUsage && usage.error.length() > 0) {
    ui.lastError = usage.error;
    haveData = false;
  } else if (!hasUsage) {
    ui.lastError = "Payload missing usage";
    haveData = false;
    return false;
  } else {
    ui.lastError = "";
    haveData = true;
    lastDataAtMs = millis();
    ui.lastDataAt = millis();
  }

  if (String(transport) == "USB") ui.usbSeen = true;
  lastActivityMs = millis();
  Serial.printf("[data] %s current=%d weekly=%d status=%s\n",
    transport,
    usage.currentUsed,
    usage.weeklyUsed,
    usage.status.c_str()
  );
  return true;
}

static bool updateBatteryState(bool force = false) {
  const unsigned long now = millis();
  if (!force && now - lastBatteryPollMs < BATTERY_POLL_MS) return false;
  lastBatteryPollMs = now;

  int level = M5.Power.getBatteryLevel();
  if (level < 0 || level > 100) level = -1;
  const bool charging = ((int)M5.Power.isCharging()) == 1;

  const bool changed = level != ui.batteryPct || charging != ui.batteryCharging;
  ui.batteryPct = level;
  ui.batteryCharging = charging;
  return changed;
}

static bool updateTransportState() {
  const bool connected = bleUsageConnected();
  const bool advertising = bleUsageAdvertising();
  const bool changed = connected != ui.bleConnected || advertising != ui.bleAdvertising;
  ui.bleConnected = connected;
  ui.bleAdvertising = advertising;
  ui.hint = connected ? "Push live from Mac" : "Open Mac dashboard";
  return changed;
}

static bool updateStaleState() {
  if (!haveData) return false;
  const bool stale = millis() - lastDataAtMs > STALE_AFTER_MS;
  if (stale == usage.stale) return false;
  usage.stale = stale;
  return true;
}

static void applyBrightness() {
  const unsigned long now = millis();
  uint8_t target = BRIGHT_NORMAL;

  if (ui.batteryPct >= 0 && ui.batteryPct <= 25 && !ui.batteryCharging) {
    target = 64;
  }
  if (now - lastActivityMs > 120000) {
    target = BRIGHT_DIM;
  }
  if (ui.batteryPct >= 0 && ui.batteryPct <= 5 && !ui.batteryCharging) {
    target = BRIGHT_LOW;
  }

  if (target != currentBrightness) {
    currentBrightness = target;
    M5.Display.setBrightness(target);
  }
}

static void redrawFull() {
  if (haveData) drawUsageUI(usage, ui);
  else drawWaitingUI(ui);
  savePrev();
}

static void handleSerialByte(char c) {
  if (c == '\r') return;
  if (c == '\n') {
    if (serialBuf.length() > 0) {
      parseData(serialBuf, "USB");
      serialBuf = "";
    }
    return;
  }

  if (serialBuf.length() >= 768) {
    serialBuf = "";
    ui.lastError = "USB line too long";
    return;
  }
  serialBuf += c;
}

void setup() {
  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  cfg.fallback_board = m5::board_t::board_M5CardputerADV;
  cfg.internal_mic = false;
  cfg.internal_spk = false;
  cfg.led_brightness = 0;

  M5Cardputer.begin(cfg);
  M5Cardputer.Display.setRotation(1);
  M5.Display.setBrightness(BRIGHT_NORMAL);
  currentBrightness = BRIGHT_NORMAL;
  setCpuFrequencyMhz(80);

  bleUsageInit();
  updateBatteryState(true);
  updateTransportState();
  lastActivityMs = millis();

  redrawFull();
  Serial.println("[boot] claude-usage-monitor ready");
}

void loop() {
  M5Cardputer.update();
  bool needsFullRedraw = false;

  if (M5Cardputer.Keyboard.isChange()) {
    lastActivityMs = millis();
    currentBrightness = 255;
    applyBrightness();
  }

  while (Serial.available()) {
    handleSerialByte((char)Serial.read());
  }

  if (bleUsageAvailable()) {
    parseData(bleUsageRead(), "BLE");
  }

  if (bleUsageOverflowed()) {
    ui.lastError = "BLE line too long";
  }

  needsFullRedraw = updateTransportState()
    || updateBatteryState(false)
    || updateStaleState()
    || usageChanged()
    || uiChanged();

  if (needsFullRedraw) {
    redrawFull();
  } else if (millis() - lastFooterMs >= FOOTER_POLL_MS) {
    lastFooterMs = millis();
    drawUsageFooter(usage, ui, haveData);
  }

  applyBrightness();
  delay(haveData ? 80 : 120);
}

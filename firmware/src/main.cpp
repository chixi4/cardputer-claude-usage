/**
 * claude-usage-monitor - Cardputer ADV firmware
 * Data source: BLE. The Mac bridge keeps all Claude credentials.
 */
#include <M5Cardputer.h>
#include <ArduinoJson.h>
#include "ui_usage.h"
#include "ble_usage.h"

static constexpr unsigned long STALE_AFTER_MS = 150000;
static constexpr unsigned long BATTERY_POLL_MS = 15000;
static constexpr uint8_t BRIGHT_NORMAL = 92;
static constexpr uint8_t BRIGHT_DIM = 36;
static constexpr uint8_t BRIGHT_LOW = 24;

static UsageData usage;
static UsageData prevUsage;
static UiState ui;
static UiState prevUi;

static bool haveData = false;
static unsigned long lastDataAtMs = 0;
static unsigned long lastBatteryPollMs = 0;
static unsigned long lastActivityMs = 0;
static uint8_t currentBrightness = 255;
static uint32_t footerRng = 1;
static String footerWord = "Working...";
static unsigned long nextFooterWordAtMs = 0;
static bool footerSeeded = false;
static uint32_t appEventSeq = 0;
static unsigned long nextHeartbeatAtMs = 0;
static String serialCommandBuf = "";

static void appLog(const char* event, const String& detail = "") {
  Serial.printf("[app %lu +%lu] %s", ++appEventSeq, millis(), event);
  if (detail.length() > 0) Serial.printf(" %s", detail.c_str());
  Serial.println();
}

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

static uint32_t footerRand() {
  footerRng = 1664525UL * footerRng + 1013904223UL;
  return footerRng;
}

static String nextFooterWord() {
  return String(UI_VERBS[footerRand() % UI_VERB_COUNT]) + "...";
}

static unsigned long nextFooterDelay() {
  return 5000UL + (footerRand() % 10001UL);
}

static void resetFooterSequence(uint32_t seed) {
  footerRng = seed == 0 ? 1 : seed;
  footerWord = nextFooterWord();
  nextFooterWordAtMs = millis() + nextFooterDelay();
  footerSeeded = true;
}

static bool setFooter(const String& text, uint16_t color) {
  if (ui.footerText == text && ui.footerColor == color) return false;
  ui.footerText = text;
  ui.footerColor = color;
  return true;
}

static void clearUsageState(const String& hint = "Open web app") {
  usage = UsageData();
  haveData = false;
  ui.lastError = "";
  ui.hint = hint;
  ui.lastDataAt = 0;
  lastDataAtMs = 0;
  footerSeeded = false;
  lastActivityMs = millis();
}

static bool updateFooterState() {
  const unsigned long now = millis();

  if (ui.lastError.length() > 0) {
    return setFooter(ui.lastError, C_RED);
  }
  if (!haveData) {
    return setFooter(ui.hint, ui.bleConnected ? C_GREEN : C_ORANGE_TEXT);
  }
  if (usage.error.length() > 0) {
    return setFooter(usage.error, C_RED);
  }
  if (usage.stale) {
    return setFooter("Stale data", C_AMBER);
  }
  if (usage.isDemo) {
    return setFooter("Demo data", C_ORANGE_TEXT);
  }

  while (now >= nextFooterWordAtMs) {
    footerWord = nextFooterWord();
    nextFooterWordAtMs += nextFooterDelay();
  }
  return setFooter(footerWord, C_ORANGE_TEXT);
}

static bool parseData(const String& line, const char* transport) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    ui.lastError = String("Bad ") + transport + " JSON";
    Serial.printf("[data] parse error from %s: %s\n", transport, err.c_str());
    return false;
  }

  String command = jsonString(doc, "cmd");
  if (command == "wait" || command == "clear") {
    clearUsageState(jsonString(doc, "hint", "Open web app"));
    appLog("data-command", String("transport=") + transport + " cmd=" + command);
    return true;
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
  uint32_t footerSeed = doc["fs"] | 0;
  if (footerSeed == 0) footerSeed = (uint32_t)(doc["ts"] | 1);

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
    if (!footerSeeded) resetFooterSequence(footerSeed);
  }

  lastActivityMs = millis();
  appLog("data-frame", String("transport=") + transport
    + " current=" + String(usage.currentUsed)
    + " weekly=" + String(usage.weeklyUsed)
    + " status=" + usage.status);
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
  ui.hint = connected ? "Syncing soon" : "Open web app";
  if (changed) appLog("transport", bleUsageDebugStatus());
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
  if (!ui.batteryCharging && now - lastActivityMs > 120000) {
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
  updateFooterState();
  if (haveData) drawUsageUI(usage, ui);
  else drawWaitingUI(ui);
  savePrev();
}

static String statusLine() {
  return String("have_data=") + (haveData ? "1" : "0")
    + " stale=" + (usage.stale ? "1" : "0")
    + " current=" + String(usage.currentUsed)
    + " weekly=" + String(usage.weeklyUsed)
    + " battery=" + String(ui.batteryPct)
    + " charging=" + (ui.batteryCharging ? "1" : "0")
    + " " + bleUsageDebugStatus();
}

static void printHelp() {
  Serial.println("[cmd] help: status | ble-reset | reboot | clear | help");
}

static void handleSerialCommand(String command) {
  command.trim();
  command.toLowerCase();
  if (command.length() == 0) return;

  appLog("serial-command", command);
  if (command == "status") {
    Serial.printf("[status +%lu] %s\n", millis(), statusLine().c_str());
    return;
  }
  if (command == "ble-reset" || command == "blereset") {
    clearUsageState("BLE reset");
    bleUsageReset();
    updateTransportState();
    redrawFull();
    Serial.printf("[status +%lu] %s\n", millis(), statusLine().c_str());
    return;
  }
  if (command == "clear") {
    clearUsageState();
    redrawFull();
    Serial.printf("[status +%lu] %s\n", millis(), statusLine().c_str());
    return;
  }
  if (command == "reboot" || command == "restart") {
    Serial.println("[cmd] rebooting");
    Serial.flush();
    delay(80);
    ESP.restart();
    return;
  }
  printHelp();
}

static void pollSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      handleSerialCommand(serialCommandBuf);
      serialCommandBuf = "";
      continue;
    }
    if (serialCommandBuf.length() < 80) {
      serialCommandBuf += c;
    } else {
      serialCommandBuf = "";
      appLog("serial-overflow");
    }
  }
}

static void heartbeatIfDue() {
  const unsigned long now = millis();
  if (now < nextHeartbeatAtMs) return;
  nextHeartbeatAtMs = now + 10000UL;
  appLog("heartbeat", statusLine());
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
  updateFooterState();
  lastActivityMs = millis();

  redrawFull();
  appLog("boot", "claude-usage-monitor ready");
  printHelp();
}

void loop() {
  M5Cardputer.update();
  pollSerialCommands();
  bool needsFullRedraw = false;

  if (M5Cardputer.Keyboard.isChange()) {
    lastActivityMs = millis();
    applyBrightness();
  }

  if (bleUsageAvailable()) {
    parseData(bleUsageRead(), "BLE");
  }

  if (bleUsageOverflowed()) {
    ui.lastError = "BLE line too long";
  }

  const bool transportChanged = updateTransportState();
  const bool batteryChanged = updateBatteryState(false);
  const bool staleChanged = updateStaleState();
  const bool footerChanged = updateFooterState();

  if (batteryChanged) {
    appLog("battery", String("pct=") + String(ui.batteryPct)
      + " charging=" + (ui.batteryCharging ? "1" : "0"));
  }
  if (staleChanged) appLog("stale", usage.stale ? "1" : "0");

  needsFullRedraw = transportChanged
    || staleChanged
    || usageChanged()
    || uiChanged();

  if (needsFullRedraw) {
    redrawFull();
  } else {
    if (batteryChanged) drawBatteryOnly(ui);
    if (footerChanged) drawUsageFooter(usage, ui, haveData);
  }

  applyBrightness();
  heartbeatIfDue();
  const int loopDelayMs = ui.bleConnected ? 60 : (haveData ? 140 : 220);
  delay(loopDelayMs);
}

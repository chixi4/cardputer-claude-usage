// ui_usage.h - Cardputer 240x135 Claude usage UI.
#pragma once

#include <math.h>
#include <M5Cardputer.h>

struct UsageData {
  int currentUsed = -1;
  int currentRemaining = -1;
  String currentResetsIn;

  int weeklyUsed = -1;
  int weeklyRemaining = -1;
  String weeklyResetsIn;

  String model;
  String status = "waiting";
  String source;
  String error;
  int ageSeconds = -1;
  bool stale = false;
  bool isDemo = false;
};

struct UiState {
  bool bleConnected = false;
  bool bleAdvertising = false;
  int batteryPct = -1;
  bool batteryCharging = false;
  String lastError;
  String hint = "Open web app";
  unsigned long lastDataAt = 0;
  String footerText = "Open web app";
  uint16_t footerColor = 0;
};

static constexpr uint16_t C_BLACK       = 0x0000;
static constexpr uint16_t C_BG          = 0x1082; // #121212
static constexpr uint16_t C_TEXT        = 0xFFFF;
static constexpr uint16_t C_TEXT_DIM    = 0x9CD3; // #a0a0a0
static constexpr uint16_t C_CLAWD       = 0xFB46; // #ff6b35
static constexpr uint16_t C_ORANGE      = 0xFB46;
static constexpr uint16_t C_ORANGE_TEXT = 0xFC48; // #ff8c42
static constexpr uint16_t C_GREEN       = 0xAF76; // #a8e6cf
static constexpr uint16_t C_TRACK       = 0x39E7; // #3d3d3d
static constexpr uint16_t C_BADGE_BG    = 0x1AC3; // #1e5a1e  darker green
static constexpr uint16_t C_BADGE_TEXT  = 0xFFFF; // white
static constexpr uint16_t C_RED         = 0xFA69; // #ff4d4d
static constexpr uint16_t C_AMBER       = C_ORANGE_TEXT;
static constexpr uint16_t C_WHITE       = C_TEXT;
static constexpr uint16_t C_DIM         = C_TEXT_DIM;

static int clampPct(int v) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

static String pctText(int pct) {
  if (pct < 0) return "--%";
  return String(clampPct(pct)) + "%";
}

static void textTL(const String& s, int x, int y, int size, uint16_t fg, uint16_t bg = C_BG) {
  M5.Display.setTextDatum(TL_DATUM);
  M5.Display.setTextSize(size);
  M5.Display.setTextColor(fg, bg);
  M5.Display.drawString(s, x, y);
}

static void textMC(const String& s, int x, int y, int size, uint16_t fg, uint16_t bg = C_BG) {
  M5.Display.setTextDatum(MC_DATUM);
  M5.Display.setTextSize(size);
  M5.Display.setTextColor(fg, bg);
  M5.Display.drawString(s, x, y);
}

static void drawClawd(int x, int y, int scale) {
  static const char* rows[] = {
    "...XXXXXXXXXXXX...",
    "...XX.XXXXXX.XX...",
    ".XXXXXXXXXXXXXXXX.",
    "...XXXXXXXXXXXX...",
    "....X.X....X.X...."
  };

  const int cellW = scale;
  const int cellH = scale * 2;
  for (int row = 0; row < 5; row++) {
    for (int col = 0; rows[row][col] != '\0'; col++) {
      if (rows[row][col] == 'X') {
        M5.Display.fillRect(x + col * cellW, y + row * cellH, cellW, cellH, C_CLAWD);
      }
    }
  }
}

static int batteryBlocks(int pct) {
  if (pct < 0) return -1;
  if (pct <= 5) return 0;
  if (pct <= 25) return 1;
  if (pct <= 50) return 2;
  if (pct <= 75) return 3;
  return 4;
}

static void drawBattery(int x, int y, int pct, bool charging) {
  const int w = 18;
  const int h = 8;
  const int blocks = batteryBlocks(pct);
  const bool low = blocks >= 0 && blocks <= 1 && !charging;
  const uint16_t color = low ? C_RED : C_TEXT;
  const uint16_t emptyColor = low ? C_RED : C_TEXT_DIM;

  M5.Display.drawRect(x, y, w, h, color);
  M5.Display.fillRect(x + w, y + 2, 2, 4, color);

  if (blocks < 0) {
    for (int i = 0; i < 4; i++) {
      M5.Display.drawRect(x + 2 + i * 4, y + 2, 3, h - 4, C_TEXT_DIM);
    }
    return;
  }

  for (int i = 0; i < 4; i++) {
    const int bx = x + 2 + i * 4;
    if (i < blocks) {
      M5.Display.fillRect(bx, y + 2, 3, h - 4, color);
    } else if (low) {
      M5.Display.drawRect(bx, y + 2, 3, h - 4, emptyColor);
    }
  }

  if (charging) {
    M5.Display.drawLine(x + 8, y + 1, x + 5, y + 5, C_GREEN);
    M5.Display.drawLine(x + 8, y + 1, x + 11, y + 1, C_GREEN);
    M5.Display.drawLine(x + 11, y + 1, x + 8, y + 6, C_GREEN);
  }
}

static void drawClaudeSpark(int x, int y, uint16_t color = C_ORANGE_TEXT) {
  for (int i = 0; i < 8; i++) {
    float angle = (float)i * 0.78539816f;
    int x2 = x + (int)(cosf(angle) * 4.0f);
    int y2 = y + (int)(sinf(angle) * 4.0f);
    M5.Display.drawLine(x, y, x2, y2, color);
  }
  M5.Display.fillCircle(x, y, 1, color);
}

static void drawBadge(int x, int y, const String& label) {
  M5.Display.fillRoundRect(x, y, 46, 12, 4, C_BADGE_BG);
  int textX = x + 24;
  int textY = y + 6;
  if (label == "Weekly") textX -= 1;
  textMC(label, textX, textY, 1, C_BADGE_TEXT, C_BADGE_BG);
}

static void drawProgressBar(int x, int y, int w, int h, int pct, uint16_t fill) {
  pct = clampPct(pct);
  M5.Display.fillRoundRect(x, y, w, h, h / 2, C_TRACK);

  int fillW = (w * pct) / 100;
  if (fillW > 0) {
    M5.Display.fillRoundRect(x, y, fillW, h, h / 2, fill);
  }
}

static void drawUsageSection(
  int y,
  const String& label,
  int usedPct,
  const String& resetsIn,
  uint16_t fill
) {
  const int paddingX = 10;
  const int sectionW = 220;
  const int barY = y + 20;

  textTL(pctText(usedPct), paddingX, y, 2, C_TEXT, C_BG);
  drawBadge(184, y + 4, label);
  drawProgressBar(paddingX, barY, sectionW, 6, usedPct, fill);

  String reset = resetsIn.length() > 0 ? resetsIn : "--";
  textTL("Resets in " + reset, paddingX, barY + 8, 1, C_TEXT_DIM, C_BG);
}

static String clippedStatus(String status) {
  status.trim();
  if (status.length() == 0) status = "Waiting for data";
  if (status.length() > 25) status = status.substring(0, 24) + ".";
  return status;
}

static const char* const UI_VERBS[] = {
  "Accomplishing","Actioning","Actualizing","Baking","Brewing","Calculating",
  "Cerebrating","Churning","Clauding","Coalescing","Cogitating","Computing",
  "Conjuring","Considering","Cooking","Crafting","Creating","Crunching",
  "Deliberating","Determining","Divining","Doing","Effecting","Finagling",
  "Forging","Forming","Generating","Hatching","Herding","Honking","Hustling",
  "Ideating","Inferring","Manifesting","Marinating","Moseying","Mulling",
  "Mustering","Musing","Noodling","Percolating","Pondering","Processing",
  "Puttering","Reticulating","Ruminating","Schlepping","Shucking","Simmering",
  "Smooshing","Spinning","Stewing","Synthesizing","Thinking","Transmuting",
  "Vibing","Working","Beboppin","Befuddling","Bloviating","Boogieing",
  "Boondoggling","Booping","Canoodling","Caramelizing","Cascading","Catapulting",
  "Choreographing","Combobulating","Contemplating","Dilly-dallying","Discombobulating",
  "Doodling","Drizzling","Enchanting","Evaporating","Fermenting","Fiddle-faddling",
  "Flibbertigibbeting","Flummoxing","Frolicking","Gallivanting","Gitifying","Grooving",
  "Hullaballooing","Hyperspacing","Improvising","Jitterbugging","Julienning","Kneading",
  "Leavening","Lollygagging","Meandering","Moonwalking","Nebulizing","Osmosing",
  "Perambulating","Philosophising","Photosynthesizing","Pontificating","Prestidigitating",
  "Razzle-dazzling","Razzmatazzing","Recombobulating","Scampering","Skedaddling",
  "Sock-hopping","Spelunking","Tomfoolering","Topsy-turvying","Unfurling",
  "Whatchamacalliting","Wibbling","Zigzagging"
};
static const int UI_VERB_COUNT = sizeof(UI_VERBS) / sizeof(UI_VERBS[0]);

static void drawBottomStatus(const UsageData& usage, const UiState& ui, bool haveData) {
  String status = ui.footerText.length() > 0 ? ui.footerText : (haveData ? "Live data" : ui.hint);
  uint16_t color = ui.footerColor != 0 ? ui.footerColor : C_ORANGE_TEXT;

  status = clippedStatus(status);
  const int textW = status.length() * 6;
  const int startX = (240 - 8 - 4 - textW) / 2;
  drawClaudeSpark(startX + 4, 123, color);
  textTL(status, startX + 12, 120, 1, color, C_BG);
}

static void drawHeader(const UiState& ui) {
  drawClawd(8, 6, 2);
  textMC("Usage", 120, 13, 2, C_TEXT, C_BG);
  drawBattery(213, 8, ui.batteryPct, ui.batteryCharging);
}

void drawBatteryOnly(const UiState& ui) {
  M5.Display.startWrite();
  M5.Display.fillRect(211, 6, 25, 12, C_BG);
  drawBattery(213, 8, ui.batteryPct, ui.batteryCharging);
  M5.Display.endWrite();
}

void drawWaitingUI(const UiState& ui) {
  M5.Display.setRotation(1);
  M5.Display.startWrite();
  M5.Display.fillScreen(C_BG);
  drawHeader(ui);

  textMC("Ready to pair", 120, 42, 2, C_TEXT, C_BG);
  textMC(ui.bleConnected ? "BLE connected" : "BLE advertising", 120, 63, 1, ui.bleConnected ? C_GREEN : C_ORANGE_TEXT, C_BG);
  textMC("Open web app :8787", 120, 79, 1, C_TEXT_DIM, C_BG);
  textMC("Connect Bluetooth", 120, 95, 1, C_TEXT_DIM, C_BG);

  UsageData empty;
  drawBottomStatus(empty, ui, false);
  M5.Display.endWrite();
}

void drawUsageUI(const UsageData& usage, const UiState& ui) {
  M5.Display.setRotation(1);
  M5.Display.startWrite();
  M5.Display.fillScreen(C_BG);

  drawHeader(ui);
  drawUsageSection(32, "Current", usage.currentUsed, usage.currentResetsIn, C_ORANGE);
  drawUsageSection(76, "Weekly", usage.weeklyUsed, usage.weeklyResetsIn, C_GREEN);
  drawBottomStatus(usage, ui, true);

  M5.Display.endWrite();
}

void drawUsageFooter(const UsageData& usage, const UiState& ui, bool haveData) {
  M5.Display.startWrite();
  M5.Display.fillRect(0, 115, 240, 20, C_BG);
  drawBottomStatus(usage, ui, haveData);
  M5.Display.endWrite();
}

// ble_usage.h - BLE GATT server for receiving newline framed usage JSON.
#pragma once

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>
#include <BLEAdvertising.h>

#define BLE_SERVICE_UUID        "cafe1234-5678-1234-5678-123456789abc"
#define BLE_CHAR_UUID           "cafe5678-1234-5678-1234-56789abcdef0"
#define BLE_DEVICE_NAME         "Claude-Usage"

static bool bleDataReady = false;
static bool bleConnected = false;
static bool bleAdvertising = false;
static bool bleOverflow = false;
static bool bleAdvConfigured = false;
static String bleDataStr = "";
static String bleRxBuf = "";

static BLEServer* _bleServer = nullptr;
static BLEService* _bleService = nullptr;
static BLECharacteristic* _bleChar = nullptr;
static uint32_t bleEventSeq = 0;
static uint32_t bleFrameSeq = 0;
static uint32_t bleWriteChunks = 0;

static void bleLog(const char* event, const String& detail = "") {
  Serial.printf("[ble %lu +%lu] %s", ++bleEventSeq, millis(), event);
  if (detail.length() > 0) Serial.printf(" %s", detail.c_str());
  Serial.println();
}

static void bleStartAdvertising() {
  if (!_bleServer) return;
  BLEAdvertising* adv = _bleServer->getAdvertising();
  if (!bleAdvConfigured) {
    adv->addServiceUUID(BLE_SERVICE_UUID);
    adv->setScanResponse(true);
    adv->setMinInterval(0x60);
    adv->setMaxInterval(0x100);
    adv->setMinPreferred(0x06);
    adv->setMaxPreferred(0x12);
    bleAdvConfigured = true;
  }
  BLEDevice::startAdvertising();
  bleAdvertising = true;
  bleLog("advertising", String("name=") + BLE_DEVICE_NAME);
}

class BLEUsageServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer*) override {
    bleConnected = true;
    bleAdvertising = false;
    bleLog("connected");
  }

  void onDisconnect(BLEServer*) override {
    bleConnected = false;
    bleRxBuf = "";
    bleLog("disconnected");
    bleStartAdvertising();
  }
};

class BLEUsageCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pChar) override {
    std::string val = pChar->getValue();
    if (val.length() == 0) return;
    bleWriteChunks++;

    for (char c : val) {
      if (c == '\r') continue;
      if (c == '\n') {
        if (bleRxBuf.length() > 0) {
          bleDataStr = bleRxBuf;
          bleDataReady = true;
          bleLog("rx-frame", String("id=") + String(++bleFrameSeq)
            + " len=" + String(bleDataStr.length())
            + " chunks=" + String(bleWriteChunks));
          bleWriteChunks = 0;
          bleRxBuf = "";
        }
        continue;
      }

      if (bleRxBuf.length() >= 768) {
        bleOverflow = true;
        bleRxBuf = "";
        bleWriteChunks = 0;
        bleLog("rx-overflow");
        continue;
      }
      bleRxBuf += c;
    }
  }
};

void bleUsageInit() {
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setPower(ESP_PWR_LVL_N0);
  _bleServer = BLEDevice::createServer();
  _bleServer->setCallbacks(new BLEUsageServerCallbacks());
  _bleService = _bleServer->createService(BLE_SERVICE_UUID);
  _bleChar = _bleService->createCharacteristic(
    BLE_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  _bleChar->setCallbacks(new BLEUsageCallbacks());
  _bleService->start();
  bleStartAdvertising();

  bleLog("ready", "service=cafe1234 char=cafe5678");
}

void bleUsageReset() {
  bleLog("reset-restart", "reason=ble-stack-reinit-is-unsafe");
  Serial.flush();
  delay(80);
  ESP.restart();
}

String bleUsageDebugStatus() {
  return String("connected=") + (bleConnected ? "1" : "0")
    + " advertising=" + (bleAdvertising ? "1" : "0")
    + " data_ready=" + (bleDataReady ? "1" : "0")
    + " rx_len=" + String(bleRxBuf.length())
    + " frames=" + String(bleFrameSeq);
}

bool bleUsageAvailable() {
  return bleDataReady;
}

String bleUsageRead() {
  bleDataReady = false;
  return bleDataStr;
}

bool bleUsageConnected() {
  return bleConnected;
}

bool bleUsageAdvertising() {
  return bleAdvertising;
}

bool bleUsageOverflowed() {
  bool value = bleOverflow;
  bleOverflow = false;
  return value;
}

// GhostTape entropy source for ESP32 (Arduino core 3.x)
//
// Streams hardware random numbers over USB serial, one packet per price sub-step.
// Packet format (text, one per line, 115200 baud):
//   GT1,<seq>,<a_hex>,<b_hex>,<c_hex>
//     seq    : packet counter, starts at 0 on every boot
//     a, b   : two uint32 used by Box-Muller for one Gaussian price step
//     c      : one uint32 used for the regime roll at the end of each candle
// Status lines (not packets; parsers that only accept 5-field packets ignore them):
//   GT1,HELLO                                        once on boot
//   GT1,INFO,radio=on,ps=none,aps=<n>,up=<s>         radio verified (boot, then every 30 s)
//   GT1,ERR,radio_off,<reason>                       radio NOT verified: no packets are sent
//
// esp_random() is only TRUE random while the RF subsystem is on (Wi-Fi or BT enabled, and not
// asleep) or while bootloader_random_enable() is active; otherwise Espressif says to treat it as
// pseudo-random. We switch Wi-Fi on in STA mode (no network or password needed) and disable modem
// sleep so the radio's ADC keeps feeding noise. The firmware VERIFIES this before sending anything:
// it checks the driver mode and power-save setting and runs one Wi-Fi scan (a completed scan proves
// the radio is physically running). If verification fails it sends no packets at all, so the chart
// freezes instead of silently running on pseudo-random numbers (SPEC rule 5).
//
// Blue LED (GPIO 2 on most ESP32 DevKit boards): ON only while the radio is verified.
//
// CAPTURE_MODE = 1 turns the board into a raw entropy pump for statistical tests:
// it writes binary uint32s as fast as possible (pipe to a file, then run ent/dieharder).
// The same radio verification gates it; status is shown on the LED only (no text in the binary stream).

#include <WiFi.h>
#include <esp_wifi.h>

#define CAPTURE_MODE 0
static const uint32_t PACKET_MS = 160;          // 8 packets per candle -> about 1.3 s per candle
static const uint32_t RECHECK_MS = 30000;       // re-verify the radio this often while streaming
static const uint32_t RETRY_MS = 5000;          // when not verified, retry this often
static const int RADIO_LED = 2;                 // blue LED on most ESP32 DevKit boards

uint32_t seq = 0;
bool radioOk = false;
int lastAps = -1;
uint32_t lastCheckAt = 0;

// Cheap check: driver is in STA mode and power save is off. Does not interrupt the stream.
bool radioConfigured(const char** why) {
  wifi_mode_t mode;
  if (esp_wifi_get_mode(&mode) != ESP_OK) { *why = "driver_not_started"; return false; }
  if (mode != WIFI_MODE_STA && mode != WIFI_MODE_APSTA) { *why = "mode_not_sta"; return false; }
  wifi_ps_type_t ps;
  if (esp_wifi_get_ps(&ps) != ESP_OK || ps != WIFI_PS_NONE) { *why = "sleep_not_off"; return false; }
  return true;
}

// Full bring-up + proof: start the radio, disable sleep, run one blocking scan (~2-3 s).
bool bringUpRadio(const char** why) {
  if (!WiFi.mode(WIFI_STA)) { *why = "wifi_mode_failed"; return false; }
  if (!WiFi.setSleep(false)) { *why = "set_sleep_failed"; return false; }
  int n = WiFi.scanNetworks();                  // >= 0 networks = scan completed = radio is running
  WiFi.scanDelete();
  if (n < 0) { *why = "scan_failed"; return false; }
  lastAps = n;
  return radioConfigured(why);
}

void reportStatus(bool ok, const char* why) {
#if !CAPTURE_MODE
  if (ok) Serial.printf("GT1,INFO,radio=on,ps=none,aps=%d,up=%lu\n", lastAps, (unsigned long)(millis() / 1000));
  else    Serial.printf("GT1,ERR,radio_off,%s\n", why);
#endif
  digitalWrite(RADIO_LED, ok ? HIGH : LOW);
}

void setup() {
  pinMode(RADIO_LED, OUTPUT);
  digitalWrite(RADIO_LED, LOW);
  Serial.begin(CAPTURE_MODE ? 921600 : 115200);   // capture runs fast; live demo stays at 115200
  delay(300);
#if !CAPTURE_MODE
  Serial.println("GT1,HELLO");
#endif
  const char* why = "";
  radioOk = bringUpRadio(&why);
  reportStatus(radioOk, why);
  lastCheckAt = millis();
}

void loop() {
  uint32_t now = millis();
  if (!radioOk) {                                 // no verified radio -> no entropy leaves the chip
    if (now - lastCheckAt >= RETRY_MS) {
      const char* why = "";
      radioOk = bringUpRadio(&why);
      reportStatus(radioOk, why);
      lastCheckAt = millis();
    }
    delay(50);
    return;
  }
  if (now - lastCheckAt >= RECHECK_MS) {
    const char* why = "";
    radioOk = radioConfigured(&why);
    reportStatus(radioOk, why);
    lastCheckAt = now;
    if (!radioOk) return;
  }
#if CAPTURE_MODE
  uint32_t buf[64];
  for (int i = 0; i < 64; i++) buf[i] = esp_random();
  Serial.write((uint8_t*)buf, sizeof(buf));
#else
  uint32_t a = esp_random();
  uint32_t b = esp_random();
  uint32_t c = esp_random();
  Serial.printf("GT1,%lu,%08lx,%08lx,%08lx\n",
                (unsigned long)seq++, (unsigned long)a, (unsigned long)b, (unsigned long)c);
  delay(PACKET_MS);
#endif
}

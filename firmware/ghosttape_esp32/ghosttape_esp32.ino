// GhostTape entropy source for ESP32 (Arduino core 3.x)
//
// Streams hardware random numbers over USB serial, one packet per price sub-step.
// Packet format (text, one per line, 115200 baud):
//   GT1,<seq>,<a_hex>,<b_hex>,<c_hex>
//     seq    : packet counter, starts at 0 on every boot
//     a, b   : two uint32 used by Box-Muller for one Gaussian price step
//     c      : one uint32 used for the regime roll at the end of each candle
//
// esp_random() is only TRUE random while the RF subsystem is on (Wi-Fi or BT enabled)
// or while bootloader_random_enable() is active. We switch Wi-Fi on in STA mode
// (no network needed) and disable modem sleep so the radio's ADC keeps feeding noise.
//
// CAPTURE_MODE = 1 turns the board into a raw entropy pump for statistical tests:
// it writes binary uint32s as fast as possible (pipe to a file, then run ent/dieharder).

#include <WiFi.h>

#define CAPTURE_MODE 0
static const uint32_t PACKET_MS = 160;   // 8 packets per candle -> about 1.3 s per candle

uint32_t seq = 0;

void setup() {
  Serial.begin(CAPTURE_MODE ? 921600 : 115200);   // capture runs fast; live demo stays at 115200
  WiFi.mode(WIFI_STA);    // radio on: hardware entropy source active
  WiFi.setSleep(false);   // keep the RF front end awake
  delay(300);
#if !CAPTURE_MODE
  Serial.println("GT1,HELLO");
#endif
}

void loop() {
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

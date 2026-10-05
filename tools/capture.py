"""Capture raw ESP32 entropy for statistical testing.

Flash the firmware with CAPTURE_MODE=1 first (no file edit needed):
    arduino-cli compile --fqbn esp32:esp32:esp32 --build-property "compiler.cpp.extra_flags=-DCAPTURE_MODE=1" ...
Then:
    pip install pyserial
    python tools/capture.py COM5 data/esp32_radio_on.bin 10   # port, output file, megabytes (~2 min per 10 MB at 921600 baud)
Then test it:
    notebooks/randomness_proof.ipynb (numpy/scipy tests, runs locally or in Colab)
    ent data/esp32_radio_on.bin
    dieharder -a -g 201 -f data/esp32_radio_on.bin
    RNG_test stdin32 < data/esp32_radio_on.bin              # PractRand

How it stays clean:
- The port is opened with DTR and RTS both released, so opening it does NOT reset the board
  (on DevKit auto-reset circuits RTS drives EN). Whatever the board is doing, it keeps doing.
- The first second of data is thrown away. That drops anything stale in the USB bridge's buffer
  and any boot text (ROM boot messages are sent at 115200 baud and would show up as garbage here).
- The stream must start within 15 s (the radio bring-up scan takes ~3 s after a reset).
"""
import sys
import time
import serial

BAUD = 921600
DISCARD_SECONDS = 1.0
FIRST_DATA_TIMEOUT = 15.0

port, out_path, megabytes = sys.argv[1], sys.argv[2], float(sys.argv[3])
target = int(megabytes * 1024 * 1024)

ser = serial.Serial()
ser.port, ser.baudrate, ser.timeout = port, BAUD, 2
ser.dtr = False          # set before open(): no reset pulse when the port opens
ser.rts = False
ser.open()
try:
    ser.reset_input_buffer()
    # Wait for the stream to start.
    waited = time.monotonic()
    while not ser.in_waiting:
        if time.monotonic() - waited > FIRST_DATA_TIMEOUT:
            sys.exit("No data. Is the board flashed with CAPTURE_MODE=1 (radio verified = blue LED on) and the right port selected?")
        time.sleep(0.05)
    # Drop the first second of data (stale buffer / boot text).
    t0 = time.monotonic()
    dropped = 0
    while time.monotonic() - t0 < DISCARD_SECONDS:
        dropped += len(ser.read(ser.in_waiting or 1))
    print(f"Discarded {dropped} bytes from the first {DISCARD_SECONDS:.0f} s of the stream.")

    got = 0
    start = time.monotonic()
    with open(out_path, "wb") as out:
        while got < target:
            chunk = ser.read(min(65536, max(1, ser.in_waiting), target - got))
            if not chunk:
                sys.exit(f"\nStream stopped after {got} bytes (radio verification lost, or board unplugged?).")
            out.write(chunk)
            got += len(chunk)
            if got % (256 * 1024) < len(chunk) or got == target:
                rate = got / max(1e-9, time.monotonic() - start)
                print(f"\r{got / 1048576:.2f} / {megabytes} MB  ({rate / 1024:.1f} KB/s)", end="", flush=True)
    secs = time.monotonic() - start
    print(f"\nDone: {out_path}  {got} bytes in {secs:.1f} s ({got / secs / 1024:.1f} KB/s)")
finally:
    ser.close()

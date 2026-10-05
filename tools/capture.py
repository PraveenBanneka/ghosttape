"""Capture raw ESP32 entropy for statistical testing.

Flash the firmware with CAPTURE_MODE 1 first, then:
    pip install pyserial
    python tools/capture.py COM5 entropy.bin 10      # port, output file, megabytes (about 2-3 min per 10 MB at 921600 baud)
Then test it:
    ent entropy.bin
    dieharder -a -g 201 -f entropy.bin
    RNG_test stdin32 < entropy.bin                   # PractRand
"""
import sys
import serial

port, out_path, megabytes = sys.argv[1], sys.argv[2], float(sys.argv[3])
target = int(megabytes * 1024 * 1024)

with serial.Serial(port, 921600, timeout=2) as ser, open(out_path, "wb") as out:
    ser.reset_input_buffer()
    got = 0
    while got < target:
        chunk = ser.read(min(4096, target - got))
        if not chunk:
            sys.exit("No data. Is CAPTURE_MODE set to 1 and the right port selected?")
        out.write(chunk)
        got += len(chunk)
        print(f"\r{got / 1048576:.2f} / {megabytes} MB", end="")
print("\nDone:", out_path)

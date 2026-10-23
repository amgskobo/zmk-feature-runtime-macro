# Behavior queue pressure

Run `bash tests/queue-pressure/run.sh /absolute/resolved/west/workspace`.
The fixture uses the complete production macro player, actual ZMK behavior
queue, keymap/HID/event sources, Custom Settings, and real kernel delayed work.
Two queue entries deliberately force failure between a tap's press and release
and before an explicit modifier release. This is a controlled capacity, not a
production queue-size recommendation or a physical transport measurement.

One binary runs all three scenarios three times. The third deletes the backing
macro while admission is paused. A second playback must stay busy; the already
decoded actions still complete. Ordered key edges, zero remaining
HID keys/modifiers, and a 205 ms completion bound for these fixed inputs are
asserted. `RUNTIME_MACRO_PRESSURE_OUTPUT` selects a fresh evidence path.
The test does not establish USB/BLE delivery, production congestion latency,
general concurrent settings publication, or arbitrary behavior-owned resources.

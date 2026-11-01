# How to measure without fooling yourself

Most of "slow device" goes away when the measurement is done right. These are the traps that cost
time on the Redmi Pad SE.

## 1. An accumulated window since boot is useless

`dumpsys gfxinfo <pkg>` without `reset` mixes boot, automatic updates and real use. The 16.96%
janky-frame baseline was almost all boot storm.

`node tools/mode.js frames` resets the statistics, runs **the same 20 gestures every time** (12
horizontal swipes + 4 drawer open/close) and reads the result. Change the gesture and the number
changes — and the comparison dies.

```bash
node tools/mode.js frames                 # com.miui.home
node tools/mode.js frames --pkg com.x     # another app
```

## 2. CPU of one process, measured for real

A single `top` snapshot shows luck. What convinces is the change in CPU time over a fixed interval:

```bash
adb shell ps -o PID,TIME,NAME -p $(adb shell pidof com.example)   # note it
# wait 20 s
adb shell ps -o PID,TIME,NAME -p $(adb shell pidof com.example)   # note it again
```

A delta of ~23 s in 20 s of wall clock = **more than one core**. That is an accusation, not a
suspicion.

## 3. Before blaming the app, look at who wakes it

```bash
adb shell logcat -d | grep -E 'Start proc.*<pkg>'      # who asked for the process, and why
adb shell dumpsys jobscheduler | grep -c 'JOB #u0aNNN' # how many jobs; does it settle or grow?
adb shell dumpsys power | grep -A4 'Wake Locks: size'  # is anyone holding a LONG wake lock?
adb shell dumpsys backup | grep -E 'No backups running|Last backup pass'
```

A `force-stop` that "does not hold" is information: it means `system_server` is bringing the
process back for a job or service — the problem is not the process, it is the schedule.

## 4. App log, filtered by PID

```bash
adb shell logcat -d -t 2500 | grep ' <pid> ' | tail -40
```

In the Play Store case, that is what revealed the stuck install queue. Filtering by PID keeps you
from drowning in third-party logs.

## Writing the profile for a new device

1. **Measure first** (read-only):
   ```bash
   node tools/mode.js measure
   ```
2. **Resolve the identity of ambiguous packages.** A package name lies: `com.bsp.logmanager` is
   "Log generator", `com.xiaomi.ugd` is "GPU Driver Updater". Pull the APK and read the label:
   ```bash
   adb shell pm path com.example
   adb pull /system/priv-app/Example/Example.apk
   aapt2 dump badging Example.apk | head -2
   ```
3. **Decide the fate** (`fate`) per package:
   - `off` — vendor extra, promotion, telemetry. **Requires a short, checkable `why`.**
   - `keep` — leave alone (when in doubt, this is where you stay).
   - `never` — always refuse, even if another list says otherwise: screen, sound, installation,
     permissions, telephony, GMS.
   - `off_after_handover` — only once another home/screensaver exists (the TV case).
4. **Validate against the schema** before applying:
   ```bash
   python -c "import jsonschema, json; jsonschema.Draft202012Validator(json.load(open('schemas/profile.schema.json'))).validate(json.load(open('devices/brand/device.json'))); print('ok')"
   ```
5. **Dry plan**, review line by line, and only then `--yes`.

Rules that do not change:

- A package absent from the device does not go into the profile. Nothing by analogy with another
  brand.
- `never` is cheap; `off` is expensive. When in doubt, `never`.
- `tested` is the date of the test **on the device**, not the date the file was written.
- A `why` you cannot defend in one sentence is a package that comes back.

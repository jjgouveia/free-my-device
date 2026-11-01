# free-my-device

A PC-side bench (adb, no root) to find out **why** an Android device feels heavy — TV, tablet or
phone —, apply a measured fix and revert everything with one command.

It is not a debloat list copied from the internet. It is a loop: **measure → plan → apply → verify →
revert**. Each device's profile is data (JSON), not code, and only what is written there is touched.

The profile contract (`spec 1`) is the same for every device: `stock_home`, `stock_dream`,
`input_service` and `quirks` are TV fields and stay optional elsewhere. That is why the same schema
accepts a tablet without a single change. Today the only measured profile here is the Redmi Pad SE.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (standard library only, no `npm install`)
- `adb` (platform-tools). The script looks in PATH and in the usual SDKs; `ADB=/path/to/adb`
  always wins
- Reach the device: USB on a phone/tablet (debugging on, key authorized) or `adb connect` on a TV
  with network debugging
- No root. Nothing is installed on the device.

```bash
adb devices        # must list the device as "device"
```

## Step by step

### 1. Measure (read-only)

```bash
node tools/mode.js measure
```

Writes `out/measure/<device>-<date>.json` with props, display, storage, package list and memory.
That file holds the serial number and your app list: `out/` is git-ignored on purpose.

### 2. Pick the profile

`devices/<brand>/<device>.json`. The Redmi Pad SE one already exists. For another device, see
[docs/03-method.md](docs/03-method.md) — the rule is not to invent: a package without a verifiable
`why` does not go into `off`.

### 3. See the plan (read-only)

```bash
node tools/mode.js plan devices/xiaomi/redmi-pad-se.json
```

Shows what would leave, what would come back, what is already off and what the profile asks for but
the tool refuses. Nothing changes.

### 4. Apply

```bash
node tools/mode.js apply devices/xiaomi/redmi-pad-se.json --yes
```

Without `--yes` it prints the plan and exits. With `--yes`, it removes the packages from user 0 and
writes the **ledger** (on the device and in `out/ledger/`), which is what revert reads.

### 5. Measure the after

```bash
node tools/mode.js frames
```

Resets `gfxinfo`, runs the same 20 gestures every time and reads the result. Comparing the window
accumulated since boot is worthless: it mixes boot, Play Store and real use.

### 6. Revert

```bash
node tools/mode.js revert
```

Turns back on only what **this tool** removed. An app you uninstalled yourself does not come back.

## Result on the Redmi Pad SE

Android 15 / HyperOS `OS2.0.209.0.VMUMIXM`, 8 GB, `xun`. Details in
[docs/01-diagnosis-redmi-pad-se.md](docs/01-diagnosis-redmi-pad-se.md).

| | before | after |
|---|---|---|
| installed packages | 444 | 426 |
| janky frames (20 gestures) | 5/600 (0.83%) | 5/622 (0.80%) |
| p90 / p99 | 10 / 19 ms | 7 / 15 ms |
| load average | 4.56 / 4.50 / 6.10 | 2.64 / 2.87 / 4.36 |
| `com.android.vending:background` | 26 min of CPU in 22 min uptime | 72 s in 30 min |

The lesson that justifies the method: the launcher was not the culprit. A stuck update queue in the
Play Store burned more than a core since boot. Debloating without measuring would have "fixed" the
wrong symptom.

## What it does not do

- It does not install anything on the device and does not need root.
- It does not touch a package outside the profile.
- It does not turn off what is in `ALWAYS_KEEP` (screen, settings, installer, permissions, keyboard,
  telephony, GMS), even if the profile asks.
- It does not turn a slow device into a fast one: it removes weight and proves what changed.
- **On a TV, only the package half.** `off_after_handover` shows up in the plan as "waiting for a
  home of its own" and is not executed: switching home, screensaver and input is the job of an app
  running on the device, not of this bench. The profile and the ledger are ready; the hand on
  `TvInputManager` is not.
- It still does not talk to the device without a PC. The on-device layer (Shizuku) is decided, not
  implemented.

## Layout

```
devices/<brand>/<device>.json      measured profile (spec 1), one file per device
schemas/profile.schema.json        contract the profile must satisfy
tools/mode.js                      measure | plan | apply | revert | frames
docs/                              diagnosis, capability matrix, method
out/                               local measurements and ledger (git ignores it)
```

## Why revert is trustworthy

The device's real state decides, not the command's output. There are two ledgers because there are
two mechanisms:

| key | what it means | revert uses |
|---|---|---|
| `fmd_disabled` | package turned off with `pm disable-user` | `pm enable` |
| `fmd_removed` | package removed from user 0 with `pm uninstall -k --user 0` | `pm install-existing` |

The second one exists because HyperOS 15 refuses `disable-user` on a system package
(`SecurityException: Cannot disable system packages`). The profile does not know that: `fate` says
*what* leaves, the tool picks *how*. See [docs/02-capability-matrix.md](docs/02-capability-matrix.md).

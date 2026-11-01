# What was heavy on the Redmi Pad SE

Device: Redmi Pad SE (`23073RPBFL`), `ro.product.device` = `xun`, Android 15 (SDK 35),
HyperOS `OS2.0.209.0.VMUMIXM`, 8 GB of RAM, 1200×1920 @ 280 dpi. Measured on 2026-11-01, over USB,
no root.

The owner described the device as "very heavy". The measurement partly disagreed:

| suspicion | measured reality |
|---|---|
| low memory | 7,691 MB of RAM (8 GB variant), 4.2 GB available |
| storage full | 223 GB on `/data`, 160 GB free |
| heavy launcher | 16.96% janky frames — a **consequence**, not the cause |
| old/limited device | Snapdragon 680, 8 cores, `cached_apps_freezer=disabled` |

The bottleneck was in the background. Three findings, by impact.

## 1. Play Store stuck in an update queue (the culprit)

`com.android.vending:background` burned **26 minutes of CPU in 22 minutes of uptime** — more than a
whole core, continuously, since boot. Two "LONG" `PARTIAL_WAKE_LOCK`s held by
`PhoneskyJobServiceBackground` kept the device from sleeping. A `SessionManager` thread took 68% of
the process. Load average 6.39 on an 8-core device.

The cause, in the Finsky log:

```
IQ: Requesting install request=... reason=auto_update, account_name=[hash],
    constraints=((REQ_CHARGING, ..., AUTHENTICATION_REQUIRED),)
IU: Account  from AppState for update of com.google.android.apps.docs.editors.docs no longer exists.
IV2: installer unavailable to accept com.exemplo.jogo ... status code 1136
IQ: 13 scheduled install statuses found to proceed.
```

There were ~13 automatic updates tied to a **Google account that no longer exists on the device**.
Authentication never succeeds, the installer never accepts, and the Play Store repeats the cycle
every few milliseconds — holding a wake lock and rescheduling jobs (IDs 10550 → 10640 → ...).

`force-stop` does not help: `system_server` brings the job back within seconds
(`Start proc ... for service {PhoneskyJobServiceMain} caller=android`). What fixed it was throwing
the queue away, with the owner's consent:

```bash
adb shell pm clear com.android.vending
```

| | before | after |
|---|---|---|
| CPU of `:background` | 23 s of CPU in 20 s (~115% of a core) | 1 s in 120 s (~0.8%) |
| "LONG" wake locks from vending | 2 | 0 |
| registered jobs | 16 | 11 |
| queue errors (`IQ`/`IV2`) | continuous | 1 in 120 s |

Expected side effect: the Play Store asks for the account again, and the first sync is heavy
(~30% of a core for a few minutes) before it settles.

## 2. First backup and Google Photos (false alarm)

Right after boot, a `*backup*` "LONG" `PARTIAL_WAKE_LOCK` appeared, 7 minutes old, together with a
Google Photos job started in the same window. It was the **first backup pass**, not a loop:

```
Backup Manager is enabled / setup complete / not pending init
No backups running
Last backup pass started: 0
next scheduled: +11 h
```

It finished on its own. Nothing to do — and it is the proof that a "LONG" wake lock alone is not a
diagnosis: you need the context of who asked for it and whether it is still running.

## 3. The launcher was never the problem

Baseline accumulated since boot: 1,604 frames, 272 janky (16.96%), p99 of 600 ms. After stopping
the Play Store, with a clean window and fixed gestures (`node tools/mode.js frames`):

| | before debloat | after debloat |
|---|---|---|
| janky frames | 5 of 600 (0.83%) | 5 of 622 (0.80%) |
| p50 / p90 | 6 / 10 ms | 6 / 7 ms |
| p95 / p99 | 12 / 19 ms | 9 / 15 ms |
| missed vsync | 0 | 0 |
| load average | 4.56 / 4.50 / 6.10 | 2.64 / 2.87 / 4.36 |

In other words: with the Play Store stopped, the launcher was already at 60 fps. The 17-package
debloat improved memory and background work, not frames. Anyone promising "debloating makes the
home screen smooth" would be selling the wrong cause.

## What was applied

17 packages removed from user 0 (see `devices/xiaomi/redmi-pad-se.json`, all with a `why`):

```
com.miui.msa.global                       com.miui.qr
com.miui.analytics                        com.bsp.logmanager
com.miui.misightservice                   com.longcheertel.AutoTest
com.miui.bugreport                        com.longcheertel.cit
com.mi.globalbrowser                      com.miui.vsimcore
com.miui.videoplayer                      com.miui.fm
com.miui.player                           com.miui.fmservice
com.xiaomi.discover                       com.microsoftsdk.crossdeviceservicebroker
com.miui.thirdappassistant
```

Verification: 444 → 426 installed packages, none of the 17 in `pm list packages`, `plan`
idempotent (17 "already off", 0 to do), no `FATAL EXCEPTION` and no `ANR`, home/Settings/Play
Store alive.

Revert: `node tools/mode.js revert`.

## Loose ends (measured, not solved)

- `ueventd` with 2min07s of CPU and a 13% spike. Odd for a device-node daemon; not investigated.
- 4 Google accounts on the device. The Play Store keeps update state per account — an amplifier
  for any background work. The owner's call, not the tool's.
- `cached_apps_freezer=disabled` on `xun`. Turning it on may help devices with little RAM; this
  one has 8 GB.

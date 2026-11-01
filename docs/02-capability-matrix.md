# Capability matrix: what you can do without root

The answer changes with the device and the ROM layer. Below is what was **measured on the Redmi
Pad SE** (`xun`, Android 15, HyperOS `OS2.0.209.0.VMUMIXM`), not inferred from documentation.
"Without root" = the `shell` user over ADB. On another device the "works?" column may change — on
an Android 11 TV, for instance, `pm disable-user` works; it is the first thing to test, on a single
guinea pig, before applying any list.

| Capability | How | Works? | Note |
|---|---|---|---|
| Turn off a system package | `pm disable-user --user 0` | ❌ on HyperOS | `SecurityException: Cannot disable system packages` (`PackageManagerServiceImpl.shouldRestrictEnabledSettingsChange`). Worked on Android 11 |
| Remove a system package from the user | `pm uninstall -k --user 0` | ✅ | the system APK stays in `/system`; it disappears from the installed apps list |
| Undo the one above | `pm install-existing --user 0` | ✅ | round trip tested; it is what `revert` uses |
| Read the real state | `pm list packages` / `-d` | ⚠️ | uninstalled for the user **disappears** from `pm list packages`; `-d` only shows `disable-user`. That is why the ledger exists |
| Animation scales | `settings put global *_animation_scale` | ✅ | 0.5/0.5/0.5 applied and checked with `settings get` |
| Read jobs and wake locks | `dumpsys jobscheduler`, `dumpsys power` | ✅ | read-only — and where background consumption is found |
| Wireless ADB on `127.0.0.1:5555` | — | ❌ | Android 11+ uses a random port plus TLS pairing; a tool that assumes 5555 does not work on a phone/tablet |
| On-device privilege layer | Shizuku | ⏳ | decided, not implemented. It runs as `shell`, so it **inherits exactly the permissions in this table** — it does not bypass a ROM block |
| Freeze apps in the background | `cached_apps_freezer` | ⏳ | `disabled` on `xun`; not turned on |

## Test whether your device blocks `disable-user`

One reversible guinea pig, before any batch:

```bash
adb shell pm disable-user --user 0 com.miui.msa.global   # if you get SecurityException, the path is the one below
adb shell pm uninstall -k --user 0 com.miui.msa.global
adb shell pm install-existing --user 0 com.miui.msa.global
```

If `disable-user` passes, the ledger uses `fmd_disabled` and revert runs `pm enable`. If it fails,
`mode.js` falls back on its own to `uninstall` and records it in `fmd_removed`.

## What this changes in the design

- **The profile does not name a mechanism.** `fate: "off"` says *what* leaves. *How* it leaves is
  the tool's call, and the tool records which way it removed it — otherwise revert tries to turn it
  back on the wrong way.
- **Two lists, one truth.** The local ledger and the device's `settings global` keep the same set;
  if the PC changes, the device still knows what was done to it.
- **Shizuku does not add power.** The gain is not depending on a PC, not bypassing a block.
  Promising more than that would be a lie.

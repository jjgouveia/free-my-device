#!/usr/bin/env node
// PC-side bench for an Android device (TV, tablet, phone): measure, plan, apply and revert,
// talking to the device through the computer's adb.
//
//   node tools/mode.js measure [--serial S] [--out F]
//   node tools/mode.js plan    <profile.json> [--serial S]
//   node tools/mode.js apply   <profile.json> [--serial S] [--yes]
//   node tools/mode.js revert  [--serial S]
//   node tools/mode.js frames  [--pkg com.miui.home] [--serial S]
//
// Rules (not negotiable):
//  - only touches a package named in the profile;
//  - never turns off ALWAYS_KEEP;
//  - restores only what WE removed (local ledger + the device's global settings);
//  - confirms by the device's real state, never by the command's output;
//  - `apply` without --yes prints the plan and exits without touching anything.
//
// The "how" (disable-user or uninstall-for-user) is the tool's call, not the profile's: HyperOS
// refuses disable-user on a system package, and the path left is `pm uninstall -k --user 0`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const here = __dirname;
const outDir = path.resolve(here, '..', 'out');
const ADB = process.env.ADB || findAdb();
const LEDGER = 'fmd_disabled';
// Mirror of what left through `pm uninstall -k --user 0` (the other path, when disable-user is blocked).
const LEDGER_REMOVED = 'fmd_removed';

/** adb from PATH, or from the usual SDKs. `ADB=/path/to/adb` always wins. */
function findAdb() {
  const home = os.homedir();
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
    '/usr/lib/android-sdk/platform-tools/adb',
    '/usr/local/bin/adb',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return 'adb';
}

// Without them the device does not boot back on its own, or loses what makes it a device: screen,
// settings, installer, permissions, keyboard, telephony, Google services. Refused even if the
// profile asks to turn them off (each device profile refines that with `never`).
const ALWAYS_KEEP = new Set([
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.shell',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.android.phone',
  'com.android.providers.settings',
  'com.android.providers.media',
  'com.android.providers.contacts',
  'com.android.keychain',
  'com.android.certinstaller',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.google.android.inputmethod.latin',
  'com.miui.securitycenter',
  'com.lbe.security.miui',
]);

// --- arguments --------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--serial') opts.serial = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--yes') opts.yes = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--pkg') opts.pkg = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

// --- adb --------------------------------------------------------------------

function adb(args, serial, quiet) {
  const full = serial ? ['-s', serial].concat(args) : args;
  try {
    return execFileSync(ADB, full, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim().split(/\r?\n/)[0];
    throw new Error('adb ' + args.join(' ') + ': ' + (msg || 'failed'));
  }
}

function shell(cmd, serial, quiet) {
  return adb(['shell', cmd], serial, quiet);
}

/** One device: use it. Several: ask for --serial. None: explain what to do. */
function pickSerial(opts) {
  if (opts.serial) return opts.serial;
  const out = adb(['devices']);
  const lines = out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
  const ready = lines.filter((l) => /\sdevice$/.test(l)).map((l) => l.split(/\s+/)[0]);
  if (ready.length === 1) return ready[0];
  if (ready.length === 0) {
    const offline = lines.filter((l) => /\s(unauthorized|offline)$/.test(l));
    throw new Error(
      offline.length
        ? 'the device is listed but did not authorize this PC (' + offline.join(', ') + '): accept "Allow USB debugging" on screen'
        : 'no device on adb: enable USB debugging and plug the cable'
    );
  }
  throw new Error('more than one device (' + ready.join(', ') + '): use --serial');
}

function parsePackages(output) {
  const set = new Set();
  for (const line of output.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('package:')) set.add(t.slice('package:'.length).trim());
  }
  return set;
}

// --- measure ----------------------------------------------------------------

const PROPS = [
  'ro.product.brand',
  'ro.product.model',
  'ro.product.device',
  'ro.build.fingerprint',
  'ro.build.version.sdk',
  'ro.build.version.release',
  'ro.build.version.incremental',
  'ro.miui.ui.version.name',
  'ro.mi.os.version.name',
  'ro.mi.os.version.incremental',
  'ro.config.low_ram',
  'ro.sf.lcd_density',
];

// All read-only. Nothing here changes the device.
const MEASURE = [
  ['wm size', 'wm size'],
  ['wm density', 'wm density'],
  ['meminfo', 'cat /proc/meminfo'],
  ['meminfoSummary', 'dumpsys meminfo | head -n 24', true],
  ['storage', 'df -h /data'],
  ['packages', 'pm list packages'],
  ['packagesDisabled', 'pm list packages -d'],
  ['packagesSystem', 'pm list packages -s'],
  ['packagesUser', 'pm list packages -3'],
  ['homeRole', 'cmd role get-role-holders android.app.role.HOME'],
  ['homeResolve', 'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME'],
  ['screensaver', 'settings get secure screensaver_components'],
  ['animWindow', 'settings get global window_animation_scale'],
  ['animTransition', 'settings get global transition_animation_scale'],
  ['animDuration', 'settings get global animator_duration_scale'],
  ['freezer', 'settings get global cached_apps_freezer'],
  ['user', 'am get-current-user'],
];

function measure(opts) {
  const serial = pickSerial(opts);
  const commands = {};
  for (const [name, cmd, quiet] of MEASURE) commands[name] = shell(cmd, serial, quiet);
  const props = {};
  const dump = shell('getprop', serial);
  for (const line of dump.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
    if (m && PROPS.includes(m[1])) props[m[1]] = m[2];
  }

  const all = parsePackages(commands.packages);
  const disabled = parsePackages(commands.packagesDisabled);
  const system = parsePackages(commands.packagesSystem);

  const data = {
    spec: 1,
    kind: 'measure',
    at: new Date().toISOString(),
    serial,
    props,
    display: {
      size: commands['wm size'].trim(),
      density: commands['wm density'].trim(),
    },
    packages: {
      installed: all.size,
      disabled: [...disabled].sort(),
      system: system.size,
    },
    commands,
  };

  const file = opts.out
    ? path.resolve(opts.out)
    : path.join(outDir, 'measure', (props['ro.product.device'] || serial) + '-' + data.at.slice(0, 10) + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

  const mem = (commands.meminfo.match(/MemTotal:\s+(\d+)\s+kB/) || [, '?'])[1];
  const free = (commands.meminfo.match(/MemAvailable:\s+(\d+)\s+kB/) || [, '?'])[1];
  const mb = (kb) => (kb === '?' ? '?' : Math.round(Number(kb) / 1024) + ' MB');

  console.log('model    : ' + (props['ro.product.brand'] || '?') + ' ' + (props['ro.product.model'] || '?'));
  console.log('device   : ' + (props['ro.product.device'] || '?') + '   android ' + (props['ro.build.version.release'] || '?') + ' (sdk ' + (props['ro.build.version.sdk'] || '?') + ')');
  const firmware = [props['ro.mi.os.version.name'], props['ro.mi.os.version.incremental'] || props['ro.miui.ui.version.name']].filter(Boolean).join(' ');
  if (firmware) console.log('firmware : ' + firmware);
  console.log('display  : ' + commands['wm size'].trim().replace(/\r?\n/g, ' ') + '   ' + commands['wm density'].trim());
  console.log('memory   : ' + mb(mem) + ' total, ' + mb(free) + ' available');
  console.log('storage  : ' + commands.storage.split(/\r?\n/).filter(Boolean).slice(-1)[0].trim());
  console.log('packages : ' + all.size + ' (' + system.size + ' system), ' + disabled.size + ' disabled');
  console.log('home     : ' + (commands.homeRole.trim() || commands.homeResolve.trim()).replace(/\r?\n/g, ' '));
  console.log('animation: ' + [commands.animWindow, commands.animTransition, commands.animDuration].map((s) => s.trim()).join(' / '));
  console.log('evidence : ' + file);
}

// --- profile -----------------------------------------------------------------

function loadProfile(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (p.kind !== 'profile' || p.spec !== 1) throw new Error('not a spec 1 profile: ' + file);
  const fate = new Map();
  const why = new Map();
  for (const entry of p.packages) {
    fate.set(entry.pkg, entry.fate);
    if (entry.why) why.set(entry.pkg, entry.why);
  }
  return { raw: p, fate, why };
}

/** Exact fingerprint, else device name compared case-insensitively. */
function matches(p, props) {
  if (p.fingerprint && p.fingerprint === props['ro.build.fingerprint']) return true;
  return !!p.device && p.device.toLowerCase() === (props['ro.product.device'] || '').toLowerCase();
}

function profileProps(serial) {
  const props = {};
  const dump = shell('getprop', serial);
  for (const line of dump.split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
    if (m && PROPS.includes(m[1])) props[m[1]] = m[2];
  }
  return props;
}

// --- plan --------------------------------------------------------------------

function buildPlan(profileFile, serial) {
  const p = loadProfile(profileFile);
  const props = profileProps(serial);
  const installed = parsePackages(shell('pm list packages', serial));
  const disabled = parsePackages(shell('pm list packages -d', serial));
  const ledger = readLedger(serial);

  const plan = {
    matched: matches(p.raw, props),
    toDisable: [], toEnable: [], toRestore: [], already: [], blocked: [], handover: [], absent: [], unknown: [], oursBack: [],
  };

  for (const [pkg, fate] of p.fate) {
    if (!installed.has(pkg)) {
      // Without this, a package we removed ourselves shows up as "absent" on the next plan.
      if (ledger.has(pkg) && fate === 'off') plan.already.push(pkg);
      else plan.absent.push(pkg);
      continue;
    }
    if (fate === 'off') {
      if (disabled.has(pkg)) plan.already.push(pkg);
      else if (ALWAYS_KEEP.has(pkg)) plan.blocked.push(pkg);
      else plan.toDisable.push(pkg);
    } else if (fate === 'off_after_handover') {
      plan.handover.push(pkg);
    } else if (fate !== 'keep' && fate !== 'never') {
      plan.unknown.push(pkg);
    }
  }

  // Turn back on only what is ours, and only if the profile no longer asks to turn it off.
  for (const [pkg, how] of ledger) {
    if (!installed.has(pkg)) {
      if (p.fate.get(pkg) === 'off') continue;
      plan.toRestore.push(pkg);
      continue;
    }
    if (!disabled.has(pkg)) continue;
    if (p.fate.get(pkg) === 'off') continue;
    if (ALWAYS_KEEP.has(pkg)) continue;
    plan.toEnable.push(pkg);
    plan.oursBack.push(pkg);
  }
  return { plan, profile: p };
}

function renderPlan({ plan, profile }) {
  const why = (pkg) => (profile.why.get(pkg) ? '  ' + profile.why.get(pkg) : '');
  console.log('profile  : ' + profile.raw.id + (plan.matched ? '' : '  ** NOT the device this profile was measured on **'));
  console.log('remove (' + plan.toDisable.length + '):');
  if (!plan.toDisable.length) console.log('  nothing');
  for (const pkg of plan.toDisable) console.log('  - ' + pkg + why(pkg));
  console.log('restore (' + plan.toEnable.length + '):');
  if (!plan.toEnable.length) console.log('  nothing');
  for (const pkg of plan.toEnable) console.log('  + ' + pkg);
  if (plan.toRestore.length) {
    console.log('reinstall (' + plan.toRestore.length + '):');
    for (const pkg of plan.toRestore) console.log('  + ' + pkg);
  }
  console.log('already off (' + plan.already.length + ')');
  console.log('blocked (' + plan.blocked.length + ')' + (plan.blocked.length ? ': ' + plan.blocked.join(', ') : ''));
  console.log('waiting for a home of its own (' + plan.handover.length + ')' + (plan.handover.length ? ': ' + plan.handover.join(', ') : ''));
  console.log('absent on this device (' + plan.absent.length + ')' + (plan.absent.length <= 10 && plan.absent.length ? ': ' + plan.absent.join(', ') : ''));
  if (plan.unknown.length) console.log('unknown fate (' + plan.unknown.length + '): ' + plan.unknown.join(', '));
}

// --- ledger -----------------------------------------------------------------

function ledgerFile(serial) {
  return path.join(outDir, 'ledger', serial.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
}

function readLedger(serial) {
  const map = new Map();
  try {
    const local = JSON.parse(fs.readFileSync(ledgerFile(serial), 'utf8'));
    for (const pkg of local.disabled || []) map.set(pkg, 'disable');
    for (const pkg of local.removed || []) map.set(pkg, 'uninstall');
  } catch (e) { /* no file: the device's copy wins */ }
  const csv = (key) => {
    const out = shell('settings get global ' + key, serial).trim();
    if (out && out !== 'null') for (const pkg of out.split(',')) if (pkg.trim()) map.set(pkg.trim(), key === LEDGER ? 'disable' : 'uninstall');
  };
  csv(LEDGER);
  csv(LEDGER_REMOVED);
  return map;
}

function writeLedger(serial, map) {
  const file = ledgerFile(serial);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const disabled = [...map].filter(([, how]) => how === 'disable').map(([pkg]) => pkg);
  const removed = [...map].filter(([, how]) => how === 'uninstall').map(([pkg]) => pkg);
  fs.writeFileSync(file, JSON.stringify({ active: map.size > 0, at: new Date().toISOString(), disabled, removed }, null, 2) + '\n');
  const put = (key, list) => {
    if (list.length === 0) shell('settings delete global ' + key, serial);
    else shell('settings put global ' + key + ' ' + list.join(','), serial);
  };
  put(LEDGER, disabled);
  put(LEDGER_REMOVED, removed);
}

function tryShell(cmd, serial) {
  try { return { ok: true, out: shell(cmd, serial).trim() }; }
  catch (e) { return { ok: false, out: String(e.message || e) }; }
}

/**
 * Not every Android accepts `pm disable-user` on a system package: HyperOS 15 answers
 * "Cannot disable system packages" (PackageManagerServiceImpl.shouldRestrictEnabledSettingsChange).
 * In that case the path is uninstalling for user 0, which `install-existing` undoes.
 * The mechanism comes back with it, because revert needs to know which way to turn it on.
 */
function removePkg(serial, pkg) {
  const first = tryShell('pm disable-user --user 0 ' + pkg, serial);
  if (first.ok) return { how: 'disable', out: first.out || 'ok' };
  if (!/Cannot disable system packages|SecurityException/i.test(first.out)) return { how: null, out: first.out };
  const fallback = tryShell('pm uninstall -k --user 0 ' + pkg, serial);
  if (fallback.ok && /^Success/i.test(fallback.out)) return { how: 'uninstall', out: 'removed from user 0' };
  return { how: null, out: fallback.out };
}

function restorePkg(serial, pkg, how) {
  if (how === 'uninstall') return tryShell('pm install-existing --user 0 ' + pkg, serial).out;
  const out = tryShell('pm enable ' + pkg, serial);
  if (out.ok) return out.out;
  return tryShell('pm install-existing --user 0 ' + pkg, serial).out;
}

// --- apply / revert ---------------------------------------------------------

function apply(profileFile, opts) {
  const serial = pickSerial(opts);
  const built = buildPlan(profileFile, serial);
  renderPlan(built);

  if (!built.plan.matched && !opts.force) {
    console.error('\nrefused: this is not the device this profile was measured on. Nothing changed. (--force overrides)');
    process.exit(3);
  }
  if (built.plan.toDisable.length + built.plan.toEnable.length === 0) {
    console.log('\nnothing to do.');
    return;
  }
  if (!opts.yes) {
    console.log('\nplan only. Run again with --yes to apply. Nothing changed.');
    return;
  }

  for (const pkg of built.plan.toDisable) {
    const r = removePkg(serial, pkg);
    console.log('- ' + pkg + ': ' + r.out.replace(/\s+/g, ' ').slice(0, 120));
  }
  for (const pkg of built.plan.toEnable) {
    const out = restorePkg(serial, pkg, 'disable').replace(/\s+/g, ' ');
    console.log('+ ' + pkg + ': ' + (out || 'ok'));
  }
  for (const pkg of built.plan.toRestore) {
    const out = shell('pm install-existing --user 0 ' + pkg, serial).trim().replace(/\s+/g, ' ');
    console.log('+ ' + pkg + ': ' + (out || 'ok'));
  }

  // Confirm by real state: only what the device says is off goes into the ledger.
  const disabled = parsePackages(shell('pm list packages -d', serial));
  const installed = parsePackages(shell('pm list packages', serial));
  const ledger = readLedger(serial);
  for (const pkg of built.plan.toDisable) {
    if (disabled.has(pkg)) ledger.set(pkg, 'disable');
    else if (!installed.has(pkg)) ledger.set(pkg, 'uninstall');
    else ledger.delete(pkg);
  }
  for (const pkg of built.plan.toEnable) if (!disabled.has(pkg)) ledger.delete(pkg);
  for (const pkg of built.plan.toRestore) if (installed.has(pkg)) ledger.delete(pkg);
  writeLedger(serial, ledger);
  console.log('\nledger: ' + ledger.size + ' package(s) removed by us on this device.');
}

function revert(opts) {
  const serial = pickSerial(opts);
  const ledger = readLedger(serial);
  if (!ledger.size) {
    console.log('empty ledger: nothing was turned off by us on this device.');
    return;
  }
  for (const [pkg, how] of ledger) {
    const out = restorePkg(serial, pkg, how).trim().replace(/\s+/g, ' ');
    console.log('+ ' + pkg + ': ' + (out || 'ok'));
  }
  const now = parsePackages(shell('pm list packages -d', serial));
  const installed = parsePackages(shell('pm list packages', serial));
  const kept = new Map();
  for (const [pkg, how] of ledger) {
    if (how === 'uninstall' ? !installed.has(pkg) : now.has(pkg)) kept.set(pkg, how);
  }
  writeLedger(serial, kept);
  console.log(kept.size ? '\nstill off: ' + [...kept.keys()].join(', ') : '\neverything back to the previous state.');
}

// --- launcher frames ---------------------------------------------------------

/** Synchronous pause: the script is a sequence of gestures, no parallelism needed. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Resets gfxinfo, runs the same 20 gestures every time and reads the result. Without a fixed
 * gesture the before/after comparison means nothing: a boot window and a scroll are not comparable.
 */
function frames(opts) {
  const serial = pickSerial(opts);
  const pkg = opts.pkg || 'com.miui.home';

  shell('dumpsys gfxinfo ' + pkg + ' reset', serial);
  const swipe = (a, b) => {
    shell('input swipe ' + a + ' ' + b + ' 250', serial);
    sleepMs(900);
  };
  for (let i = 0; i < 6; i++) swipe('1000 1100', '200 1100');
  for (let i = 0; i < 6; i++) swipe('200 1100', '1000 1100');
  for (let i = 0; i < 4; i++) {
    shell('input swipe 600 1700 600 1000 300', serial);
    sleepMs(900);
    shell('input swipe 600 1000 600 1700 300', serial);
    sleepMs(900);
  }
  shell('input keyevent KEYCODE_HOME', serial);
  sleepMs(2000);

  const out = shell('dumpsys gfxinfo ' + pkg, serial);
  const field = (name) => {
    const m = out.match(new RegExp(name + ':\\s*(.+)'));
    return m ? m[1].trim() : '?';
  };
  console.log('package  : ' + pkg);
  console.log('frames   : ' + field('Total frames rendered'));
  console.log('janky    : ' + field('Janky frames') + '   (legacy: ' + field('Janky frames \\(legacy\\)') + ')');
  console.log('p50/p90  : ' + field('50th percentile') + ' / ' + field('90th percentile'));
  console.log('p95/p99  : ' + field('95th percentile') + ' / ' + field('99th percentile'));
  console.log('vsync    : ' + field('Number Missed Vsync') + ' missed, ' + field('Number Slow UI thread') + ' slow UI thread');
}

// --- entry point -------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd, file] = opts._;
  if (!cmd) {
    console.error('usage: node tools/mode.js measure|plan|apply|revert|frames [profile.json] [--serial S] [--yes] [--pkg PKG]');
    process.exit(2);
  }
  if (cmd === 'measure') return measure(opts);
  if (cmd === 'revert') return revert(opts);
  if (cmd === 'frames') return frames(opts);
  if (cmd !== 'plan' && cmd !== 'apply') {
    console.error('unknown command: ' + cmd);
    process.exit(2);
  }
  if (!file) {
    console.error('missing profile: node tools/mode.js ' + cmd + ' <profile.json>');
    process.exit(2);
  }
  if (cmd === 'apply') return apply(file, opts);
  renderPlan(buildPlan(file, pickSerial(opts)));
}

try {
  main();
} catch (e) {
  console.error('error: ' + e.message);
  if (process.env.FMD_DEBUG) console.error(e.stack);
  process.exit(1);
}

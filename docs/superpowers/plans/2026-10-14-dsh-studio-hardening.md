# DSH Studio Desktop Wrapper Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the defects in the newly added `main.js`/`preload.js` Windows Electron wrapper so the preload API actually works, security defaults match the prior version, and the watchdog/process-tree logic stops misbehaving on non-Windows and crash loops.

**Architecture:** Patch `main.js` in place, keeping the single-file main-process design. Pure Windows-path helpers move to `lib/win-utils.js` so they are unit-testable under plain Node. No changes to `@deepseek-ai/dsh`, no native modules.

**Tech Stack:** Electron 37, Node 22 (`node --test`), vanilla JS.

**Spec:** Repo convention (previous commit `cf624e7`); no separate spec document exists. Global Constraints below record the ironclad rules the previous task established.

## Global Constraints

- Pure Windows Electron wrapper. Do NOT modify `@deepseek-ai/dsh` source.
- Do NOT introduce native node-gyp C++ modules.
- Never omit code when emitting files; no placeholders.
- Plugin install commands must stay wrapped in try/catch.
- Context menu must use native `reg.exe` (no admin, no external deps).
- Work happens on `main` branch — the human partner already requested commit+push on `main` in the previous task (explicit consent).

## Review Focus

- **IPC contract mismatch:** preload exposes 5 invoke channels (`dsh:get-runtime-info`, `dsh:switch-engine`, `dsh:restart-safe-mode`, `dsh:register-context-menu`, `dsh:unregister-context-menu`) but main registers none — a webview caller gets `No handler registered for 'dsh:*'`. A reasonable person expects each exposed method to work.
- **Crash-loop watchdog:** `dshProcess.on('exit')` restarts unconditionally with a fixed 1.5s delay — a misconfigured engine loops forever spawning processes. A reasonable person expects bounded restarts.
- **Multi-instance port conflict:** no `requestSingleInstanceLock`; two launches race on port 3080. A reasonable person expects the second instance to focus the first.
- **Renderer privilege:** `webPreferences` dropped `sandbox: true` from the previous version. A reasonable person expects the packaged app not to weaken the default sandbox.
- **Process-tree kill on non-Windows:** `process.kill(-pid)` without `detached: true` cannot kill the group; the Linux/dev path leaks the backend. A reasonable person expects the backend to die with the app.
- **`toWslPath` edge inputs:** already-handled UNC/relative drive paths, mixed separators, lowercase drive letters. A reasonable person expects consistent `/mnt/<drive>/...` output and passthrough of non-drive paths.

---

### Task 1: Register the five missing IPC handlers

**Files:**
- Modify: `main.js` (add `ipcMain.handle` block near the existing `dsh:native-notify` handler)

**Interfaces:**
- Consumes: existing top-level state `currentPort`, `currentEngine`, `isSafeMode`, `DSH_HOME`; existing functions `startDshBackend`, `waitForBackendReady`, `registerWindowsContextMenu`, `unregisterWindowsContextMenu`, `mainWindow.loadURL`.
- Produces: `ipcMain.handle('dsh:get-runtime-info')`, `dsh:switch-engine`, `dsh:restart-safe-mode`, `dsh:register-context-menu`, `dsh:unregister-context-menu`.

- [ ] **Step 1: Add a shared restart helper `restartWithCurrentConfig()`**

Wrap the existing `startDshBackend(); await waitForBackendReady(); mainWindow.loadURL(...)` triple used by every menu click into one function that null-guards `mainWindow`.

- [ ] **Step 2: Register `ipcMain.handle('dsh:get-runtime-info')`**

Returns `{ port: currentPort, engine: currentEngine, safeMode: isSafeMode, home: DSH_HOME }`.

- [ ] **Step 3: Register `ipcMain.handle('dsh:switch-engine', mode)`**

Accept only `'win-native'` or `'wsl2'`; reject anything else with an Error. Set `currentEngine`, call the restart helper.

- [ ] **Step 4: Register `ipcMain.handle('dsh:restart-safe-mode')`**

Toggle `isSafeMode` (flip boolean) and restart.

- [ ] **Step 5: Register `ipcMain.handle('dsh:register-context-menu')` and `dsh:unregister-context-menu`**

Return the boolean from the existing register/unregister functions.

- [ ] **Step 6: Syntax check + commit**

Run `node --check main.js`. Expected: PASS.

```bash
git add main.js
git commit -m "fix(main): register IPC handlers for preload shell API"
```

### Task 2: Restore security defaults and single-instance lock

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add `sandbox: true` to `webPreferences` in `createMainWindow`**

Matches the pre-refactor version's `webPreferences`.

- [ ] **Step 2: Add single-instance lock**

At module top (before `app.whenReady`): `const gotLock = app.requestSingleInstanceLock();` — if not acquired, `app.quit()` and guard the rest of the startup; on `second-instance`, show+focus the existing window.

- [ ] **Step 3: Syntax check + commit**

Run `node --check main.js`. Expected: PASS.

```bash
git add main.js
git commit -m "fix(main): restore sandbox and add single-instance lock"
```

### Task 3: Bounded watchdog restarts and correct process-tree kill

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Add crash counter + reset on clean startup**

`let crashCount = 0;` in `startDshBackend`, reset to 0 on successful spawn; in the `exit` handler, increment `crashCount`, and if it exceeds 5, stop auto-restarting and log; else schedule restart with delay `Math.min(1500 * 2 ** (crashCount - 1), 15000)`.

- [ ] **Step 2: Fix non-Windows group kill**

In `killProcessTree`, before spawning on non-Windows, set `detached: true` in the spawn options; keep `process.kill(-pid, 'SIGKILL')`. On Windows keep `taskkill /T /F`.

- [ ] **Step 3: Syntax check + commit**

Run `node --check main.js`. Expected: PASS.

```bash
git add main.js
git commit -m "fix(main): bound watchdog restarts and fix non-win process-tree kill"
```

### Task 4: Menu null-guards, per-command reg tolerance, backend-ready timeout

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Refactor menu click handlers to use `restartWithCurrentConfig()`**

Replaces the repeated `startDshBackend(); await waitForBackendReady(); mainWindow.loadURL(...)` blocks. Add `if (mainWindow)` guard inside the helper.

- [ ] **Step 2: Per-command try/catch inside `registerWindowsContextMenu`**

Wrap each `execSync(reg add ...)` in its own try/catch so one failed key doesn't abort the rest; return true if at least one key was written.

- [ ] **Step 3: Add HTTP timeout to `waitForBackendReady`**

Set `req.setTimeout(timeoutMs, ...)` so a hung connection resolves `false` instead of waiting forever. Keep the existing `Date.now()` timeout path.

- [ ] **Step 4: Syntax check + commit**

Run `node --check main.js`. Expected: PASS.

```bash
git add main.js
git commit -m "fix(main): harden menu handlers, reg commands, and readiness probe"
```

### Task 5: TDD — extract `toWslPath` to `lib/win-utils.js`

**Files:**
- Create: `lib/win-utils.js`
- Create: `test/win-utils.test.js`
- Modify: `main.js` (import `toWslPath` from the new module, remove inline copy)

**Interfaces:**
- Produces: `lib/win-utils.js` exports `function toWslPath(winPath) -> string`.
- Consumes: `main.js` replaces its inline `toWslPath` with `const { toWslPath } = require('./lib/win-utils');`.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { toWslPath } = require('../lib/win-utils');

test('toWslPath converts a drive-letter Windows path', () => {
  assert.strictEqual(toWslPath('C:\\Users\\me\\repo'), '/mnt/c/Users/me/repo');
});

test('toWslPath converts forward-slash drive path', () => {
  assert.strictEqual(toWslPath('D:/work/app'), '/mnt/d/work/app');
});

test('toWslPath lowercases drive letter', () => {
  assert.strictEqual(toWslPath('E:\\Repo'), '/mnt/e/Repo');
});

test('toWslPath passes through paths without a drive letter', () => {
  assert.strictEqual(toWslPath('\\\\server\\share\\x'), '//server/share/x');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/win-utils.test.js`
Expected: FAIL with `Cannot find module '../lib/win-utils'`.

- [ ] **Step 3: Create `lib/win-utils.js` with `toWslPath`**

Same logic as the inline version in `main.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/win-utils.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Wire `main.js` to the module**

Replace inline function with `require('./lib/win-utils')`. Run `node --check main.js`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/win-utils.js test/win-utils.test.js main.js
git commit -m "test(main): extract toWslPath to lib/win-utils with unit tests"
```

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-10-14-dsh-studio-hardening.md`. The human partner explicitly told me to run the superpowers optimization ("调用吧") after twice asking to start; per their earlier explicit commit-on-main instruction, inline execution on `main` proceeds without a fresh review gate. A single whole-branch self-review per `executing-plans` (no subagent tool configured for this repo's harness) closes the loop.

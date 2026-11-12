const { app, BrowserWindow, ipcMain, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const PRIORITIES = ['low', 'high', 'extreme'];
const XP_REWARD = { low: 10, high: 25, extreme: 50 };
const COMBO_WINDOW_MS = 90 * 1000;
const TICK_INTERVAL_MS = 30 * 1000;

let win = null;
let state = null;
const liveNotifications = new Set(); // keep references so they aren't garbage-collected

// ---------------------------------------------------------------- storage --

const dataFile = () => path.join(app.getPath('userData'), 'tasks.json');

function freshStats() {
  return {
    xp: 0,                     // lifetime XP; level is derived from it
    streak: 0,
    bestStreak: 0,
    lastCompletionDate: null,  // local YYYY-MM-DD of the last finished task
    streakLost: null,          // length of a streak that just ended, until the UI has shown it
    combo: { count: 0, lastAt: null },
    totalCompleted: 0,
    history: {},               // 'YYYY-MM-DD' -> { count, xp }
  };
}

function freshState() {
  return { version: 2, tasks: [], stats: freshStats() };
}

// Accepts stats from any earlier version of the file and fills in what's missing.
function normalizeStats(raw, tasks) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const stats = freshStats();

  stats.xp = num(src.xp);
  stats.streak = num(src.streak);
  stats.bestStreak = Math.max(num(src.bestStreak), stats.streak);
  stats.lastCompletionDate = src.lastCompletionDate ?? src.lastCompletedDay ?? null;
  stats.streakLost = num(src.streakLost) || null;
  stats.combo = { count: num(src.combo?.count), lastAt: num(src.combo?.lastAt) || null };

  const done = tasks.filter((t) => t.done);
  if (src.history && typeof src.history === 'object') {
    stats.history = src.history;
  } else {
    // First run on an older file: rebuild the daily history from finished tasks.
    for (const task of done) {
      if (!task.completedAt) continue;
      const key = dayKey(new Date(task.completedAt));
      const day = (stats.history[key] ||= { count: 0, xp: 0 });
      day.count += 1;
      day.xp += task.xpAwarded ?? XP_REWARD[task.priority] ?? 0;
    }
  }
  stats.totalCompleted = Number.isFinite(src.totalCompleted) ? src.totalCompleted : done.length;
  return stats;
}

function loadState() {
  const file = dataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    return { version: 2, tasks, stats: normalizeStats(parsed.stats, tasks) };
  } catch (err) {
    // Missing file is a normal first run. Anything else means the file is
    // unreadable, so set it aside rather than overwrite it.
    if (err.code !== 'ENOENT') {
      try {
        fs.renameSync(file, file.replace(/\.json$/, `.corrupt-${Date.now()}.json`));
      } catch {}
    }
    return freshState();
  }
}

function saveState() {
  const file = dataFile();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file); // atomic swap so a crash never leaves half a file
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', state);
}

// ------------------------------------------------------------------ stats --

function dayKey(date = new Date()) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function yesterdayKey() {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return dayKey(y);
}

// A streak survives until the end of the day after the last completion. Once a
// full day has been missed it drops to 0 and the lost length is kept for the UI.
function reconcileStreak() {
  const stats = state.stats;
  if (stats.streak <= 0) return false;
  const last = stats.lastCompletionDate;
  if (last === dayKey() || last === yesterdayKey()) return false;
  stats.streakLost = stats.streak;
  stats.streak = 0;
  return true;
}

// Applies every reward rule for one finished task.
function awardCompletion(task) {
  const now = Date.now();
  const stats = state.stats;
  reconcileStreak();

  // Combo: each finish within 90s of the previous one adds 1 to the multiplier.
  const chained = stats.combo.lastAt && now - stats.combo.lastAt <= COMBO_WINDOW_MS;
  const combo = chained ? stats.combo.count + 1 : 1;
  stats.combo = { count: combo, lastAt: now };

  // XP: base by priority, half if late, times the combo.
  const late = typeof task.due === 'number' && now > task.due;
  const base = XP_REWARD[task.priority] ?? XP_REWARD.low;
  const earned = Math.round(base * (late ? 0.5 : 1) * combo);

  task.done = true;
  task.completedAt = now;
  task.late = late;
  task.combo = combo;
  task.xpAwarded = earned;

  stats.xp += earned;
  stats.totalCompleted += 1;

  const today = dayKey();
  const day = (stats.history[today] ||= { count: 0, xp: 0 });
  day.count += 1;
  day.xp += earned;

  // Streak: +1 for the first finish of a new day, or back to 1 after a miss.
  if (stats.lastCompletionDate !== today) {
    stats.streak = stats.lastCompletionDate === yesterdayKey() ? stats.streak + 1 : 1;
    stats.lastCompletionDate = today;
  }
  stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
}

// -------------------------------------------------------------------- ipc --

ipcMain.handle('state:get', () => state);

ipcMain.handle('task:add', (_event, input) => {
  const title = typeof input?.title === 'string' ? input.title.trim().slice(0, 200) : '';
  if (!title) throw new Error('Task title is required');

  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'low';
  const due = Number.isFinite(input.due) ? input.due : null;

  state.tasks.push({
    id: randomUUID(),
    title,
    priority,
    due,
    reminder: Boolean(input.reminder) && due !== null,
    reminderFired: false,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
  });
  saveState();
  return state;
});

ipcMain.handle('task:complete', (_event, id) => {
  const task = state.tasks.find((t) => t.id === id);
  if (task && !task.done) {
    awardCompletion(task);
    saveState();
  }
  return state;
});

// The renderer calls this once it has shown the STREAK LOST banner.
ipcMain.handle('streak:ack', () => {
  if (state.stats.streakLost !== null) {
    state.stats.streakLost = null;
    saveState();
  }
  return state;
});

ipcMain.handle('task:delete', (_event, id) => {
  const before = state.tasks.length;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  if (state.tasks.length !== before) saveState();
  return state;
});

// -------------------------------------------------------------- reminders --

function notify(task) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: 'PELLET — TASK DUE',
    body: task.title,
  });
  liveNotifications.add(n);
  n.on('click', focusWindow);
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

function checkReminders() {
  const now = Date.now();
  const due = state.tasks.filter(
    (t) => t.reminder && !t.reminderFired && !t.done && typeof t.due === 'number' && t.due <= now
  );
  if (!due.length) return;

  // Flag first, then fire: a reminder is never shown twice, even after a restart.
  for (const task of due) task.reminderFired = true;
  saveState();
  for (const task of due) notify(task);
  pushState();
}

// ----------------------------------------------------------------- window --

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    title: 'PELLET',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0B0B0D',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The app is a single local page; nothing should ever navigate away from it.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.on('closed', () => {
    win = null;
  });
}

function focusWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openCreateModal() {
  if (!win) {
    createWindow();
    win.webContents.once('did-finish-load', () => win?.webContents.send('ui:open-create'));
    return;
  }
  focusWindow();
  win.webContents.send('ui:open-create');
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Task', accelerator: 'CmdOrCtrl+N', click: openCreateModal },
          { type: 'separator' },
          { role: isMac ? 'close' : 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );
}

// -------------------------------------------------------------- lifecycle --

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);

  app.whenReady().then(() => {
    state = loadState();
    if (reconcileStreak()) saveState();
    buildMenu();
    createWindow();

    checkReminders();
    setInterval(() => {
      checkReminders();
      if (reconcileStreak()) {
        saveState();
        pushState();
      }
    }, TICK_INTERVAL_MS);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // On macOS the app stays alive with no window, so reminders keep firing.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

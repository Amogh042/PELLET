const { app, BrowserWindow, ipcMain, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const PRIORITIES = ['low', 'high', 'extreme'];
const XP_REWARD = { low: 10, high: 25, extreme: 50 };
const REMINDER_INTERVAL_MS = 30 * 1000;

let win = null;
let state = null;
const liveNotifications = new Set(); // keep references so they aren't garbage-collected

// ---------------------------------------------------------------- storage --

const dataFile = () => path.join(app.getPath('userData'), 'tasks.json');

function freshState() {
  return {
    version: 1,
    tasks: [],
    stats: { xp: 0, streak: 0, lastCompletedDay: null },
  };
}

function loadState() {
  const file = dataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = freshState();
    return {
      version: 1,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      stats: { ...base.stats, ...(parsed.stats || {}) },
    };
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

function bumpStreak() {
  const today = dayKey();
  const stats = state.stats;
  if (stats.lastCompletedDay === today) return;

  const y = new Date();
  y.setDate(y.getDate() - 1);
  stats.streak = stats.lastCompletedDay === dayKey(y) ? stats.streak + 1 : 1;
  stats.lastCompletedDay = today;
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
    task.done = true;
    task.completedAt = Date.now();
    state.stats.xp += XP_REWARD[task.priority] ?? XP_REWARD.low;
    bumpStreak();
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
    buildMenu();
    createWindow();

    checkReminders();
    setInterval(checkReminders, REMINDER_INTERVAL_MS);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // On macOS the app stays alive with no window, so reminders keep firing.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

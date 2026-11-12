(() => {
  'use strict';

  const api = window.pellet;

  const XP_PER_LEVEL = 100;
  const XP_PELLETS = 20;
  const SPLASH_PELLETS = 12;
  const SPLASH_MS = 1500;
  const PRIORITY_RANK = { extreme: 3, high: 2, low: 1 };
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const EMPTY_COPY = {
    all: ['ALL CLEAR', 'Nothing queued. Press CMD+N to add a task.'],
    today: ['NOTHING TODAY', 'No tasks are due today.'],
    overdue: ['NO OVERDUE', 'Nothing has slipped past its due date.'],
    done: ['NO CLEARS YET', 'Completed tasks land here.'],
  };

  // 8x10 pixel flame. O = orange, Y = amber core.
  const FLAME = [
    '....O...',
    '...OO...',
    '...OOO..',
    '.O.OOO..',
    '.OOOOOO.',
    'OOOYYOOO',
    'OOYYYYOO',
    'OOYYYYOO',
    '.OYYYYO.',
    '..OOOO..',
  ];

  const $ = (selector) => document.querySelector(selector);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const dom = {
    app: $('#app'),
    splash: $('#splash'),
    splashTrack: $('#splashTrack'),
    levelBadge: $('#levelBadge'),
    levelNum: $('#levelNum'),
    xpText: $('#xpText'),
    xpBar: $('#xpBar'),
    flame: $('#flame'),
    streakNum: $('#streakNum'),
    filters: $('#filters'),
    createBtn: $('#createBtn'),
    taskList: $('#taskList'),
    empty: $('#empty'),
    emptyTitle: $('#emptyTitle'),
    emptyText: $('#emptyText'),
    modal: $('#modal'),
    form: $('#taskForm'),
    modalClose: $('#modalClose'),
    fTitle: $('#fTitle'),
    prioGroup: $('#prioGroup'),
    fDue: $('#fDue'),
    fReminder: $('#fReminder'),
    reminderRow: $('#reminderRow'),
    reminderText: $('#reminderText'),
  };

  let state = { tasks: [], stats: { xp: 0, streak: 0, lastCompletedDay: null } };
  let filter = 'all';
  let selectedPriority = 'low';
  let justAddedId = null;
  let shownPellets = null; // null until the first paint, so nothing pops on load
  let submitting = false;
  const leaving = new Set(); // task ids whose cards are mid-animation

  // ------------------------------------------------------------- helpers --

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function dayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function isToday(ts) {
    return ts != null && dayKey(new Date(ts)) === dayKey(new Date());
  }

  function isOverdue(task) {
    return !task.done && task.due != null && task.due < Date.now();
  }

  function shortDate(ts, withTime) {
    const d = new Date(ts);
    let out = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    if (d.getFullYear() !== new Date().getFullYear()) out += ` ${d.getFullYear()}`;
    if (withTime) out += ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return out;
  }

  function dueChip(task) {
    if (task.due == null) return null;
    const d = new Date(task.due);
    if (isOverdue(task)) return el('span', 'chip chip--overdue', 'OVERDUE');
    if (isToday(task.due)) {
      return el('span', 'chip chip--today', `TODAY ${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
    }
    return el('span', 'chip chip--due', shortDate(task.due, true));
  }

  const levelOf = (xp) => Math.floor(xp / XP_PER_LEVEL) + 1;

  // -------------------------------------------------------------- queries --

  function sortActive(tasks) {
    return tasks.sort((a, b) => {
      const dueA = a.due ?? Infinity;
      const dueB = b.due ?? Infinity;
      if (dueA !== dueB) return dueA - dueB;
      const rank = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (rank !== 0) return rank;
      return b.createdAt - a.createdAt;
    });
  }

  function tasksFor(name) {
    const active = state.tasks.filter((t) => !t.done);
    switch (name) {
      case 'today':
        return sortActive(active.filter((t) => isToday(t.due)));
      case 'overdue':
        return sortActive(active.filter(isOverdue));
      case 'done':
        return state.tasks
          .filter((t) => t.done)
          .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
      default:
        return sortActive(active);
    }
  }

  // --------------------------------------------------------------- render --

  function buildCard(task) {
    const card = el('li', 'task');
    card.dataset.id = task.id;
    if (task.done) card.classList.add('is-done');
    if (task.id === justAddedId) card.classList.add('is-new');

    const check = el('button', 'check');
    check.type = 'button';
    check.setAttribute('aria-label', task.done ? 'Completed' : 'Complete task');
    if (task.done) check.disabled = true;
    else check.addEventListener('click', () => completeTask(task.id, card));

    const body = el('div', 'task-body');
    body.append(el('div', 'task-title', task.title));

    const chips = el('div', 'chips');
    chips.append(el('span', `chip chip--${task.priority}`, task.priority.toUpperCase()));
    if (task.done) {
      chips.append(el('span', 'chip chip--done', `DONE ${shortDate(task.completedAt || Date.now(), false)}`));
    } else {
      const due = dueChip(task);
      if (due) chips.append(due);
    }
    body.append(chips);

    const del = el('button', 'task-del', 'X');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete task');
    del.addEventListener('click', () => deleteTask(task.id, card));

    card.append(check, body, del);
    return card;
  }

  function renderList() {
    const tasks = tasksFor(filter);
    dom.taskList.replaceChildren(...tasks.map(buildCard));
    justAddedId = null;

    const [title, text] = EMPTY_COPY[filter];
    dom.emptyTitle.textContent = title;
    dom.emptyText.textContent = text;
    dom.empty.hidden = tasks.length > 0;
  }

  function renderSidebar() {
    const { xp, streak, lastCompletedDay } = state.stats;
    const intoLevel = xp % XP_PER_LEVEL;
    const lit = Math.floor((intoLevel / XP_PER_LEVEL) * XP_PELLETS);

    dom.levelNum.textContent = pad2(levelOf(xp));
    dom.xpText.textContent = `${intoLevel}/${XP_PER_LEVEL}`;

    [...dom.xpBar.children].forEach((dot, i) => {
      const on = i < lit;
      const wasOn = dot.classList.contains('is-on');
      dot.classList.toggle('is-on', on);
      dot.classList.remove('is-pop');
      if (on && !wasOn && shownPellets !== null) {
        void dot.offsetWidth; // restart the animation
        dot.classList.add('is-pop');
      }
    });
    shownPellets = lit;

    // A streak only counts while it's alive: last clear was today or yesterday.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const alive = lastCompletedDay === dayKey(new Date()) || lastCompletedDay === dayKey(yesterday);
    const shown = alive ? streak : 0;
    dom.streakNum.textContent = String(shown);
    dom.flame.classList.toggle('is-lit', shown > 0);

    for (const name of ['all', 'today', 'overdue', 'done']) {
      const count = tasksFor(name).length;
      const node = dom.filters.querySelector(`[data-count="${name}"]`);
      node.textContent = String(count);
      node.classList.toggle('has-items', count > 0);
    }
    for (const button of dom.filters.querySelectorAll('.filter')) {
      button.classList.toggle('is-active', button.dataset.filter === filter);
    }
  }

  function render() {
    renderSidebar();
    renderList();
  }

  // Never repaint the list under a card that is mid-animation; the animation's
  // own handler repaints when it finishes.
  function applyState(next) {
    state = next;
    if (leaving.size === 0) render();
  }

  // -------------------------------------------------------------- actions --

  function collapse(card) {
    card.style.height = `${card.offsetHeight}px`;
    void card.offsetHeight; // lock the start height before transitioning
    card.classList.add('is-collapsing');
    card.style.height = '0px';
  }

  function spawnXpPop(rect, amount) {
    if (!(amount > 0)) return;
    const pop = el('div', 'xp-pop', `+${amount} XP`);
    // Start just above the circle so it never sits on top of the title.
    pop.style.left = `${rect.left - 4}px`;
    pop.style.top = `${rect.top - 20}px`;
    pop.addEventListener('animationend', () => pop.remove());
    document.body.append(pop);
  }

  async function completeTask(id, card) {
    if (leaving.has(id)) return;
    leaving.add(id);

    const xpBefore = state.stats.xp;
    const levelBefore = levelOf(xpBefore);
    const rect = card.querySelector('.check').getBoundingClientRect();

    card.classList.add('is-completing');
    const request = api.completeTask(id).catch((err) => {
      console.error(err);
      return null;
    });
    request.then((next) => next && spawnXpPop(rect, next.stats.xp - xpBefore));

    await sleep(180); // ring fills, pops and flashes
    collapse(card);
    await sleep(230); // card folds away — about 400ms in total

    const next = await request;
    leaving.delete(id);
    if (next) state = next;
    render();

    if (levelOf(state.stats.xp) > levelBefore) {
      dom.levelBadge.classList.remove('is-levelup');
      void dom.levelBadge.offsetWidth;
      dom.levelBadge.classList.add('is-levelup');
    }
  }

  async function deleteTask(id, card) {
    if (leaving.has(id)) return;
    leaving.add(id);

    const request = api.deleteTask(id).catch((err) => {
      console.error(err);
      return null;
    });
    collapse(card);
    await sleep(230);

    const next = await request;
    leaving.delete(id);
    if (next) state = next;
    render();
  }

  function setFilter(name) {
    filter = name;
    render();
    dom.taskList.scrollTop = 0;
  }

  // ---------------------------------------------------------------- modal --

  const modalOpen = () => !dom.modal.hidden;

  function selectPriority(priority) {
    selectedPriority = priority;
    for (const button of dom.prioGroup.querySelectorAll('.prio')) {
      const on = button.dataset.priority === priority;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-checked', String(on));
    }
  }

  function syncReminder() {
    const hasDue = Boolean(dom.fDue.value);
    dom.fReminder.disabled = !hasDue;
    if (!hasDue) dom.fReminder.checked = false;
    dom.reminderRow.classList.toggle('is-disabled', !hasDue);
    dom.reminderText.textContent = hasDue
      ? "Remind me when it's due"
      : 'Set a due date to enable a reminder';
  }

  function openModal() {
    if (modalOpen()) return;
    dom.form.reset();
    dom.fTitle.classList.remove('is-invalid');
    selectPriority('low');
    syncReminder();
    dom.modal.hidden = false;
    dom.app.inert = true; // keeps Tab focus inside the modal
    dom.fTitle.focus();
  }

  function closeModal() {
    if (!modalOpen()) return;
    dom.modal.hidden = true;
    dom.app.inert = false;
    dom.createBtn.focus({ preventScroll: true });
    dom.createBtn.blur();
  }

  async function submitTask() {
    if (submitting) return;

    const title = dom.fTitle.value.trim();
    if (!title) {
      dom.fTitle.classList.remove('is-invalid');
      void dom.fTitle.offsetWidth;
      dom.fTitle.classList.add('is-invalid');
      dom.fTitle.focus();
      return;
    }

    const dueMs = dom.fDue.value ? new Date(dom.fDue.value).getTime() : NaN;
    const due = Number.isFinite(dueMs) ? dueMs : null;

    submitting = true;
    try {
      const idsBefore = new Set(state.tasks.map((t) => t.id));
      const next = await api.addTask({
        title,
        priority: selectedPriority,
        due,
        reminder: dom.fReminder.checked && due !== null,
      });
      const added = next.tasks.find((t) => !idsBefore.has(t.id));
      justAddedId = added ? added.id : null;
      state = next;
      closeModal();
      // Make sure the new task is actually on screen.
      if (added && !tasksFor(filter).some((t) => t.id === added.id)) filter = 'all';
      render();
    } catch (err) {
      console.error(err);
    } finally {
      submitting = false;
    }
  }

  // --------------------------------------------------------------- wiring --

  dom.createBtn.addEventListener('click', openModal);
  dom.modalClose.addEventListener('click', closeModal);

  dom.modal.addEventListener('mousedown', (event) => {
    if (event.target === dom.modal) closeModal();
  });

  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitTask();
  });

  // Enter saves from anywhere in the modal (except the close button).
  dom.form.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (event.target === dom.modalClose) return;
    event.preventDefault();
    submitTask();
  });

  dom.prioGroup.addEventListener('click', (event) => {
    const button = event.target.closest('.prio');
    if (button) selectPriority(button.dataset.priority);
  });

  dom.fDue.addEventListener('input', syncReminder);
  dom.fTitle.addEventListener('input', () => dom.fTitle.classList.remove('is-invalid'));

  dom.filters.addEventListener('click', (event) => {
    const button = event.target.closest('.filter');
    if (button) setFilter(button.dataset.filter);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalOpen()) {
      event.preventDefault();
      closeModal();
      return;
    }
    // The app menu owns Cmd+N; this is the fallback if the menu doesn't catch it.
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openModal();
    }
  });

  api.onOpenCreate(openModal);
  api.onStateChanged(applyState);

  // Due chips drift into TODAY / OVERDUE as time passes.
  const refresh = () => {
    if (leaving.size === 0) render();
  };
  setInterval(refresh, 30 * 1000);
  window.addEventListener('focus', refresh);

  // ------------------------------------------------------- static sprites --

  function buildXpBar() {
    for (let i = 0; i < XP_PELLETS; i += 1) dom.xpBar.append(el('span', 'xp-dot'));
  }

  function buildFlame() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${FLAME[0].length} ${FLAME.length}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    FLAME.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === '.') return;
        const rect = document.createElementNS(NS, 'rect');
        rect.setAttribute('x', x);
        rect.setAttribute('y', y);
        rect.setAttribute('width', 1);
        rect.setAttribute('height', 1);
        rect.setAttribute('fill', cell === 'Y' ? '#FFB347' : '#FF7A1A');
        svg.append(rect);
      });
    });
    dom.flame.append(svg);
  }

  // --------------------------------------------------------------- splash --

  async function runSplash() {
    for (let i = 0; i < SPLASH_PELLETS; i += 1) {
      const dot = el('span', 'splash-dot');
      dot.style.setProperty('--i', i);
      dom.splashTrack.append(dot);
    }

    // Wait briefly for the pixel fonts so the title doesn't swap mid-animation.
    await Promise.race([
      Promise.all([
        document.fonts.load("16px 'Press Start 2P'"),
        document.fonts.load("20px 'VT323'"),
      ]).catch(() => {}),
      sleep(700),
    ]);

    dom.splash.classList.add('is-running');
    await sleep(SPLASH_MS);
    dom.splash.classList.add('is-done');
    await sleep(450);
    dom.splash.remove();
  }

  // ----------------------------------------------------------------- boot --

  async function boot() {
    buildXpBar();
    buildFlame();
    runSplash();
    try {
      state = await api.getState();
    } catch (err) {
      console.error(err);
    }
    render();
  }

  boot();
})();

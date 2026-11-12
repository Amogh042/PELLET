const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pellet', {
  getState: () => ipcRenderer.invoke('state:get'),
  addTask: (task) => ipcRenderer.invoke('task:add', task),
  completeTask: (id) => ipcRenderer.invoke('task:complete', id),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  ackStreakLost: () => ipcRenderer.invoke('streak:ack'),

  onStateChanged: (callback) => {
    ipcRenderer.on('state:changed', (_event, state) => callback(state));
  },
  onOpenCreate: (callback) => {
    ipcRenderer.on('ui:open-create', () => callback());
  },
});

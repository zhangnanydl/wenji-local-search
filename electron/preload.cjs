const { contextBridge, ipcRenderer } = require('electron')

function localFileUrl(filePath) {
  const segments = String(filePath).replace(/\\/g, '/').split('/')
  return `file:///${segments.map((segment, index) => index === 0 ? segment : encodeURIComponent(segment)).join('/')}`
}

contextBridge.exposeInMainWorld('wenji', {
  getState: () => ipcRenderer.invoke('state:get'),
  addFolder: () => ipcRenderer.invoke('folder:add'),
  removeFolder: (folder) => ipcRenderer.invoke('folder:remove', folder),
  rebuild: () => ipcRenderer.invoke('index:rebuild'),
  search: (query, filters) => ipcRenderer.invoke('search', { query, filters }),
  mediaUrl: localFileUrl,
  openFile: (result, locate = false) => ipcRenderer.invoke('file:open', { result, locate }),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  copyPath: (filePath) => ipcRenderer.invoke('file:copy-path', filePath),
  showContextMenu: (result) => ipcRenderer.send('result:context-menu', result),
  onIndexProgress: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('index:progress', listener)
    return () => ipcRenderer.removeListener('index:progress', listener)
  },
  onIndexChanged: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('index:changed', listener)
    return () => ipcRenderer.removeListener('index:changed', listener)
  },
  onIndexError: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('index:error', listener)
    return () => ipcRenderer.removeListener('index:error', listener)
  },
  onFocusSearch: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('search:focus', listener)
    return () => ipcRenderer.removeListener('search:focus', listener)
  },
  onActionNotice: (callback) => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('action:notice', listener)
    return () => ipcRenderer.removeListener('action:notice', listener)
  }
})

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  initialize: () => ipcRenderer.invoke('initialize'),
  downloadModel: () => ipcRenderer.invoke('download-model'),
  loadModel: () => ipcRenderer.invoke('load-model'),
  describeImage: (base64, mimeType) => ipcRenderer.invoke('describe-image', base64, mimeType),
  selectImage: () => ipcRenderer.invoke('select-image'),

  onStatus: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onDownloadProgress: (cb) => {
    const handler = (_e, pct) => cb(pct);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
  onDescribeChunk: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('describe-chunk', handler);
    return () => ipcRenderer.removeListener('describe-chunk', handler);
  }
});

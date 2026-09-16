'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('phashAPI', {
  chooseVideos: () => ipcRenderer.invoke('choose-videos'),

  runPipeline: (jobId, videoPath) => ipcRenderer.invoke('run-pipeline', { jobId, videoPath }),

  onProgress: (jobId, callback) => {
    const channel = `pipeline-progress:${jobId}`;
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  describeBackend: () => ipcRenderer.invoke('describe-backend'),

  // Dropped File objects -> filesystem paths. Electron >= 32 removed the
  // non-standard File.path; webUtils is the sanctioned replacement and is
  // only reachable from the preload side of the bridge.
  acceptDroppedFiles: (files) => files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phashAPI', {
  chooseVideos: () => ipcRenderer.invoke('choose-videos'),

  runPipeline: (jobId, videoPath) => ipcRenderer.invoke('run-pipeline', { jobId, videoPath }),

  onProgress: (jobId, callback) => {
    const channel = `pipeline-progress:${jobId}`;
    const listener = (_event, msg) => callback(msg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  hammingDistance: (hexA, hexB) => ipcRenderer.invoke('hamming-distance', { hexA, hexB }),
});

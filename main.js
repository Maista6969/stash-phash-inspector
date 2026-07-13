'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { join } = require('path');
const { runPipeline } = require('./src/pipeline');
const { hammingDistance } = require('./shared/phash-core');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 780,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('choose-videos', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'wmv'] }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});


// Runs the pipeline for a single video and streams progress back to the
// renderer via a per-job event channel, since results (frame bitmaps,
// the montage, DCT arrays) are too large/frequent to return in one shot.
ipcMain.handle('run-pipeline', async (event, { jobId, videoPath }) => {
  const send = (stage, payload) => {
    // Convert typed arrays / BigInt into transferable, renderer-friendly shapes
    let serializable = payload;
    if (stage === 'frame') {
      serializable = {
        index: payload.index,
        total: payload.total,
        timeSeconds: payload.timeSeconds,
        width: payload.frame.width,
        height: payload.frame.height,
        data: Buffer.from(payload.frame.data.buffer, payload.frame.data.byteOffset, payload.frame.data.byteLength),
        previewWidth: payload.previewFrame.width,
        previewHeight: payload.previewFrame.height,
        previewData: Buffer.from(
          payload.previewFrame.data.buffer,
          payload.previewFrame.data.byteOffset,
          payload.previewFrame.data.byteLength
        ),
      };
    } else if (stage === 'montage') {
      serializable = {
        width: payload.montage.width,
        height: payload.montage.height,
        data: Buffer.from(payload.montage.data.buffer, payload.montage.data.byteOffset, payload.montage.data.byteLength),
      };
    } else if (stage === 'hash') {
      serializable = {
        hex: payload.hex,
        int64: payload.int64,
        median: payload.median,
        dctCoefficients8x8: Array.from(payload.dctCoefficients8x8),
        resizedGray64x64: Array.from(payload.resizedGray64x64),
        bits: payload.bits,
      };
    }
    event.sender.send(`pipeline-progress:${jobId}`, { stage, payload: serializable });
  };

  try {
    const { duration, result } = await runPipeline(videoPath, send);
    return { ok: true, duration, hex: result.hex, int64: result.int64 };
  } catch (err) {
    event.sender.send(`pipeline-progress:${jobId}`, { stage: 'error', payload: { message: err.message } });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('hamming-distance', (event, { hexA, hexB }) => {
  const a = BigInt('0x' + hexA);
  const b = BigInt('0x' + hexB);
  return hammingDistance(a, b);
});

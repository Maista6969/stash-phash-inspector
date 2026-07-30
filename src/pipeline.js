'use strict';

const { probeDuration, extractFrame } = require('./ffmpeg-extract');
const PipelineCore = require('../shared/pipeline-core');

/**
 * Node/Electron binding of the shared pipeline: native ffmpeg/ffprobe
 * child processes, previews at the source's native resolution. See
 * shared/pipeline-core.js for the stage/progress contract.
 *
 * `deps` lets tests and the CLI override probeDuration / extractFrame or
 * pass `preview: false` to skip the display-only extraction.
 */
function runPipeline(videoPath, onProgress, deps = {}) {
  return PipelineCore.runPipeline(videoPath, onProgress, { probeDuration, extractFrame, ...deps });
}

module.exports = { runPipeline };

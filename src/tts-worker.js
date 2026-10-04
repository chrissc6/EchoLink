import { KokoroTTS, env as kokoroEnv } from '../vendor/kokoro.js';
import { env as transformersEnv } from '@huggingface/transformers';

let engine;
let initialization;
let cancelled = new Set();
let queue = [];
let draining = false;
let sessionId = 0;

const send = (type, data = {}) => self.postMessage({ type, ...data });

function initialize() {
  if (engine) return Promise.resolve(engine);
  if (initialization) return initialization;
  initialization = initializeEngine().catch((error) => { initialization = null; throw error; });
  return initialization;
}

async function initializeEngine() {
  if (!('gpu' in navigator)) throw new Error('WebGPU is unavailable in this browser. Open this app in a recent version of Chrome or Edge with GPU acceleration enabled.');
  transformersEnv.allowLocalModels = true;
  transformersEnv.allowRemoteModels = false;
  transformersEnv.useBrowserCache = false;
  transformersEnv.localModelPath = new URL('/models/', self.location.href).href;
  kokoroEnv.wasmPaths = new URL('/tts/runtime/', self.location.href).href;
  send('status', { status: 'loading', message: 'Loading Kokoro Heart · FP32 WebGPU' });
  const voiceUrl = new URL('/tts/voices/af_heart.bin', self.location.href);
  const voiceResponse = await fetch(voiceUrl);
  if (!voiceResponse.ok) throw new Error(`Heart voice file is missing (${voiceResponse.status}). Rebuild the local app assets.`);
  if (self.caches) {
    try { const voiceCache = await caches.open('kokoro-voices'); await voiceCache.put(voiceUrl.href, voiceResponse.clone()); }
    catch (error) { send('status', { status: 'warning', message: `Heart voice is loaded, but browser cache is unavailable: ${error.message}` }); }
  }
  const modelPath = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  engine = await KokoroTTS.from_pretrained(modelPath, {
    dtype: 'fp32', device: 'webgpu',
    progress_callback: (event) => send('progress', { progress: event }),
  });
  send('status', { status: 'ready', message: 'Kokoro Heart is ready' });
}

function enqueue(message) {
  const task = { ...message, sessionId };
  if (message.priority) {
    const index = queue.findIndex((item) => item.sessionId === sessionId);
    queue.splice(index < 0 ? 0 : index, 0, task);
  } else queue.push(task);
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const task = queue.shift();
    if (cancelled.has(task.sessionId)) continue;
    try {
      await initialize();
      if (cancelled.has(task.sessionId)) continue;
      send('status', { status: 'generating', message: 'Generating speech' });
      const audio = await engine.generate(task.text, { voice: 'af_heart', speed: 1.0 });
      if (cancelled.has(task.sessionId)) continue;
      const samples = new Float32Array(audio.audio); // Kokoro RawAudio contains mono 24 kHz float samples.
      send('audio', { sessionId: task.sessionId, index: task.index, text: task.text, start: task.start, end: task.end, samples }, [samples.buffer]);
    } catch (error) {
      if (!cancelled.has(task.sessionId)) send('error', { sessionId: task.sessionId, message: error?.message || String(error) });
    }
  }
  draining = false;
  send('queue-empty', { sessionId });
  if (engine && !cancelled.has(sessionId)) send('status', { status: 'ready', message: 'Speech is ready' });
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'initialize') { initialize().catch((error) => send('error', { message: error?.message || String(error) })); return; }
  if (message.type === 'prepare') {
    if (sessionId) cancelled.add(sessionId);
    sessionId = message.sessionId;
    cancelled.delete(sessionId);
    queue = [];
    for (const chunk of message.chunks) queue.push({ ...chunk, sessionId, priority: false });
    drain();
  }
  if (message.type === 'prioritize') {
    const at = queue.findIndex((item) => item.sessionId === sessionId && item.index >= message.index);
    if (at > 0) { const [target] = queue.splice(at, 1); queue.unshift({ ...target, priority: true }); }
  }
  if (message.type === 'cancel') {
    cancelled.add(message.sessionId);
    queue = queue.filter((task) => task.sessionId !== message.sessionId);
    send('cancelled', { sessionId: message.sessionId });
  }
};

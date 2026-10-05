export class KokoroReaderSession {
  constructor(worker, context, onUpdate) {
    this.worker = worker;
    this.context = context;
    this.onUpdate = onUpdate;
    this.id = 0;
    this.chunks = [];
    this.duration = 0;
    this.position = 0;
    this.rate = 1;
    this.volume = 0.82;
    this.voice = 'af_heart';
    this.playing = false;
    this.paused = false;
    this.source = null;
    this.activeGain = null;
    this.startedAt = 0;
    this.startedPosition = 0;
    this.generated = 0;
    this.cursor = 0;
    this.queueEmpty = false;
    this.onMessage = this.onMessage.bind(this);
    worker.addEventListener('message', this.onMessage);
  }

  prepare(text, { cleanFormatting = false } = {}) {
    this.stop();
    this.id++;
    this.chunks = chunkText(cleanFormatting ? cleanEchoLinkText(text) : text);
    this.recomputeTimeline();
    this.position = 0;
    this.cursor = 0;
    this.generated = 0;
    this.queueEmpty = false;
    this.paused = true;
    this.worker.postMessage({ type: 'prepare', sessionId: this.id, voice: this.voice, chunks: this.chunks.map(({ text, start, end, index }) => ({ text, start, end, index })) });
    this.emit();
  }

  async play() {
    if (this.playing) return;
    // Reflect the request immediately so a quick second click can reliably pause
    // while AudioContext.resume() is still pending (common on first interaction).
    this.playing = true;
    this.paused = false;
    this.startedPosition = this.position;
    this.emit();
    try {
      await this.context.resume();
    } catch (error) {
      this.playing = false;
      this.paused = true;
      this.emit('error', error?.message || 'Audio playback could not start.');
      throw error;
    }
    if (!this.playing) return;
    this.schedule();
    this.emit();
  }
  pause() {
    this.position = this.currentPosition();
    this.playing = false;
    this.paused = true;
    this.source?.stop(); this.source = null;
    this.emit();
  }
  stop() {
    if (this.id) this.worker.postMessage({ type: 'cancel', sessionId: this.id });
    this.playing = false;
    this.paused = true;
    this.source?.stop(); this.source = null;
    this.position = 0;
    this.cursor = 0;
    this.chunks = [];
    this.duration = 0;
    this.generated = 0;
    this.queueEmpty = false;
    this.emit();
  }
  seek(seconds) {
    const wasPlaying = this.playing;
    this.source?.stop(); this.source = null;
    this.position = Math.max(0, Math.min(seconds, this.duration || 0));
    this.startedPosition = this.position;
    this.cursor = this.chunks.findIndex((chunk) => this.position < chunk.end);
    if (this.cursor < 0) this.cursor = this.chunks.length;
    const target = this.chunks.findIndex((chunk) => this.position <= chunk.end);
    if (target >= 0 && !this.chunks[target].buffer) this.worker.postMessage({ type: 'prioritize', index: target });
    this.playing = wasPlaying;
    if (wasPlaying) this.schedule();
    this.emit();
  }
  skip(seconds) { this.seek(this.currentPosition() + seconds); }
  setPlaybackRate(rate) {
    this.position = this.currentPosition(); this.startedPosition = this.position; this.rate = rate;
    if (this.source) { this.source.playbackRate.value = rate; this.startedAt = this.context.currentTime; }
    this.emit();
  }
  setVolume(value) { this.volume = value; if (this.activeGain) this.activeGain.gain.setTargetAtTime(value, this.context.currentTime, 0.015); this.emit(); }
  currentPosition() {
    if (!this.playing || !this.source) return this.position;
    return Math.min(this.duration, this.startedPosition + (this.context.currentTime - this.startedAt) * this.rate);
  }
  schedule() {
    if (!this.playing || this.source) return;
    const position = this.position;
    let index = this.chunks.findIndex((chunk) => chunk.buffer && position < chunk.start + chunk.duration);
    if (index < 0) index = this.chunks.findIndex((chunk) => !chunk.buffer);
    if (index < 0) {
      if (this.queueEmpty) { this.playing = false; this.position = this.duration; this.emit(); }
      else this.emit('buffering');
      return;
    }
    const chunk = this.chunks[index];
    if (!chunk.buffer) { this.cursor = index; this.worker.postMessage({ type: 'prioritize', index }); this.emit('buffering'); return; }
    this.cursor = index;
    const source = this.context.createBufferSource();
    source.buffer = chunk.buffer; source.playbackRate.value = this.rate;
    const gain = this.context.createGain(); gain.gain.value = this.volume;
    this.activeGain = gain;
    source.connect(gain).connect(this.context.destination);
    const offset = Math.max(0, position - chunk.start);
    this.startedPosition = chunk.start + offset; this.startedAt = this.context.currentTime;
    this.source = source;
    source.onended = () => {
      if (this.source !== source) return;
      this.position = chunk.start + chunk.duration;
      this.source = null; this.activeGain = null;
      this.schedule();
    };
    source.start(0, offset);
    this.emit();
  }
  onMessage(event) {
    const m = event.data;
    if (m.type === 'audio' && m.sessionId === this.id) {
      const chunk = this.chunks[m.index];
      if (!chunk) return;
      const buffer = this.context.createBuffer(1, m.samples.length, 24000);
      buffer.copyToChannel(m.samples, 0);
      chunk.buffer = buffer; chunk.duration = buffer.duration;
      // Recompute the cumulative, real audio timeline whenever a prior chunk arrives.
      this.recomputeTimeline(); this.generated++;
      this.schedule(); this.emit();
    } else if (m.type === 'queue-empty' && m.sessionId === this.id) {
      this.queueEmpty = true; this.schedule(); this.emit();
    } else if (m.type === 'status') this.emit(m.status, m.message, m);
    else if (m.type === 'progress') {
      const progress = m.progress || {};
      const percent = Number.isFinite(progress.progress) ? ` · ${Math.round(progress.progress)}%` : '';
      this.emit('loading', `${progress.status === 'done' ? 'Preparing local model' : 'Loading Kokoro on this device'}${percent}`);
    }
    else if (m.type === 'error' && (!m.sessionId || m.sessionId === this.id)) this.emit('error', m.message, m);
  }
  recomputeTimeline() {
    let cursor = 0;
    for (const item of this.chunks) {
      item.start = cursor;
      cursor += item.buffer ? item.duration : item.estimate;
      item.end = cursor;
    }
    this.duration = cursor;
  }
  emit(status, message, details = {}) {
    this.onUpdate?.({ ...details, status, message, playing: this.playing, paused: this.paused, position: this.currentPosition(), duration: this.duration, generated: this.generated, total: this.chunks.length, chunks: this.chunks, cursor: this.cursor, buffering: this.playing && !this.source && !this.queueEmpty });
  }
}

/** Replace Markdown presentation syntax with spaces while retaining source offsets for highlighting. */
export function cleanEchoLinkText(input) {
  const source = String(input || '');
  const output = source.split('');
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    }
  };
  for (const match of source.matchAll(/(!?)\[([^\]\r\n]*)\]\((?:<[^>\r\n]*>|[^)\r\n]*)\)/g)) {
    const start = match.index;
    const labelStart = start + match[1].length + 1;
    const labelEnd = labelStart + match[2].length;
    blank(start, labelStart);
    blank(labelEnd, start + match[0].length);
  }
  for (const match of source.matchAll(/^[ \t]*(`{3,}|~{3,})[^\r\n]*$/gm)) {
    const marker = match[0].search(/`{3,}|~{3,}/);
    blank(match.index + marker, match.index + match[0].length);
  }
  for (const match of source.matchAll(/(`+)([^`\r\n]+)\1/g)) {
    blank(match.index, match.index + match[1].length);
    blank(match.index + match[0].length - match[1].length, match.index + match[0].length);
  }
  for (const match of source.matchAll(/^[ \t]{0,3}(?:#{1,6}(?=\s)|>+\s?|[-+*](?=\s))\s*/gm)) blank(match.index, match.index + match[0].length);
  for (const match of source.matchAll(/^[ \t]{0,3}(?:[-*_]\s*){3,}$/gm)) blank(match.index, match.index + match[0].length);
  for (const match of source.matchAll(/(\*\*|__|~~|\*|_)([^\r\n]*?\S)\1/g)) {
    blank(match.index, match.index + match[1].length);
    blank(match.index + match[0].length - match[1].length, match.index + match[0].length);
  }
  for (let index = 0; index < output.length; index += 1) {
    if (!/[,.;:!?]/.test(output[index])) continue;
    let start = index;
    while (start > 0 && /[ \t]/.test(output[start - 1])) start -= 1;
    if (start < index) { output[start] = output[index]; output[index] = ' '; }
  }
  return output.join('');
}

export function chunkText(input, maxChars = 260) {
  const chunks = [];
  let sourceOffset = 0;
  const paragraphs = input.split(/(\n\s*\n)/);
  for (const segment of paragraphs) {
    if (!segment || /^\n\s*\n$/.test(segment)) { sourceOffset += segment.length; continue; }
    const matches = [...segment.matchAll(/[^.!?…]+(?:[.!?…]+["'’”)]*)?(?:\s+|$)/g)];
    const sentences = matches.length ? matches : [{ 0: segment, index: 0 }];
    let carry = '', carryStart = sourceOffset;
    for (const match of sentences) {
      const sentence = match[0].trim();
      if (!sentence) continue;
      const start = sourceOffset + match.index;
      let pieces = [{ text: sentence, start, end: start + sentence.length }];
      if (sentence.length > maxChars) {
        pieces = [];
        let offset = 0;
        while (offset < sentence.length) {
          let end = Math.min(offset + maxChars, sentence.length);
          if (end < sentence.length) { const space = sentence.lastIndexOf(' ', end); if (space > offset) end = space; }
          const raw = sentence.slice(offset, end);
          const leading = raw.length - raw.trimStart().length;
          const trailing = raw.length - raw.trimEnd().length;
          if (raw.trim()) pieces.push({ text: raw.trim(), start: start + offset + leading, end: start + end - trailing });
          offset = end;
          while (/\s/.test(sentence[offset] || '') && offset < sentence.length) offset++;
        }
      }
      for (const piece of pieces) {
        if (carry && (carry.length + piece.text.length + 1 > maxChars)) { chunks.push({ index: chunks.length, text: carry.trim(), sourceStart: carryStart, sourceEnd: piece.start }); carry = ''; }
        if (!carry) carryStart = piece.start;
        carry += `${carry ? ' ' : ''}${piece.text}`;
        if (carry.length >= maxChars) { chunks.push({ index: chunks.length, text: carry.trim(), sourceStart: carryStart, sourceEnd: piece.end }); carry = ''; }
      }
    }
    if (carry.trim()) chunks.push({ index: chunks.length, text: carry.trim(), sourceStart: carryStart, sourceEnd: sourceOffset + segment.length });
    sourceOffset += segment.length;
  }
  let time = 0;
  for (const chunk of chunks) {
    chunk.start = time;
    chunk.duration = 0;
    chunk.estimate = Math.max(1.1, chunk.text.trim().split(/\s+/).length / 2.55);
    time += chunk.estimate;
    chunk.end = time;
  }
  return chunks;
}

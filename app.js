'use strict';

/* =========================================================
 * 숏폼 메이커 — 브라우저에서 동작하는 9:16 세로 영상 편집기
 * 사진/영상/텍스트 슬라이드를 이어 붙이고, 자막·제목·배경음악을
 * 얹어서 canvas + MediaRecorder 로 영상 파일을 만든다.
 * ========================================================= */

const W = 1080;
const H = 1920;
const FPS = 30;
const FADE = 0.35; // 페이드 전환 길이(초)
const FONT = '"Noto Sans KR", system-ui, sans-serif';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');

// 흐린 배경용 저해상도 캔버스 (작게 그린 뒤 크게 늘리면 블러처럼 보인다)
const blurCanvas = document.createElement('canvas');
blurCanvas.width = 36;
blurCanvas.height = 64;
const blurCtx = blurCanvas.getContext('2d');

const state = {
  clips: [],
  bgm: null, // { name, url, el, gain }
  playing: false,
  time: 0,
  clock: { startNow: 0, startT: 0 },
  export: null, // { recorder, chunks, cancelled }
};

let nextId = 1;

/* ---------------- 설정 ---------------- */

function settings() {
  return {
    titleText: $('titleText').value.trim(),
    titleSize: +$('titleSize').value,
    titleColor: $('titleColor').value,
    captionSize: +$('captionSize').value,
    captionColor: $('captionColor').value,
    captionPos: $('captionPos').value,
    captionStyle: $('captionStyle').value,
    transition: $('transition').checked,
    kenBurns: $('kenBurns').checked,
    progressBar: $('progressBar').checked,
    bgmVolume: +$('bgmVolume').value,
  };
}

/* ---------------- 타임라인 ---------------- */

function clipDur(c) {
  if (c.type === 'video') return Math.max(0.1, c.end - c.start);
  return Math.max(0.1, c.duration);
}

function totalDuration() {
  return state.clips.reduce((sum, c) => sum + clipDur(c), 0);
}

function clipStartTime(index) {
  let acc = 0;
  for (let i = 0; i < index; i++) acc += clipDur(state.clips[i]);
  return acc;
}

// 시간 t 에 재생 중인 클립과 클립 내부 시간을 찾는다
function locate(t) {
  let acc = 0;
  const last = state.clips.length - 1;
  for (let i = 0; i <= last; i++) {
    const c = state.clips[i];
    const d = clipDur(c);
    if (t < acc + d || i === last) {
      return { index: i, clip: c, local: Math.min(Math.max(t - acc, 0), d), dur: d };
    }
    acc += d;
  }
  return null;
}

/* ---------------- 오디오 (Web Audio) ---------------- */

let actx = null;
let mixDest = null; // 녹화용 오디오 출력

function ensureAudio() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    mixDest = actx.createMediaStreamDestination();
  }
  if (actx.state === 'suspended') actx.resume();
}

// <video>/<audio> 소리를 스피커와 녹화 출력 양쪽으로 보낸다
function routeElement(el, volume) {
  ensureAudio();
  const src = actx.createMediaElementSource(el);
  const gain = actx.createGain();
  gain.gain.value = volume;
  src.connect(gain);
  gain.connect(actx.destination);
  gain.connect(mixDest);
  return gain;
}

function clipGain(c) {
  if (!c.gain) c.gain = routeElement(c.el, c.volume);
  return c.gain;
}

/* ---------------- 미디어 불러오기 ---------------- */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.onloadeddata = () => resolve(v);
    v.onerror = reject;
    v.src = url;
    v.load();
  });
}

async function addFiles(files) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    try {
      if (file.type.startsWith('image/')) {
        const el = await loadImage(url);
        state.clips.push({
          id: nextId++, type: 'image', name: file.name, url, el,
          duration: 3, caption: '', fit: 'blur',
        });
      } else if (file.type.startsWith('video/')) {
        const el = await loadVideo(url);
        el.addEventListener('seeked', () => { if (!state.playing) render(); });
        const len = isFinite(el.duration) ? el.duration : 10;
        state.clips.push({
          id: nextId++, type: 'video', name: file.name, url, el,
          start: 0, end: Math.min(len, 15), length: len,
          caption: '', fit: 'blur', volume: 1, gain: null,
        });
      } else {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      URL.revokeObjectURL(url);
      alert(`"${file.name}" 파일을 열 수 없어요. 브라우저가 지원하지 않는 형식일 수 있어요.`);
    }
  }
  refresh();
}

function addTextSlide() {
  const palette = ['#ff3b5c', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#111827'];
  state.clips.push({
    id: nextId++, type: 'color', name: '텍스트 슬라이드',
    color: palette[(nextId - 2) % palette.length],
    duration: 2.5, caption: '여기에 문구를 입력하세요', fit: 'cover',
  });
  refresh();
}

function removeClip(c) {
  const i = state.clips.indexOf(c);
  if (i < 0) return;
  state.clips.splice(i, 1);
  if (c.el && c.type === 'video') c.el.pause();
  if (c.url) URL.revokeObjectURL(c.url);
  refresh();
}

function moveClip(c, delta) {
  const i = state.clips.indexOf(c);
  const j = i + delta;
  if (j < 0 || j >= state.clips.length) return;
  [state.clips[i], state.clips[j]] = [state.clips[j], state.clips[i]];
  refresh();
}

/* ---------------- 그리기 ---------------- */

function mediaSize(c) {
  if (c.type === 'video') return [c.el.videoWidth, c.el.videoHeight];
  return [c.el.naturalWidth, c.el.naturalHeight];
}

function drawMedia(c, local, dur, s) {
  if (c.type === 'color') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c.color);
    g.addColorStop(1, shade(c.color, -0.45));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    return;
  }

  const [sw, sh] = mediaSize(c);
  if (!sw || !sh) return;

  const cover = Math.max(W / sw, H / sh);
  const contain = Math.min(W / sw, H / sh);

  if (c.fit === 'blur') {
    // 원본 비율을 유지하고, 남는 공간은 흐린 확대본으로 채운다
    const bw = sw * cover, bh = sh * cover;
    blurCtx.drawImage(c.el, (W - bw) / 2 / 30, (H - bh) / 2 / 30, bw / 30, bh / 30);
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, -40, -40, W + 80, H + 80);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  let scale = c.fit === 'cover' ? cover : contain;
  if (c.type === 'image' && s.kenBurns) scale *= 1 + 0.1 * (local / dur);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(c.el, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

// 한글처럼 띄어쓰기가 적은 문장도 폭에 맞게 줄바꿈한다
function wrapLines(text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) {
        const sp = line.lastIndexOf(' ');
        if (ch !== ' ' && sp > 0) {
          lines.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          lines.push(line);
          line = ch === ' ' ? '' : ch;
        }
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawText(text, { size, color, y, anchor, style, scale = 1, alpha = 1 }) {
  if (!text) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const maxW = W - 140;
  const lines = wrapLines(text, maxW);
  const lh = size * 1.3;
  const blockH = lh * lines.length;
  let top = anchor === 'top' ? y : anchor === 'bottom' ? y - blockH : y - blockH / 2;

  // 등장할 때 살짝 튀어나오는 효과
  const cy = top + blockH / 2;
  ctx.translate(W / 2, cy);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -cy);

  if (style === 'box') {
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const pad = size * 0.4;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(W / 2 - widest / 2 - pad, top - pad * 0.6, widest + pad * 2, blockH + pad * 1.2, size * 0.3);
    ctx.fill();
  }

  lines.forEach((line, i) => {
    const ly = top + lh * i + lh / 2;
    if (style === 'outline') {
      ctx.lineWidth = size * 0.18;
      ctx.strokeStyle = '#000';
      ctx.strokeText(line, W / 2, ly);
    } else if (style === 'plain') {
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = size * 0.25;
    }
    ctx.fillStyle = color;
    ctx.fillText(line, W / 2, ly);
  });
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(Math.min(255, Math.max(0, v + v * amt)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}

function render() {
  const s = settings();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const total = totalDuration();
  const loc = locate(state.time);

  if (!loc) {
    ctx.fillStyle = '#555';
    ctx.font = `700 56px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('클립을 추가해 주세요', W / 2, H / 2);
    return;
  }

  const { clip, local, dur, index } = loc;

  // 페이드 전환: 첫 클립 시작과 마지막 클립 끝은 페이드하지 않는다
  let alpha = 1;
  if (s.transition) {
    const fade = Math.min(FADE, dur / 3);
    if (index > 0) alpha = Math.min(alpha, local / fade);
    if (index < state.clips.length - 1) alpha = Math.min(alpha, (dur - local) / fade);
    alpha = Math.max(0, Math.min(1, alpha));
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  drawMedia(clip, local, dur, s);

  // 클립 자막
  const capY = { top: 420, middle: H / 2, bottom: H - 360 }[s.captionPos];
  const capAnchor = { top: 'top', middle: 'middle', bottom: 'bottom' }[s.captionPos];
  const pop = Math.min(1, local / 0.18);
  drawText(clip.caption, {
    size: s.captionSize, color: s.captionColor, y: capY, anchor: capAnchor,
    style: s.captionStyle, scale: 0.85 + 0.15 * pop, alpha: pop,
  });
  ctx.restore();

  // 상단 제목 (전체 영상 고정)
  if (s.titleText) {
    drawText(s.titleText, {
      size: s.titleSize, color: s.titleColor, y: 170, anchor: 'top', style: 'outline',
    });
  }

  if (s.progressBar && total > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(0, H - 14, W, 14);
    ctx.fillStyle = '#ff3b5c';
    ctx.fillRect(0, H - 14, W * (state.time / total), 14);
  }
}

/* ---------------- 재생 제어 ---------------- */

function syncVideos(loc) {
  for (const c of state.clips) {
    if (c.type === 'video' && c !== loc?.clip && !c.el.paused) c.el.pause();
  }

  // 다음 영상 클립을 미리 시작 지점으로 이동해 끊김을 줄인다
  if (loc && loc.dur - loc.local < 0.6) {
    const next = state.clips[loc.index + 1];
    if (next?.type === 'video' && next.el.paused && Math.abs(next.el.currentTime - next.start) > 0.05) {
      next.el.currentTime = next.start;
    }
  }

  if (!loc || loc.clip.type !== 'video') return;
  const c = loc.clip;
  const v = c.el;
  const target = c.start + loc.local;

  if (state.playing) {
    clipGain(c).gain.value = c.volume;
    if (v.paused) {
      if (Math.abs(v.currentTime - target) > 0.1) v.currentTime = target;
      v.play().catch(() => {});
    } else if (Math.abs(v.currentTime - target) > 0.35) {
      v.currentTime = target;
    }
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target;
  }
}

function syncBgm() {
  const bgm = state.bgm;
  if (!bgm) return;
  const total = totalDuration();
  if (state.playing) {
    if (!bgm.gain) bgm.gain = routeElement(bgm.el, 0);
    // 끝나기 1.5초 전부터 음악을 서서히 줄인다
    const fadeOut = Math.min(1, Math.max(0, (total - state.time) / 1.5));
    bgm.gain.gain.value = settings().bgmVolume * fadeOut;
    if (bgm.el.paused) {
      const len = bgm.el.duration || 1;
      bgm.el.currentTime = state.time % len;
      bgm.el.play().catch(() => {});
    }
  } else if (!bgm.el.paused) {
    bgm.el.pause();
  }
}

function update() {
  const loc = locate(state.time);
  syncVideos(loc);
  syncBgm();
  render();
  updateTransport(loc);
}

function play() {
  if (!state.clips.length) return;
  ensureAudio();
  const total = totalDuration();
  if (state.time >= total - 0.05) state.time = 0;
  state.playing = true;
  state.clock = { startNow: performance.now(), startT: state.time };
  $('playBtn').textContent = '❚❚';
  requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  $('playBtn').textContent = '▶';
  update();
}

function seek(t) {
  state.time = Math.max(0, Math.min(t, totalDuration()));
  if (state.playing) state.clock = { startNow: performance.now(), startT: state.time };
  update();
}

function tick() {
  if (!state.playing) return;
  const total = totalDuration();
  const t = state.clock.startT + (performance.now() - state.clock.startNow) / 1000;
  if (t >= total) {
    state.time = total;
    pause();
    if (state.export) finishExport();
    return;
  }
  state.time = t;
  update();
  if (state.export) setExportProgress(t / total);
  requestAnimationFrame(tick);
}

/* ---------------- 내보내기 ---------------- */

function pickMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function startExport() {
  if (!state.clips.length) return alert('먼저 클립을 추가해 주세요.');
  if (!window.MediaRecorder || !canvas.captureStream) {
    return alert('이 브라우저는 영상 녹화를 지원하지 않아요. 최신 Chrome 또는 Edge 를 사용해 주세요.');
  }

  ensureAudio();
  pause();
  seek(0);
  await document.fonts.ready;
  await new Promise((r) => setTimeout(r, 300)); // 첫 영상 프레임 준비 대기

  const stream = canvas.captureStream(FPS);
  mixDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  state.export = { recorder, chunks, mimeType: recorder.mimeType || mimeType, cancelled: false };
  recorder.onstop = () => onRecorderStop(state.export);

  setExporting(true);
  recorder.start(500);
  play();
}

function finishExport() {
  const ex = state.export;
  if (!ex) return;
  // 마지막 프레임이 담기도록 잠깐 기다렸다가 멈춘다
  setTimeout(() => ex.recorder.state !== 'inactive' && ex.recorder.stop(), 250);
}

function cancelExport() {
  if (!state.export) return;
  state.export.cancelled = true;
  pause();
  state.export.recorder.stop();
}

function onRecorderStop(ex) {
  state.export = null;
  setExporting(false);
  if (ex.cancelled || !ex.chunks.length) {
    $('exportText').textContent = ex.cancelled ? '내보내기를 취소했어요.' : '녹화된 데이터가 없어요.';
    return;
  }
  const type = (ex.mimeType || 'video/webm').split(';')[0];
  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(ex.chunks, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shortform-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const mb = (blob.size / 1024 / 1024).toFixed(1);
  $('exportText').textContent = `완료! ${ext.toUpperCase()} 파일(${mb}MB)을 저장했어요.`;
  $('exportBar').style.width = '100%';
}

function setExporting(on) {
  $('exportStatus').hidden = false;
  $('exportBtn').disabled = on;
  $('cancelExport').hidden = !on;
  $('playBtn').disabled = on;
  $('seek').disabled = on;
  document.querySelector('.editor').style.pointerEvents = on ? 'none' : '';
  document.querySelector('.editor').style.opacity = on ? '0.5' : '';
  if (on) setExportProgress(0);
}

function setExportProgress(p) {
  $('exportBar').style.width = `${Math.round(p * 100)}%`;
  $('exportText').textContent = `녹화 중… ${Math.round(p * 100)}%`;
}

/* ---------------- UI ---------------- */

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTransport(loc) {
  const total = totalDuration();
  const seekEl = $('seek');
  seekEl.max = total.toFixed(2);
  if (document.activeElement !== seekEl || state.playing) seekEl.value = state.time;
  $('timeLabel').textContent = `${fmt(state.time)} / ${fmt(total)}`;
  document.querySelectorAll('.clip').forEach((li) => {
    li.classList.toggle('active', !!loc && +li.dataset.id === loc.clip.id);
  });
}

function numInput(label, value, { min = 0, max = 600, step = 0.1 } = {}, onChange) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  const input = document.createElement('input');
  Object.assign(input, { type: 'number', min, max, step, value: +value.toFixed(2) });
  input.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, parseFloat(input.value) || min));
    input.value = +v.toFixed(2);
    onChange(v);
    update();
  });
  wrap.appendChild(input);
  return wrap;
}

function fitSelect(c) {
  const wrap = document.createElement('label');
  wrap.textContent = '화면 맞춤';
  const sel = document.createElement('select');
  [['blur', '흐린 배경'], ['cover', '꽉 채우기'], ['contain', '원본 비율']].forEach(([v, t]) => {
    sel.add(new Option(t, v, false, c.fit === v));
  });
  sel.addEventListener('change', () => { c.fit = sel.value; update(); });
  wrap.appendChild(sel);
  return wrap;
}

function buildClipItem(c, i) {
  const li = $('clipTemplate').content.firstElementChild.cloneNode(true);
  li.dataset.id = c.id;

  const thumb = li.querySelector('.thumb');
  if (c.type === 'image') {
    const img = new Image();
    img.src = c.url;
    thumb.appendChild(img);
  } else if (c.type === 'video') {
    const v = document.createElement('video');
    v.src = `${c.url}#t=${c.start + 0.1}`;
    v.muted = true;
    v.preload = 'metadata';
    thumb.appendChild(v);
  } else {
    thumb.style.background = c.color;
  }
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = `${i + 1} · ${clipDur(c).toFixed(1)}s`;
  thumb.appendChild(badge);
  thumb.addEventListener('click', () => seek(clipStartTime(state.clips.indexOf(c)) + 0.01));

  li.querySelector('.clip-name').textContent = c.name;

  const cap = li.querySelector('.caption');
  cap.value = c.caption;
  cap.addEventListener('input', () => { c.caption = cap.value; if (!state.playing) render(); });

  const opts = li.querySelector('.clip-opts');
  const refreshBadge = () => { badge.textContent = `${state.clips.indexOf(c) + 1} · ${clipDur(c).toFixed(1)}s`; };

  if (c.type === 'video') {
    opts.appendChild(numInput('시작(초)', c.start, { max: c.length, step: 0.1 }, (v) => {
      c.start = Math.min(v, c.end - 0.1); refreshBadge();
    }));
    opts.appendChild(numInput('끝(초)', c.end, { max: c.length, step: 0.1 }, (v) => {
      c.end = Math.max(v, c.start + 0.1); refreshBadge();
    }));
    const volWrap = document.createElement('label');
    volWrap.textContent = '원본 소리';
    const vol = document.createElement('input');
    Object.assign(vol, { type: 'range', min: 0, max: 1, step: 0.05, value: c.volume });
    vol.addEventListener('input', () => {
      c.volume = +vol.value;
      if (c.gain) c.gain.gain.value = c.volume;
    });
    volWrap.appendChild(vol);
    opts.appendChild(volWrap);
  } else {
    opts.appendChild(numInput('길이(초)', c.duration, { min: 0.5, max: 60, step: 0.5 }, (v) => {
      c.duration = v; refreshBadge();
    }));
  }

  if (c.type === 'color') {
    const colorWrap = document.createElement('label');
    colorWrap.textContent = '배경색';
    const color = document.createElement('input');
    Object.assign(color, { type: 'color', value: c.color });
    color.addEventListener('input', () => {
      c.color = color.value;
      thumb.style.background = c.color;
      if (!state.playing) render();
    });
    colorWrap.appendChild(color);
    opts.appendChild(colorWrap);
  } else {
    opts.appendChild(fitSelect(c));
  }

  li.querySelector('[data-act="up"]').addEventListener('click', () => moveClip(c, -1));
  li.querySelector('[data-act="down"]').addEventListener('click', () => moveClip(c, 1));
  li.querySelector('[data-act="remove"]').addEventListener('click', () => removeClip(c));
  return li;
}

// 클립 추가/삭제/순서 변경 시에만 목록을 다시 그린다 (입력 중 포커스 유지)
function refresh() {
  const list = $('clipList');
  list.replaceChildren(...state.clips.map(buildClipItem));
  $('emptyMsg').hidden = state.clips.length > 0;
  state.time = Math.min(state.time, totalDuration());
  update();
}

function bindUI() {
  $('fileInput').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('addTextSlide').addEventListener('click', addTextSlide);

  $('playBtn').addEventListener('click', () => (state.playing ? pause() : play()));
  $('seek').addEventListener('input', (e) => seek(+e.target.value));
  $('exportBtn').addEventListener('click', startExport);
  $('cancelExport').addEventListener('click', cancelExport);

  // 전체 설정은 바뀌는 즉시 미리보기에 반영
  document.querySelectorAll('.settings input, .settings select').forEach((el) => {
    if (el.type === 'file') return;
    el.addEventListener('input', () => { if (!state.playing) render(); });
  });

  $('bgmInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBgm(file);
  });
  $('bgmRemove').addEventListener('click', () => setBgm(null));

  // 화면 전체 드래그 앤 드롭
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    const audio = files.find((f) => f.type.startsWith('audio/'));
    if (audio) setBgm(audio);
    addFiles(files.filter((f) => !f.type.startsWith('audio/')));
  });

  // 스페이스바로 재생/일시정지
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || state.export) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    e.preventDefault();
    state.playing ? pause() : play();
  });
}

function setBgm(file) {
  if (state.bgm) {
    state.bgm.el.pause();
    if (state.bgm.gain) state.bgm.gain.disconnect();
    URL.revokeObjectURL(state.bgm.url);
    state.bgm = null;
  }
  if (file) {
    const url = URL.createObjectURL(file);
    const el = new Audio(url);
    el.loop = true;
    state.bgm = { name: file.name, url, el, gain: null };
  }
  $('bgmName').textContent = state.bgm ? state.bgm.name : '없음';
  $('bgmRemove').hidden = !state.bgm;
  if (state.playing) syncBgm();
}

bindUI();
refresh();
document.fonts.load(`900 64px ${FONT}`).then(() => render()).catch(() => {});

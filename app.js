'use strict';

/* =========================================================
 * 숏폼 메이커 — 브라우저에서 동작하는 9:16 세로 영상 편집기
 * 사진/영상/텍스트 슬라이드를 이어 붙이고, 자막·제목·배경음악을
 * 얹어서 canvas + MediaRecorder 로 영상 파일을 만든다.
 * ========================================================= */

const W = 1080;
const H = 1920;
const FPS = 30;
const TRANSITION = 0.5; // 클립 전환 길이(초)

const FONTS = {
  noto: { family: '"Noto Sans KR"', weight: 900 },
  blackhan: { family: '"Black Han Sans"', weight: 400 },
  dohyeon: { family: '"Do Hyeon"', weight: 400 },
  jua: { family: '"Jua"', weight: 400 },
  pen: { family: '"Nanum Pen Script"', weight: 400, scale: 1.25 },
};

// 자동 저장되는 전체 설정 입력들
const SETTING_IDS = [
  'titleText', 'titleSize', 'titleColor', 'fontFamily', 'highlightColor',
  'captionSize', 'captionColor', 'captionPos', 'captionStyle',
  'transitionType', 'kenBurns', 'progressBar', 'bgmVolume',
];

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
  bgm: null, // { name, file, url, el, gain }
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
    font: FONTS[$('fontFamily').value] || FONTS.noto,
    highlightColor: $('highlightColor').value,
    captionSize: +$('captionSize').value,
    captionColor: $('captionColor').value,
    captionPos: $('captionPos').value,
    captionStyle: $('captionStyle').value,
    transition: $('transitionType').value,
    kenBurns: $('kenBurns').checked,
    progressBar: $('progressBar').checked,
    bgmVolume: +$('bgmVolume').value,
  };
}

function readSettingsRaw() {
  const out = {};
  for (const id of SETTING_IDS) {
    const el = $(id);
    out[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function applySettingsRaw(raw) {
  for (const id of SETTING_IDS) {
    if (!(id in raw)) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!raw[id];
    else el.value = raw[id];
  }
}

const DEFAULT_SETTINGS = readSettingsRaw();

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

// 클립 앞부분의 전환 구간 길이 (첫 클립이거나 전환 없음이면 0)
function transitionLen(index, s) {
  if (index === 0 || s.transition === 'none') return 0;
  const prev = state.clips[index - 1];
  return Math.min(TRANSITION, clipDur(prev) / 2, clipDur(state.clips[index]) / 2);
}

// 자막을 '한 줄씩' 모드면 클립 길이를 줄 수로 나눠 순서대로 보여 준다
function captionSegments(c, dur) {
  const text = (c.caption || '').trim();
  if (!text) return [];
  if (c.captionMode !== 'lines') return [{ text, from: 0, to: dur }];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const seg = dur / lines.length;
  return lines.map((text, i) => ({ text, from: i * seg, to: (i + 1) * seg }));
}

function captionAt(c, local, dur) {
  const segs = captionSegments(c, dur);
  const seg = segs.find((g) => local < g.to) || segs[segs.length - 1];
  return seg ? { text: seg.text, t: local - seg.from } : null;
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

/* ---------------- 클립 만들기 ---------------- */

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

// 저장/복제용으로 클립의 데이터만 뽑는다 (재생용 객체 제외)
function serializeClip(c) {
  const { type, name, file, duration, start, end, caption, captionMode, fit, volume, color } = c;
  return { type, name, file, duration, start, end, caption, captionMode, fit, volume, color };
}

async function makeClip(data) {
  const c = {
    caption: '', captionMode: 'all', fit: 'blur', volume: 1, ...data,
    id: nextId++, gain: null,
  };
  if (c.type === 'color') return c;

  c.url = URL.createObjectURL(c.file);
  try {
    c.el = c.type === 'image' ? await loadImage(c.url) : await loadVideo(c.url);
  } catch (err) {
    URL.revokeObjectURL(c.url);
    throw err;
  }
  if (c.type === 'video') {
    c.el.addEventListener('seeked', () => { if (!state.playing) render(); });
    c.length = isFinite(c.el.duration) ? c.el.duration : 10;
    if (c.start == null) c.start = 0;
    if (c.end == null) c.end = Math.min(c.length, 15);
  } else if (c.duration == null) {
    c.duration = 3;
  }
  return c;
}

function disposeClip(c) {
  if (c.type === 'video') c.el.pause();
  if (c.gain) c.gain.disconnect();
  if (c.url) URL.revokeObjectURL(c.url);
}

async function addFiles(files) {
  for (const file of files) {
    const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : null;
    if (!type) continue;
    try {
      state.clips.push(await makeClip({ type, name: file.name, file }));
    } catch (err) {
      alert(`"${file.name}" 파일을 열 수 없어요. 브라우저가 지원하지 않는 형식일 수 있어요.`);
    }
  }
  refresh();
}

function addTextSlide() {
  const palette = ['#ff3b5c', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#111827'];
  const count = state.clips.filter((c) => c.type === 'color').length;
  state.clips.push({
    id: nextId++, type: 'color', name: '텍스트 슬라이드',
    color: palette[count % palette.length],
    duration: 2.5, caption: '여기에 *문구*를 입력하세요', captionMode: 'all', fit: 'cover',
  });
  refresh();
}

async function duplicateClip(c) {
  const i = state.clips.indexOf(c);
  const copy = await makeClip(serializeClip(c));
  state.clips.splice(i + 1, 0, copy);
  refresh();
}

function removeClip(c) {
  const i = state.clips.indexOf(c);
  if (i < 0) return;
  state.clips.splice(i, 1);
  disposeClip(c);
  refresh();
}

function moveClipTo(c, to) {
  const from = state.clips.indexOf(c);
  if (from < 0) return;
  state.clips.splice(from, 1);
  if (from < to) to--;
  state.clips.splice(Math.max(0, Math.min(to, state.clips.length)), 0, c);
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

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

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
  if (c.type === 'image' && s.kenBurns) {
    // 클립마다 확대/축소 방향을 번갈아 준다
    const p = local / dur;
    scale *= c.id % 2 ? 1 + 0.1 * p : 1.1 - 0.1 * p;
  }
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(c.el, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function fontString(s, size) {
  const f = s.font;
  return `${f.weight} ${Math.round(size * (f.scale || 1))}px ${f.family}, "Noto Sans KR", sans-serif`;
}

// "*강조*" 표시를 글자 단위 정보로 바꾼다
function parseRich(text) {
  const out = [];
  let hl = false;
  for (const ch of text) {
    if (ch === '*') { hl = !hl; continue; }
    out.push({ ch, hl });
  }
  return out;
}

const plain = (chars) => chars.map((c) => c.ch).join('');
const measure = (chars) => ctx.measureText(plain(chars)).width;

// 한글처럼 띄어쓰기가 적은 문장도 폭에 맞게 줄바꿈한다
function wrapRich(text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = [];
    for (const c of parseRich(para)) {
      if (line.length && measure([...line, c]) > maxW) {
        let sp = -1;
        for (let k = line.length - 1; k > 0; k--) if (line[k].ch === ' ') { sp = k; break; }
        if (c.ch !== ' ' && sp > 0) {
          lines.push(line.slice(0, sp));
          line = [...line.slice(sp + 1), c];
        } else {
          lines.push(line);
          line = c.ch === ' ' ? [] : [c];
        }
      } else {
        line.push(c);
      }
    }
    lines.push(line);
  }
  return lines;
}

// 같은 색 글자끼리 묶는다
function runsOf(line) {
  const runs = [];
  for (const c of line) {
    const last = runs[runs.length - 1];
    if (last && last.hl === c.hl) last.text += c.ch;
    else runs.push({ text: c.ch, hl: c.hl });
  }
  return runs;
}

function drawText(text, s, { size, color, y, anchor, style, scale = 1, alpha = 1 }) {
  if (!text) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = fontString(s, size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const lines = wrapRich(text, W - 140);
  const lh = size * 1.3;
  const blockH = lh * lines.length;
  const top = anchor === 'top' ? y : anchor === 'bottom' ? y - blockH : y - blockH / 2;

  // 등장할 때 살짝 튀어나오는 효과
  const cy = top + blockH / 2;
  ctx.translate(W / 2, cy);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -cy);

  const widths = lines.map(measure);

  if (style === 'box') {
    const widest = Math.max(...widths);
    const pad = size * 0.4;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(W / 2 - widest / 2 - pad, top - pad * 0.6, widest + pad * 2, blockH + pad * 1.2, size * 0.3);
    ctx.fill();
  }
  if (style === 'plain') {
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = size * 0.25;
  }

  lines.forEach((line, i) => {
    const ly = top + lh * i + lh / 2;
    let x = W / 2 - widths[i] / 2;
    for (const run of runsOf(line)) {
      if (style === 'outline') {
        ctx.lineWidth = size * 0.18;
        ctx.strokeStyle = '#000';
        ctx.strokeText(run.text, x, ly);
      }
      ctx.fillStyle = run.hl ? s.highlightColor : color;
      ctx.fillText(run.text, x, ly);
      x += ctx.measureText(run.text).width;
    }
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
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);

// 클립 하나(화면 + 자막)를 그린다
function drawClipLayer(c, local, dur, s) {
  drawMedia(c, local, dur, s);
  const cap = captionAt(c, local, dur);
  if (!cap) return;
  const capY = { top: 420, middle: H / 2, bottom: H - 360 }[s.captionPos];
  const pop = Math.min(1, cap.t / 0.18);
  drawText(cap.text, s, {
    size: s.captionSize, color: s.captionColor, y: capY, anchor: s.captionPos,
    style: s.captionStyle, scale: 0.85 + 0.15 * pop, alpha: pop,
  });
}

function withTransform(scale, dx, alpha, draw) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(W / 2 + dx, H / 2);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -H / 2);
  draw();
  ctx.restore();
}

function drawTransition(type, p, drawPrev, drawNext) {
  switch (type) {
    case 'slide':
      withTransform(1, -W * p, 1, drawPrev);
      withTransform(1, W * (1 - p), 1, drawNext);
      break;
    case 'zoom':
      withTransform(1 + 0.3 * p, 0, 1, drawPrev);
      withTransform(1.25 - 0.25 * p, 0, p, drawNext);
      break;
    case 'flash': {
      (p < 0.5 ? drawPrev : drawNext)();
      ctx.fillStyle = `rgba(255,255,255,${1 - Math.abs(p - 0.5) * 2})`;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    default: // fade
      drawPrev();
      withTransform(1, 0, p, drawNext);
  }
}

function render() {
  const s = settings();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const total = totalDuration();
  const loc = locate(state.time);

  if (!loc) {
    ctx.fillStyle = '#555';
    ctx.font = `700 56px "Noto Sans KR", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('클립을 추가해 주세요', W / 2, H / 2);
    return;
  }

  const { clip, local, dur, index } = loc;
  const tl = transitionLen(index, s);

  if (tl > 0 && local < tl) {
    const prev = state.clips[index - 1];
    const pd = clipDur(prev);
    drawTransition(
      s.transition,
      ease(local / tl),
      () => drawClipLayer(prev, pd, pd, s),
      () => drawClipLayer(clip, local, dur, s),
    );
  } else {
    drawClipLayer(clip, local, dur, s);
  }

  // 상단 제목 (전체 영상 고정)
  if (s.titleText) {
    drawText(s.titleText, s, {
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
  if (!loc) return;

  // 전환 중 보이는 이전 영상 클립은 마지막 프레임에 둔다
  const prev = state.clips[loc.index - 1];
  if (prev?.type === 'video' && loc.local < TRANSITION && !state.playing) {
    const endT = prev.end - 0.05;
    if (Math.abs(prev.el.currentTime - endT) > 0.1) prev.el.currentTime = endT;
  }

  // 다음 영상 클립을 미리 시작 지점으로 이동해 끊김을 줄인다
  if (loc.dur - loc.local < 0.6) {
    const next = state.clips[loc.index + 1];
    if (next?.type === 'video' && next.el.paused && Math.abs(next.el.currentTime - next.start) > 0.05) {
      next.el.currentTime = next.start;
    }
  }

  if (loc.clip.type !== 'video') return;
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

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

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
  download(blob, `shortform-${stamp()}.${ext}`);
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
  for (const id of ['saveThumb', 'saveSrt', 'newProject']) $(id).disabled = on;
  const editor = document.querySelector('.editor');
  editor.style.pointerEvents = on ? 'none' : '';
  editor.style.opacity = on ? '0.5' : '';
  if (on) setExportProgress(0);
}

function setExportProgress(p) {
  $('exportBar').style.width = `${Math.round(p * 100)}%`;
  $('exportText').textContent = `녹화 중… ${Math.round(p * 100)}%`;
}

function saveThumbnail() {
  if (!state.clips.length) return alert('먼저 클립을 추가해 주세요.');
  if (state.playing) pause();
  render();
  canvas.toBlob((blob) => blob && download(blob, `thumbnail-${stamp()}.png`), 'image/png');
}

function srtTime(t) {
  const ms = Math.round(t * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function saveSrt() {
  const entries = [];
  let acc = 0;
  for (const c of state.clips) {
    const d = clipDur(c);
    for (const seg of captionSegments(c, d)) {
      entries.push(`${entries.length + 1}\n${srtTime(acc + seg.from)} --> ${srtTime(acc + seg.to)}\n${seg.text.replace(/\*/g, '')}\n`);
    }
    acc += d;
  }
  if (!entries.length) return alert('저장할 자막이 없어요.');
  download(new Blob([entries.join('\n')], { type: 'text/plain;charset=utf-8' }), `subtitles-${stamp()}.srt`);
}

/* ---------------- 자동 저장 (IndexedDB) ---------------- */

const DB_NAME = 'shortform-maker';
const STORE = 'project';
let restoring = false;
let saveTimer = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbRequest(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function setSaveStatus(text) {
  $('saveStatus').textContent = text;
}

function scheduleSave() {
  if (restoring) return;
  clearTimeout(saveTimer);
  setSaveStatus('저장 중…');
  saveTimer = setTimeout(saveProject, 800);
}

async function saveProject() {
  try {
    await dbRequest('readwrite', (store) => store.put({
      version: 1,
      settings: readSettingsRaw(),
      clips: state.clips.map(serializeClip),
      bgm: state.bgm ? { name: state.bgm.name, file: state.bgm.file } : null,
    }, 'current'));
    setSaveStatus('✓ 자동 저장됨');
  } catch (err) {
    setSaveStatus('⚠ 자동 저장 실패 (저장 공간 부족)');
  }
}

async function restoreProject() {
  let data;
  try {
    data = await dbRequest('readonly', (store) => store.get('current'));
  } catch (err) {
    return;
  }
  if (!data) return;

  restoring = true;
  try {
    applySettingsRaw(data.settings || {});
    for (const saved of data.clips || []) {
      try {
        state.clips.push(await makeClip(saved));
      } catch (err) {
        console.warn('클립 복원 실패', saved.name, err);
      }
    }
    if (data.bgm) setBgm(data.bgm.file, data.bgm.name);
    if (state.clips.length) setSaveStatus('이전 작업을 불러왔어요');
  } finally {
    restoring = false;
  }
}

function newProject() {
  if (state.clips.length && !confirm('지금 작업을 지우고 새로 시작할까요?')) return;
  pause();
  state.clips.forEach(disposeClip);
  state.clips = [];
  setBgm(null);
  applySettingsRaw(DEFAULT_SETTINGS);
  state.time = 0;
  $('exportStatus').hidden = true;
  refresh();
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

function labeled(label, input) {
  const wrap = document.createElement('label');
  wrap.textContent = label;
  wrap.appendChild(input);
  return wrap;
}

function numInput(label, value, { min = 0, max = 600, step = 0.1 } = {}, onChange) {
  const input = document.createElement('input');
  Object.assign(input, { type: 'number', min, max, step, value: +value.toFixed(2) });
  input.addEventListener('change', () => {
    const v = Math.min(max, Math.max(min, parseFloat(input.value) || min));
    input.value = +v.toFixed(2);
    onChange(v);
    update();
    scheduleSave();
  });
  return labeled(label, input);
}

function selectInput(label, options, value, onChange) {
  const sel = document.createElement('select');
  options.forEach(([v, t]) => sel.add(new Option(t, v, false, value === v)));
  sel.addEventListener('change', () => { onChange(sel.value); update(); scheduleSave(); });
  return labeled(label, sel);
}

let dragClip = null;

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function enableReorder(li, c) {
  const handle = li.querySelector('.handle');
  handle.addEventListener('pointerdown', () => { li.draggable = true; });
  handle.addEventListener('pointerup', () => { li.draggable = false; });

  li.addEventListener('dragstart', (e) => {
    dragClip = c;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(c.id));
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    li.draggable = false;
    li.classList.remove('dragging');
    dragClip = null;
    clearDropMarks();
  });
  li.addEventListener('dragover', (e) => {
    if (!dragClip) return;
    e.preventDefault();
    e.stopPropagation();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarks();
    if (dragClip !== c) li.classList.add(after ? 'drop-after' : 'drop-before');
  });
  li.addEventListener('drop', (e) => {
    if (!dragClip) return;
    e.preventDefault();
    e.stopPropagation();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const moving = dragClip;
    dragClip = null;
    clearDropMarks();
    if (moving !== c) moveClipTo(moving, state.clips.indexOf(c) + (after ? 1 : 0));
  });
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
  thumb.appendChild(badge);
  const refreshBadge = () => { badge.textContent = `${state.clips.indexOf(c) + 1} · ${clipDur(c).toFixed(1)}s`; };
  refreshBadge();
  thumb.addEventListener('click', () => seek(clipStartTime(state.clips.indexOf(c)) + 0.01));

  li.querySelector('.clip-name').textContent = c.name;

  const cap = li.querySelector('.caption');
  cap.value = c.caption;
  cap.addEventListener('input', () => {
    c.caption = cap.value;
    if (!state.playing) render();
    scheduleSave();
  });

  const opts = li.querySelector('.clip-opts');

  if (c.type === 'video') {
    opts.appendChild(numInput('시작(초)', c.start, { max: c.length, step: 0.1 }, (v) => {
      c.start = Math.min(v, c.end - 0.1); refreshBadge();
    }));
    opts.appendChild(numInput('끝(초)', c.end, { max: c.length, step: 0.1 }, (v) => {
      c.end = Math.max(v, c.start + 0.1); refreshBadge();
    }));
    const vol = document.createElement('input');
    Object.assign(vol, { type: 'range', min: 0, max: 1, step: 0.05, value: c.volume });
    vol.addEventListener('input', () => {
      c.volume = +vol.value;
      if (c.gain) c.gain.gain.value = c.volume;
      scheduleSave();
    });
    opts.appendChild(labeled('원본 소리', vol));
  } else {
    opts.appendChild(numInput('길이(초)', c.duration, { min: 0.5, max: 60, step: 0.5 }, (v) => {
      c.duration = v; refreshBadge();
    }));
  }

  if (c.type === 'color') {
    const color = document.createElement('input');
    Object.assign(color, { type: 'color', value: c.color });
    color.addEventListener('input', () => {
      c.color = color.value;
      thumb.style.background = c.color;
      if (!state.playing) render();
      scheduleSave();
    });
    opts.appendChild(labeled('배경색', color));
  } else {
    opts.appendChild(selectInput('화면 맞춤',
      [['blur', '흐린 배경'], ['cover', '꽉 채우기'], ['contain', '원본 비율']],
      c.fit, (v) => { c.fit = v; }));
  }

  opts.appendChild(selectInput('자막 표시',
    [['all', '한 번에'], ['lines', '한 줄씩 순서대로']],
    c.captionMode, (v) => { c.captionMode = v; }));

  li.querySelector('[data-act="up"]').addEventListener('click', () => moveClipTo(c, i - 1));
  li.querySelector('[data-act="down"]').addEventListener('click', () => moveClipTo(c, i + 2));
  li.querySelector('[data-act="dup"]').addEventListener('click', () => duplicateClip(c));
  li.querySelector('[data-act="remove"]').addEventListener('click', () => removeClip(c));
  enableReorder(li, c);
  return li;
}

// 클립 추가/삭제/순서 변경 시에만 목록을 다시 그린다 (입력 중 포커스 유지)
function refresh() {
  const list = $('clipList');
  list.replaceChildren(...state.clips.map(buildClipItem));
  $('emptyMsg').hidden = state.clips.length > 0;
  state.time = Math.min(state.time, totalDuration());
  update();
  scheduleSave();
}

function bindUI() {
  $('fileInput').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('addTextSlide').addEventListener('click', addTextSlide);
  $('newProject').addEventListener('click', newProject);

  $('playBtn').addEventListener('click', () => (state.playing ? pause() : play()));
  $('seek').addEventListener('input', (e) => seek(+e.target.value));
  $('exportBtn').addEventListener('click', startExport);
  $('cancelExport').addEventListener('click', cancelExport);
  $('saveThumb').addEventListener('click', saveThumbnail);
  $('saveSrt').addEventListener('click', saveSrt);

  // 전체 설정은 바뀌는 즉시 미리보기에 반영
  document.querySelectorAll('.settings input, .settings select').forEach((el) => {
    if (el.type === 'file') return;
    el.addEventListener('input', () => {
      if (!state.playing) render();
      scheduleSave();
    });
  });
  // 글꼴은 내려받은 뒤에 다시 그린다
  $('fontFamily').addEventListener('change', async () => {
    const s = settings();
    try { await document.fonts.load(fontString(s, 64), '가A'); } catch (err) { /* 기본 글꼴로 표시 */ }
    if (!state.playing) render();
  });

  $('bgmInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) setBgm(file);
  });
  $('bgmRemove').addEventListener('click', () => setBgm(null));

  // 화면 전체에 파일 드래그 앤 드롭 (클립 순서 끌기와 구분)
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    const audio = files.find((f) => f.type.startsWith('audio/'));
    if (audio) setBgm(audio);
    addFiles(files.filter((f) => !f.type.startsWith('audio/')));
  });

  // 단축키: Space 재생/일시정지, ←/→ 1초 이동 (Shift 는 5초)
  window.addEventListener('keydown', (e) => {
    if (state.export) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      state.playing ? pause() : play();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * (e.code === 'ArrowLeft' ? -1 : 1);
      seek(state.time + step);
    }
  });
}

function setBgm(file, name = file?.name) {
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
    state.bgm = { name: name || '배경음악', file, url, el, gain: null };
  }
  $('bgmName').textContent = state.bgm ? state.bgm.name : '없음';
  $('bgmRemove').hidden = !state.bgm;
  if (state.playing) syncBgm();
  scheduleSave();
}

async function boot() {
  bindUI();
  await restoreProject();
  restoring = true; // 첫 화면 그릴 때는 저장하지 않는다
  refresh();
  restoring = false;
  try { await document.fonts.load(fontString(settings(), 64), '가A'); } catch (err) { /* 무시 */ }
  render();
}

boot();

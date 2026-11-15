var WIN = GameGlobal;
var THREE = WIN.THREE;

/* ============================================================
 * 巴音布鲁克的干 —— game.core.js
 * 分层：工具 / 存储 / 音频 / 输入 / 渲染核心 / 天空 / 程序化贴图 / 赛道环境生成
 * 原则：不依赖浏览器专属 API（localStorage/RAF 均做兜底），便于 threejs-miniprogram 适配
 * ============================================================ */
'use strict';

/* ---------- 0. 全局命名空间与工具 ---------- */
// 色彩管理：r147 传统模式下 hex 色值被当线性色渲染，经 sRGB 输出后整体漂白偏粉。
// 关闭 legacy 模式后所有 setHex/材质色/雾色/实例色按 sRGB 自动转线性，写实色彩的关键开关。
if (THREE.ColorManagement) THREE.ColorManagement.legacyMode = false;

var G = WIN.G = {};                       // 游戏全局命名空间
G.CLAMP = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
G.LERP = function (a, b, t) { return a + (b - a) * t; };
G.RAND = function (a, b) { return a + Math.random() * (b - a); };
G.TAU = Math.PI * 2;
// 平滑阻尼（帧率无关）
G.DAMP = function (a, b, lambda, dt) { return G.LERP(a, b, 1 - Math.exp(-lambda * dt)); };
// 时间格式化：秒 -> "MM:SS.cc"
G.fmtTime = function (t) {
  if (t == null || !isFinite(t)) return '--:--.--';
  var m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c;
};
G.$ = function (id) { return document.getElementById(id); };

/* ---------- 0.5 兼容材质 ----------
 * 真机日志确认部分移动 GPU 上 MeshStandardMaterial/MeshPhysicalMaterial 片元着色器
 * 编译失败（整块发黑）。这里把它们降级为结构简单的 Lambert（保留颜色/贴图/自发光）。 */
G.Compat = {
  _cache: {},
  enabled: !!WIN.__FLAT_MAT,
  // 是否挂了自定义着色器（山脊赛道的地形/路面/岩石/水面全靠 onBeforeCompile 做多层混合，
  // 换成 Lambert 会丢掉全部贴图和法线，整片地形变成纯白）
  custom: function (m) {
    return !!m && (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ||
                   Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey'));
  },
  // force = true 时无视 enabled 与自定义标记，强制全部降级（着色器确实编译失败时的兜底）
  convert: function (root, force) {
    if ((!this.enabled && !force) || !root) return root;
    var self = this;
    root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var arr = Array.isArray(o.material);
      var mats = arr ? o.material : [o.material];
      var out = [];
      for (var i = 0; i < mats.length; i++) out.push(self._one(mats[i], force));
      o.material = arr ? out : out[0];
    });
    return root;
  },
  _one: function (m, force) {
    if (!m) return m;
    if (m.isMeshBasicMaterial || m.isShaderMaterial || m.isSpriteMaterial ||
        m.isLineBasicMaterial || m.isLineDashedMaterial || m.isPointsMaterial) return m;
    if (m.isMeshLambertMaterial) return m;
    if (!force && this.custom(m)) return m;
    if (this._cache[m.uuid]) return this._cache[m.uuid];
    var glass = m.transmission > 0;
    var lm = new THREE.MeshLambertMaterial({
      color: m.color ? m.color.clone() : 0xffffff,
      map: m.map || null,
      emissive: m.emissive ? m.emissive.clone() : 0x000000,
      emissiveMap: m.emissiveMap || null,
      transparent: !!m.transparent || glass,
      opacity: glass ? 0.45 : (m.opacity == null ? 1 : m.opacity),
      side: m.side,
      alphaTest: m.alphaTest || 0,
      vertexColors: !!m.vertexColors,
      depthWrite: glass ? false : (m.depthWrite !== false)
    });
    this._cache[m.uuid] = lm;
    return lm;
  }
};

// 简易确定噪声（值噪声 + fbm），用于地形/装饰，避免外部库
G.hash2 = function (x, y) {
  var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};
G.vnoise = function (x, y) {
  var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return G.LERP(G.LERP(G.hash2(xi, yi), G.hash2(xi + 1, yi), u),
                G.LERP(G.hash2(xi, yi + 1), G.hash2(xi + 1, yi + 1), u), v);
};
G.fbm = function (x, y, oct) {
  var a = 0.5, f = 1, s = 0;
  for (var i = 0; i < oct; i++) { s += a * G.vnoise(x * f, y * f); f *= 2.07; a *= 0.5; }
  return s;
};

/* ---------- 1. 安全存储（微信小游戏无 localStorage 时降级为内存） ---------- */
G.store = (function () {
  var mem = {}, ok = false;
  try { ok = !!WIN.localStorage; WIN.localStorage.setItem('__t', '1'); WIN.localStorage.removeItem('__t'); } catch (e) { ok = false; }
  return {
    get: function (k, d) {
      try { if (ok) { var v = WIN.localStorage.getItem(k); return v == null ? d : v; } } catch (e) {}
      return (k in mem) ? mem[k] : d;
    },
    set: function (k, v) {
      try { if (ok) { WIN.localStorage.setItem(k, String(v)); return; } } catch (e) {}
      mem[k] = String(v);
    }
  };
})();

/* ---------- 2. 音频：Web Audio 全程序化合成（展厅氛围 / 比赛 BGM / 引擎 / 胎啸 / 刹车 / 碰撞） ---------- */
G.AudioKit = function () {
  this.ctx = null; this.master = null; this.bgmGain = null; this.sfxGain = null;
  this.musicVol = G.CLAMP(parseFloat(G.store.get('apex_vol_music', '0.45')) || 0.45, 0, 1);
  this.sfxVol = G.CLAMP(parseFloat(G.store.get('apex_vol_sfx', '0.7')) || 0.7, 0, 1);
  this.windGain = null; this.screechGain = null;
  this.brakeGain = null; this.brakeHiGain = null; this.ambGain = null;
  this.windAmbGain = null;                        // 海港场景的持续风声

  this._started = false;
  this._scene = null; this._wantScene = 'showroom'; this._paused = false;
  this._musicTimer = null; this._musicStep = 0;
  this._failed = null; this._err = null; this._lastDriveMs = 0;
};
G.AudioKit.prototype = {
  // 必须由用户手势触发启动
  start: function () {
    if (this._started) return;
    // 小游戏运行时没有全局 AudioContext，必须用 wx.createWebAudioContext()（基础库 2.19.0+）
    var c = null;
    try {
      if (typeof wx !== 'undefined' && wx.createWebAudioContext) c = wx.createWebAudioContext();
    } catch (e) { c = null; }
    if (!c) {
      var AC = WIN.AudioContext || WIN.webkitAudioContext;
      if (AC) { try { c = new AC(); } catch (e2) { c = null; } }
    }
    if (!c) {
      this._failed = 'no-audio-context';
      try { if (WIN.__diag) WIN.__diag.audio = this._failed; } catch (e3) {}
      return;
    }
    this.ctx = c;
    this._started = true;
    // iOS 静音键会导致无声；该接口对 WebAudio 不一定生效，但调用无副作用
    try {
      if (typeof wx !== 'undefined' && wx.setInnerAudioOption) {
        wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true });
      }
    } catch (e) {}
    try { if (c.resume) c.resume(); } catch (e) {}

    var self = this;
    // 部分机型 WebAudio 实现不全，单个节点创建失败不能拖垮整条链路
    var guard = function (fn) {
      try { fn(); }
      catch (e) { self._err = String((e && e.message) || e); try { if (WIN.__diag) WIN.__diag.audioErr = self._err; } catch (x) {} }
    };

    guard(function () {
      self.master = c.createGain(); self.master.gain.value = 0.95; self.master.connect(c.destination);
      self.bgmGain = c.createGain(); self.bgmGain.gain.value = self.musicVol; self.bgmGain.connect(self.master);
      self.sfxGain = c.createGain(); self.sfxGain.gain.value = self.sfxVol; self.sfxGain.connect(self.master);
    });

    // 白噪声循环缓冲（风噪/胎啸/刹车/沙沙声共用源）
    guard(function () {
      var len = Math.floor(c.sampleRate * 2), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      self._noiseBuf = buf;
    });

    // --- 风噪 ---
    guard(function () {
      var wSrc = c.createBufferSource(); wSrc.buffer = self._noiseBuf; wSrc.loop = true;
      var wFil = c.createBiquadFilter(); wFil.type = 'lowpass'; wFil.frequency.value = 500;
      self.windGain = c.createGain(); self.windGain.gain.value = 0;
      wSrc.connect(wFil); wFil.connect(self.windGain); self.windGain.connect(self.sfxGain); wSrc.start();
    });

    // --- 胎啸（带通噪声） ---
    guard(function () {
      var sSrc = c.createBufferSource(); sSrc.buffer = self._noiseBuf; sSrc.loop = true;
      try { sSrc.playbackRate.value = 0.6; } catch (e) {}
      var sFil = c.createBiquadFilter(); sFil.type = 'bandpass'; sFil.frequency.value = 950; sFil.Q.value = 4;
      self.screechGain = c.createGain(); self.screechGain.gain.value = 0;
      sSrc.connect(sFil); sFil.connect(self.screechGain); self.screechGain.connect(self.sfxGain); sSrc.start();
    });

    // --- 刹车：低频摩擦 + 高频轻啸 ---
    guard(function () {
      var bSrc = c.createBufferSource(); bSrc.buffer = self._noiseBuf; bSrc.loop = true;
      try { bSrc.playbackRate.value = 0.5; } catch (e) {}
      var bFil = c.createBiquadFilter(); bFil.type = 'lowpass'; bFil.frequency.value = 260;
      self.brakeGain = c.createGain(); self.brakeGain.gain.value = 0;
      bSrc.connect(bFil); bFil.connect(self.brakeGain); self.brakeGain.connect(self.sfxGain); bSrc.start();

      var hSrc = c.createBufferSource(); hSrc.buffer = self._noiseBuf; hSrc.loop = true;
      try { hSrc.playbackRate.value = 0.8; } catch (e) {}
      var hFil = c.createBiquadFilter(); hFil.type = 'bandpass'; hFil.frequency.value = 1800; hFil.Q.value = 9;
      self.brakeHiGain = c.createGain(); self.brakeHiGain.gain.value = 0;
      hSrc.connect(hFil); hFil.connect(self.brakeHiGain); self.brakeHiGain.connect(self.sfxGain); hSrc.start();
    });

    // --- 展厅空气感 ---
    guard(function () {
      var aSrc = c.createBufferSource(); aSrc.buffer = self._noiseBuf; aSrc.loop = true;
      try { aSrc.playbackRate.value = 0.4; } catch (e) {}
      var aFil = c.createBiquadFilter(); aFil.type = 'lowpass'; aFil.frequency.value = 380;
      self.ambGain = c.createGain(); self.ambGain.gain.value = 0;
      aSrc.connect(aFil); aFil.connect(self.ambGain); self.ambGain.connect(self.bgmGain); aSrc.start();
    });

    // --- 海港风声（低沉风噪，音量在场景步进里缓慢起伏） ---
    guard(function () {
      var wSrc = c.createBufferSource(); wSrc.buffer = self._noiseBuf; wSrc.loop = true;
      try { wSrc.playbackRate.value = 0.35; } catch (e) {}
      var wFil = c.createBiquadFilter(); wFil.type = 'lowpass'; wFil.frequency.value = 480; wFil.Q.value = 0.6;
      self.windAmbGain = c.createGain(); self.windAmbGain.gain.value = 0;
      wSrc.connect(wFil); wFil.connect(self.windAmbGain); self.windAmbGain.connect(self.bgmGain); wSrc.start();
    });

    this._switchScene(this._wantScene);
  },
  // AudioParam 平滑：微信 WebAudio 在部分机型上 setTargetAtTime 无效，统一改用 ramp
  _set: function (p, v, dur) {
    if (!p) return;
    var t = (this.ctx && this.ctx.currentTime) || 0, d = dur || 0.08;
    try {
      if (p.cancelScheduledValues) p.cancelScheduledValues(t);
      p.linearRampToValueAtTime(v, t + d);
    } catch (e) { try { p.value = v; } catch (e2) {} }
  },
  // 场景：showroom / harbor / race；paused 时背景音乐自动压低
  setScene: function (name, paused) {
    var np = !!paused, nm = name || null;
    if (this._started && this._wantScene === nm && this._paused === np) return;
    this._wantScene = nm;
    this._paused = np;
    if (!this._started) return;
    this._switchScene(this._wantScene);
    this._set(this.bgmGain && this.bgmGain.gain, this.musicVol * (this._paused ? 0.35 : 1), 0.2);
  },
  _switchScene: function (name) {
    if (!this._started) return;
    if (this._scene === name) return;
    this._scene = name;
    this._musicStep = 0;
    if (this._musicTimer) { clearTimeout(this._musicTimer); this._musicTimer = null; }
    this._set(this.ambGain && this.ambGain.gain, name === 'showroom' ? 0.014 : 0, 0.3);
    this._set(this.windAmbGain && this.windAmbGain.gain, name === 'harbor' ? 0.04 : 0, name === 'harbor' ? 0.9 : 0.4);
    if (!name) return;
    this._musicTick();
  },
  // 轻量 BGM：展厅氛围和弦 / 海港风声与海浪 / 通用比赛脉冲
  _musicTick: function () {
    if (!this._started || !this._scene) return;
    var scene = this._scene, show = scene === 'showroom', harbor = scene === 'harbor';
    var stepDur = harbor ? 0.5 : (show ? 60 / 68 / 2 : 60 / 118 / 2);
    // 单步失败不能中断整条 BGM 定时链
    try {
      var c = this.ctx, t = c.currentTime + 0.06, step = this._musicStep++;
      if (show) {
        if (step % 8 === 0) {
          var chords = [[220, 261.63, 329.63, 392], [174.61, 220, 261.63, 329.63], [196, 246.94, 293.66, 392], [164.81, 207.65, 246.94, 329.63]];
          var ch = chords[((step / 8) | 0) % 4];
          for (var i = 0; i < ch.length; i++) this._note(ch[i], t, 4.2, 0.016, 'sine', 1100);
          this._note(ch[0] / 2, t, 3.6, 0.026, 'triangle', 500);
        }
      } else if (harbor) {
        // 海风：每 0.5s 缓慢起伏；海浪：约每 6s 一次（错开位置避免机械感）
        this._set(this.windAmbGain && this.windAmbGain.gain,
          0.030 + 0.022 * (0.5 + 0.5 * Math.sin(step * 0.085)), 0.45);
        if (step % 12 === 3) this._wave(t);
      } else {
        if (step % 2 === 0) this._note(55, t, 0.18, 0.045, 'sawtooth', 220);
        if (step % 4 === 0) this._kick(t, 0.055);
        if (step % 2 === 1) this._hat(t, 0.01);
        if (step % 16 === 0) {
          var pad = [110, 130.81, 164.81];
          for (var j = 0; j < pad.length; j++) this._note(pad[j], t, 3.6, 0.01, 'triangle', 900);
        }
      }
    } catch (e) { this._err = String((e && e.message) || e); }
    this._musicTimer = setTimeout(this._musicTick.bind(this), stepDur * 1000);
  },
  // 海浪：带通噪声由远及近再退去 + 低频浪涌
  _wave: function (t) {
    if (!this.bgmGain || !this._noiseBuf) return;
    var c = this.ctx;
    var src = c.createBufferSource(); src.buffer = this._noiseBuf; src.loop = true;
    try { src.playbackRate.value = 0.55 + Math.random() * 0.15; } catch (e) {}
    var f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(460, t);
    f.frequency.linearRampToValueAtTime(1020, t + 0.9);
    f.frequency.linearRampToValueAtTime(360, t + 2.9);
    var g = c.createGain();
    var vol = 0.085 + Math.random() * 0.045;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.85);
    g.gain.linearRampToValueAtTime(0.0001, t + 3.0);
    src.connect(f); f.connect(g); g.connect(this.bgmGain);
    src.start(t); src.stop(t + 3.05);

    var o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(74, t);
    o.frequency.linearRampToValueAtTime(52, t + 2.4);
    var og = c.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.042, t + 0.9);
    og.gain.linearRampToValueAtTime(0.0001, t + 2.7);
    o.connect(og); og.connect(this.bgmGain); o.start(t); o.stop(t + 2.75);
  },
  _note: function (freq, t, dur, vol, type, cut) {
    if (!this.bgmGain) return;
    var c = this.ctx, o = c.createOscillator();
    o.type = type || 'sine'; o.frequency.value = freq;
    var f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cut || 1200;
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f); f.connect(g); g.connect(this.bgmGain);
    o.start(t); o.stop(t + dur + 0.05);
  },
  _kick: function (t, vol) {
    if (!this.bgmGain) return;
    var c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g); g.connect(this.bgmGain); o.start(t); o.stop(t + 0.24);
  },
  _hat: function (t, vol) {
    if (!this.bgmGain || !this._noiseBuf) return;
    var c = this.ctx, s = c.createBufferSource(); s.buffer = this._noiseBuf;
    var f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    var g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    s.connect(f); f.connect(g); g.connect(this.bgmGain); s.start(t); s.stop(t + 0.08);
  },
  setMusicVolume: function (v) {
    this.musicVol = G.CLAMP(v, 0, 1);
    G.store.set('apex_vol_music', this.musicVol);
    this._set(this.bgmGain && this.bgmGain.gain, this.musicVol * (this._paused ? 0.35 : 1), 0.1);
  },
  setSfxVolume: function (v) {
    this.sfxVol = G.CLAMP(v, 0, 1);
    G.store.set('apex_vol_sfx', this.sfxVol);
    this._set(this.sfxGain && this.sfxGain.gain, this.sfxVol, 0.1);
  },
  resume: function () {
    if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
    // 上下文被系统挂起（切后台/来电）后恢复时，重新拉起 BGM 定时链
    if (this._started && this._scene && !this._musicTimer) this._musicTick();
  },
  // 每帧更新行驶音效（brake：0~1 刹车力度）。rpm 参数保留但不再驱动引擎声
  drive: function (rpm, throttle, speed01, slip, brake, dt) {
    if (!this._started || !this.ctx) return;
    // 60fps 逐帧重排 AudioParam 在低端机会压垮音频线程，限到 20Hz 足够平滑
    var ms = Date.now();
    if (ms - this._lastDriveMs < 50) return;
    this._lastDriveMs = ms;
    this._set(this.windGain && this.windGain.gain, speed01 * speed01 * 0.08, 0.15);
    this._set(this.screechGain && this.screechGain.gain, G.CLAMP(slip, 0, 1) * 0.22, 0.05);
    var b = G.CLAMP(brake || 0, 0, 1) * Math.min(1, speed01 * 4);
    this._set(this.brakeGain && this.brakeGain.gain, b * 0.075, 0.06);
    this._set(this.brakeHiGain && this.brakeHiGain.gain, b * Math.max(0, 1 - speed01 * 0.6) * 0.02, 0.06);
  },
  mute: function () {
    if (!this._started) return;
    this._set(this.windGain && this.windGain.gain, 0, 0.05);
    this._set(this.screechGain && this.screechGain.gain, 0, 0.05);
    this._set(this.brakeGain && this.brakeGain.gain, 0, 0.05);
    this._set(this.brakeHiGain && this.brakeHiGain.gain, 0, 0.05);
    this._set(this.windAmbGain && this.windAmbGain.gain, 0, 0.05);
  },
  // 一次性音效：碰撞闷响
  thud: function (power) {
    if (!this._started || !this._noiseBuf || !this.sfxGain) return;
    var c = this.ctx, t = c.currentTime, p = G.CLAMP(power || 1, 0.2, 1.6);
    var src = c.createBufferSource(); src.buffer = this._noiseBuf;
    var f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 240;
    var g = c.createGain(); g.gain.setValueAtTime(0.5 * p, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    src.connect(f); f.connect(g); g.connect(this.sfxGain); src.start(t); src.stop(t + 0.3);
    var o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.22);
    var og = c.createGain(); og.gain.setValueAtTime(0.4 * p, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(og); og.connect(this.sfxGain); o.start(t); o.stop(t + 0.26);
  },
  // 提示音：count / chime / click
  beep: function (freq, dur, vol, type) {
    if (!this._started || !this.sfxGain) return;
    var c = this.ctx, t = c.currentTime;
    var o = c.createOscillator(); o.type = type || 'sine'; o.frequency.value = freq;
    var g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol || 0.25, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfxGain); o.start(t); o.stop(t + dur + 0.02);
  },
  lapChime: function () { this.beep(880, 0.14, 0.25); setTimeout(function () { this.beep(1318, 0.22, 0.25); }.bind(this), 130); },
  click: function () { this.beep(660, 0.06, 0.12, 'square'); },
  countBeep: function (final) { this.beep(final ? 1046 : 587, final ? 0.5 : 0.16, 0.3, final ? 'sine' : 'square'); }
};

/* ---------- 3. 输入：小游戏触屏按键 + 展厅拖拽（统一抽象） ---------- */
G.Input = function () {
  this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = false;
  this.pauseTap = false; this.restartTap = false;
  this._touch = { gas: false, brake: false, left: false, right: false, drift: false };
  this.dragDX = 0; this.dragging = false;        // 展厅拖拽
  this._touchCb = null;
};
G.Input.prototype = {
  // UI 层按下的虚拟按键
  press: function (key, on) { if (key in this._touch) this._touch[key] = !!on; },
  releaseAll: function () { for (var k in this._touch) this._touch[k] = false; this.dragging = false; },
  // 展厅拖拽增量（由 UI 层触屏事件写入）
  drag: function (dx) { this.dragDX += dx; },
  onFirstTouch: function (cb) { this._touchCb = cb; },
  notifyTouch: function () { if (this._touchCb) { this._touchCb(); this._touchCb = null; } },
  // 每帧汇总驾驶输入；dt 用于转向平滑
  sample: function (dt) {
    var t = this._touch;
    // 自动油门：不用一直按，踩刹车时自动收油
    var thr = t.brake ? 0 : 1;
    var brk = t.brake ? 1 : 0;
    var l = t.left ? 1 : 0;
    var r = t.right ? 1 : 0;
    var hb = !!t.drift;
    // 转向平滑（按键是 0/1，做渐变让操控有质感）
    var target = r - l;
    this.steer = G.DAMP(this.steer, target, 9, dt);
    if (Math.abs(this.steer) < 0.01) this.steer = 0;
    this.throttle = thr; this.brake = brk; this.handbrake = hb;
    return this;
  },
  consumePause: function () { var v = this.pauseTap; this.pauseTap = false; return v; },
  consumeRestart: function () { var v = this.restartTap; this.restartTap = false; return v; }
};

/* ---------- 4. 画质管理（低/中/高：影响分辨率、阴影、Bloom） ---------- */
G.Quality = {
  level: G.store.get('apex9_q', null),
  // 首次运行按设备定档：触屏/核显 -> 中，独显桌面 -> 高
  detect: function (gl) {
    if (!this.level) {
      // 小游戏运行在移动端，统一按中画质起步（可在暂停面板切换）
      this.level = 'mid';
    }
    return this.level;
  },
  conf: function () {
    var m = {
      low:  { dpr: 1,   shadow: 1024, bloom: false, bloomRes: 0.25, msaa: 0, probe: false, taps: 1 },
      mid:  { dpr: 1.25, shadow: 2048, bloom: true,  bloomRes: 0.5, msaa: 2, probe: false, taps: 4 },
      high: { dpr: 1.5, shadow: 4096, bloom: true,  bloomRes: 0.5, msaa: 4, probe: true,  taps: 8 }
    };
    return m[this.level] || m.high;
  }
};

/* ---------- 5. 渲染核心：HDR 线性管线 + 最终调色 Pass ----------
 * 关键：场景以 HalfFloat 渲染目标保存线性 HDR（太阳/灯光可远超 1.0），
 * Bloom 作用在 HDR 上，最后一个 Pass 才做曝光 + ACES 色调映射 + 调色 + sRGB 输出。 */
G.SUN_DIR = new THREE.Vector3(-0.70, 0.28, -0.66).normalize();   // 傍晚 16° 低角度阳光（西南）
// 大气透视：FogExp2 的 density 取负值时启用“高度指数雾 + 朝太阳方向的米氏内散射”（解析积分，逐像素），
// 正值仍是原版雾，海港图不受影响。山脊拉力图依赖这套高度雾来还原山谷空气感。
G.installAtmosphere = function () {
  var S = G.SUN_DIR, f = function (x) { return x.toFixed(4); };
  var C = THREE.ShaderChunk;
  C.fog_pars_vertex = '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogW;\n#endif';
  C.fog_vertex = ['#ifdef USE_FOG', '\tvFogDepth = - mvPosition.z;',
    '\t{ mat3 fR = mat3( viewMatrix ); vec3 fv = mvPosition.xyz - viewMatrix[3].xyz;',
    '\t  vFogW = vec3( dot( fR[0], fv ), dot( fR[1], fv ), dot( fR[2], fv ) ); }', '#endif'].join('\n');
  C.fog_pars_fragment = ['#ifdef USE_FOG', '\tuniform vec3 fogColor;', '\tvarying float vFogDepth;', '\tvarying vec3 vFogW;',
    '\t#ifdef FOG_EXP2', '\t\tuniform float fogDensity;', '\t#else', '\t\tuniform float fogNear;', '\t\tuniform float fogFar;', '\t#endif', '#endif'].join('\n');
  C.fog_fragment = ['#ifdef USE_FOG', '\t#ifdef FOG_EXP2',
    '\tif ( fogDensity < 0.0 ) {',
    '\t\tvec3 fr = vFogW - cameraPosition; float fd = max( length( fr ), 1e-3 ); vec3 fdir = fr / fd;',
    '\t\tfloat dens = - fogDensity, Hs = 160.0;',
    '\t\tfloat kk = clamp( fdir.y * fd / Hs, -20.0, 20.0 );',
    '\t\tfloat base = dens * exp( - ( cameraPosition.y - 40.0 ) / Hs );',
    '\t\tfloat tau = base * fd * ( abs( kk ) > 1e-3 ? ( 1.0 - exp( - kk ) ) / kk : 1.0 ) + dens * 0.15 * fd;',
    '\t\tfloat tr = exp( - tau );',
    '\t\tfloat mu = max( dot( fdir, vec3( ' + f(S.x) + ', ' + f(S.y) + ', ' + f(S.z) + ' ) ), 0.0 );',
    '\t\tvec3 inC = fogColor * ( 0.9 + 0.25 * clamp( fdir.y * 4.0, -1.0, 1.0 ) ) + vec3( 1.25, 0.72, 0.36 ) * ( pow( mu, 5.0 ) * 0.55 + pow( mu, 32.0 ) * 0.7 );',
    '\t\tgl_FragColor.rgb = mix( inC, gl_FragColor.rgb, tr );',
    // 体积光：沿视线在太阳阴影贴图里步进，树冠缝隙间的受光空气产生光柱
    '\t\t#if defined( ATMO_SH ) && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0 && ! defined( ATMO_NORAYS )',
    '\t\t{ float Lr = min( fd, 90.0 ), jit = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ), lit = 0.0;',
    '\t\t  for ( int i = 0; i < 6; i ++ ) { vec3 rp = cameraPosition + fdir * ( Lr * ( float( i ) + jit ) / 6.0 );',
    '\t\t    vec4 sc = directionalShadowMatrix[ 0 ] * vec4( rp, 1.0 );',
    '\t\t    if ( sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0 ) lit += step( sc.z, unpackRGBAToDepth( texture2D( directionalShadowMap[ 0 ], sc.xy ) ) + 0.0015 ); else lit += 1.0; }',
    '\t\t  lit /= 6.0;',
    '\t\t  float ph = 0.06 + 0.45 * mu * mu + 1.6 * pow( mu, 10.0 );',
    '\t\t  gl_FragColor.rgb += vec3( 1.3, 0.98, 0.66 ) * ph * lit * ( 1.0 - exp( - Lr * 0.006 ) ) * 0.08; }',
    '\t\t#endif',
    '\t} else {',
    '\t\tfloat fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
    '\t\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
    '\t}',
    '\t#else',
    '\tfloat fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
    '\tgl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
    '\t#endif', '#endif'].join('\n');
  C.shadowmap_pars_fragment = ['#define ATMO_SH 1', '#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0',
    'uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];', '#endif', C.shadowmap_pars_fragment].join('\n');
};
G.installAtmosphere();
G.GradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uExposure: { value: 0.95 }, uTime: { value: 0 }, uSpeed: { value: 0 },
    uVig: { value: 0.3 }, uCA: { value: 0.0016 }, uGrain: { value: 0.018 }, uSat: { value: 1.02 },
    uContrast: { value: 1.05 }, uAspect: { value: 1.0 }
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse; uniform float uExposure, uTime, uSpeed, uVig, uCA, uGrain, uSat, uContrast, uAspect;',
    'varying vec2 vUv;',
    'vec3 aces(vec3 x){',
    '  const mat3 I = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);',
    '  const mat3 O = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);',
    '  x = I * x; vec3 a = x * (x + 0.0245786) - 0.000090537; vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;',
    '  return clamp(O * (a / b), 0.0, 1.0);',
    '}',
    'vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }',
    'void main(){',
    '  vec2 d = vUv - 0.5; float r2 = dot(d, d);',
    // 径向速度模糊（只作用于画面外圈，中心车辆保持清晰）+ 边缘色差
    '  float bl = uSpeed * 0.055 * smoothstep(0.015, 0.22, r2);',
    '  vec2 ca = d * uCA * (0.4 + r2 * 4.0);',
    '  vec3 c = vec3(0.0);',
    '  for (int i = 0; i < TAPS; i++) {',
    '    float t = float(i) / max(float(TAPS) - 1.0, 1.0);',
    '    vec2 uv = 0.5 + d * (1.0 - bl * t);',
    '    c += vec3(texture2D(tDiffuse, uv + ca).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - ca).b);',
    '  }',
    '  c /= float(TAPS);',
    '  c = aces(c * uExposure / 0.6) * 0.985 + 0.01;',
    // 调色：饱和度、冷暗部/暖高光的分离色调、S 曲线对比
    '  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));',
    '  c = mix(vec3(l), c, uSat);',
    '  c *= mix(vec3(0.975, 0.995, 1.03), vec3(1.035, 1.0, 0.96), smoothstep(0.05, 0.75, l));',
    '  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);',
    '  float vg = length(d * vec2(uAspect, 1.0));',
    '  c *= mix(1.0, smoothstep(1.05, 0.25, vg), uVig);',
    '  c = toSRGB(c);',
    '  float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * vec2(117.3, 71.9), vec2(12.9898, 78.233))) * 43758.5453);',
    '  c += (n - 0.5) * uGrain;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n')
};
G.Render = function (canvas) {
  var q = G.Quality.conf();
  this.canvas = canvas;
  this.renderer = new THREE.WebGLRenderer({
    canvas: canvas, antialias: false, stencil: false, powerPreference: 'high-performance'
  });
  this.dpr = Math.min(WIN.devicePixelRatio || 1, q.dpr);
  this.renderer.setPixelRatio(this.dpr);
  this.renderer.setSize(WIN.innerWidth, WIN.innerHeight);
  this.renderer.outputEncoding = THREE.sRGBEncoding;
  this.renderer.toneMapping = THREE.NoToneMapping;     // 色调映射交给最终调色 Pass
  this.renderer.shadowMap.enabled = q.shadow > 0;
  this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  WIN.__diag.gl = this.renderer.capabilities.isWebGL2 ? 'GL2' : 'GL1';

  this.sunDir = G.SUN_DIR.clone();
  this.camera = new THREE.PerspectiveCamera(60, WIN.innerWidth / WIN.innerHeight, 0.25, 7000);
  this.camera.position.set(0, 4, -10);

  // 后处理：RenderPass(HDR) -> Bloom -> 调色（ACES + 暗角 + 色差 + 颗粒 + 速度模糊）
  this._safeBuildComposer(q);
  var self = this;
  WIN.addEventListener('resize', function () { self.onResize(); });
};
G.Render.prototype = {
  // 半浮点渲染目标可用性探测（部分移动 GPU / WebGL1 不完整，会导致后处理整屏变黑）
  _probeHalfFloat: function () {
    try {
      var gl = this.renderer.getContext();
      var rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType, samples: 0 });
      this.renderer.setRenderTarget(rt);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      this.renderer.setRenderTarget(null);
      rt.dispose();
      return ok;
    } catch (e) { return false; }
  },
  // 低端设备不支持浮点/半浮点渲染目标时回退为直出，避免整局黑屏
  _safeBuildComposer: function (q) {
    var caps = this.renderer.capabilities;
    this.hdr = caps.isWebGL2 && this._probeHalfFloat();
    if (!this.hdr) {
      this.composer = null; this.renderPass = null; this.bloom = null;
      this.fallbackRender = true;
      if (!this.grade || !this.grade.uniforms) {
        this.grade = { uniforms: { uSpeed: { value: 0 }, uTime: { value: 0 } } };
      }
      // 直出没有调色 Pass，必须在材质里补 ACES 色调映射，否则高光（石头/浅色地面/雪）整片过曝发白
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.95 / 0.6;
      WIN.__renderMode = caps.isWebGL2 ? 'direct-nohdr' : 'direct-webgl1';
      try { console.warn('[render] 后处理关闭（' + WIN.__renderMode + '），直接输出场景'); } catch (x) {}
      return;
    }
    try {
      this._buildComposer(q);
      this.fallbackRender = false;
      WIN.__renderMode = 'post';
    } catch (e) {
      this.composer = null; this.renderPass = null; this.bloom = null;
      this.fallbackRender = true;
      this.renderer.shadowMap.enabled = false;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.95 / 0.6;
      if (!this.grade || !this.grade.uniforms) {
        this.grade = { uniforms: { uSpeed: { value: 0 }, uTime: { value: 0 } } };
      }
      WIN.__renderMode = 'direct-postfail';
      try { console.warn('[render] 后处理不可用，回退直出：' + e.message); } catch (x) {}
    }
  },
  _buildComposer: function (q) {
    this.renderer.toneMapping = THREE.NoToneMapping;     // 色调映射交给最终调色 Pass
    var w = WIN.innerWidth, h = WIN.innerHeight;
    if (this.composer) { this.composer.renderTarget1.dispose(); this.composer.renderTarget2.dispose(); }
    var rt = new THREE.WebGLRenderTarget(Math.round(w * this.dpr), Math.round(h * this.dpr), {
      type: THREE.HalfFloatType, samples: this.renderer.capabilities.isWebGL2 ? q.msaa : 0
    });
    this.composer = new THREE.EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(w, h);
    this.renderPass = new THREE.RenderPass(this.renderPass ? this.renderPass.scene : new THREE.Scene(), this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new THREE.UnrealBloomPass(new THREE.Vector2(w * q.bloomRes, h * q.bloomRes), 0.22, 0.55, 2.2);
    this.bloom.enabled = q.bloom;
    this.composer.addPass(this.bloom);
    var old = this.grade;
    this.grade = new THREE.ShaderPass(G.GradeShader);
    this.grade.material.defines = { TAPS: q.taps };
    if (old) for (var k in old.uniforms) if (k !== 'tDiffuse') this.grade.uniforms[k].value = old.uniforms[k].value;
    this.grade.uniforms.uAspect.value = w / h;
    this.composer.addPass(this.grade);
  },
  onResize: function () {
    var w = WIN.innerWidth, h = WIN.innerHeight;
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer) this.composer.setSize(w, h);
    if (this.grade && this.grade.uniforms.uAspect) this.grade.uniforms.uAspect.value = w / h;
  },
  // 应用画质档（阴影贴图尺寸变化需重建灯光阴影映射；MSAA/采样数变化需重建合成器）
  applyQuality: function (level) {
    G.Quality.level = level; G.store.set('apex9_q', level);
    var q = G.Quality.conf();
    this.dpr = Math.min(WIN.devicePixelRatio || 1, q.dpr);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.shadowMap.enabled = q.shadow > 0;
    this._safeBuildComposer(q);
    if (this.sun) {
      this.sun.castShadow = q.shadow > 0;
      if (q.shadow > 0) {
        var ssz = WIN.__SHADOW_SIZE || q.shadow;
        this.sun.shadow.mapSize.set(ssz, ssz);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }
    this.onResize();
  },
  // 场景光照：太阳主光（环境光由天空 PMREM 提供，半球光仅作极弱补光）
  makeLights: function (scene) {
    var q = G.Quality.conf();
    var sun = new THREE.DirectionalLight(0xffd2a0, 3.0);
    sun.position.copy(this.sunDir).multiplyScalar(400);
    sun.castShadow = q.shadow > 0;
    var ssz2 = WIN.__SHADOW_SIZE || q.shadow || 1024;
    sun.shadow.mapSize.set(ssz2, ssz2);
    var sc = sun.shadow.camera;
    var ext = WIN.__SHADOW_SIZE ? 60 : 75;      // 真机缩小阴影相机，减少需要绘制的投影物体
    sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 150; sc.far = 760;
    sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.05;
    scene.add(sun); scene.add(sun.target);
    var hemi = new THREE.HemisphereLight(0xd6d6d2, 0x5a5146, 0.55);
    scene.add(hemi);
    this.sun = sun;
    return sun;
  },
  // 阴影相机跟随目标（按阴影贴图纹素对齐，避免移动时阴影边缘闪烁）
  followSun: function (target) {
    if (!this.sun) return;
    var s = this.sun;
    var ext = s.shadow.camera.right || 75;
    var snap = (ext * 2) / (s.shadow.mapSize.x || 2048);
    var tx = Math.round(target.x / snap) * snap, tz = Math.round(target.z / snap) * snap;
    s.target.position.set(tx, target.y, tz);
    s.position.set(tx, target.y, tz).addScaledVector(this.sunDir, 400);
    s.target.updateMatrixWorld();
  },
  // PMREM 环境贴图（用天空盒生成，供车漆 PBR 反射；远裁剪面需覆盖天空穹顶半径）
  bakeEnvironment: function (skyScene) {
    var pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(skyScene, 0.0, 1, 5000).texture;
    pmrem.dispose();
    return this.envMap;
  },
  // 运行期兜底：后处理启用约 3 秒后采样画面，若整屏仍为纯黑则永久切回直出
  _watchdog: function () {
    if (this._wdDone || WIN.__renderMode !== 'post') return;
    this._wdT = (this._wdT || 0) + 1;
    if (this._wdT < 180) return;
    this._wdDone = true;
    try {
      var gl = this.renderer.getContext();
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      var px = new Uint8Array(4), pts = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.72], [0.5, 0.28]], maxV = 0;
      for (var i = 0; i < pts.length; i++) {
        gl.readPixels(Math.floor(w * pts[i][0]), Math.floor(h * pts[i][1]), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        maxV = Math.max(maxV, px[0], px[1], px[2]);
      }
      if (maxV <= 3) {
        this.composer = null; this.renderPass = null; this.bloom = null;
        this.fallbackRender = true;
        this.grade = { uniforms: { uSpeed: { value: 0 }, uTime: { value: 0 } } };
        WIN.__renderMode = 'direct-autofallback';
      }
    } catch (e) {}
  },
  render: function (scene, camera) {
    if (!this.composer) { this.renderer.render(scene, camera); this._watchdog(); return; }
    this.renderPass.scene = scene; this.renderPass.camera = camera;
    this.composer.render();
    this._watchdog();
  }
};

/* ---------- 6. 天空：物理感大气渐变 + 体积感云层（fbm 域扭曲）+ 太阳光晕 ----------
 * 立方体 + gl_Position.xyww：深度恒为远平面，天空永远在最后方且跟随相机，无需巨大球体。
 * env=true 用于烘焙 PMREM：去掉太阳圆盘（直射光由平行光负责）并压制高光防止反射出现亮斑。 */
G.SKY_GLSL = [
  'uniform vec3 uSunDir; uniform float time, uEnv;',
  'varying vec3 vDir;',
  'float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
  'float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
  '  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + 1.0), f.x), f.y); }',
  'float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1; a *= 0.5; } return s; }',
  'vec3 horizonCol(vec3 d){',
  '  float az = clamp(dot(normalize(d.xz + 1e-5), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0);',
  '  vec3 away = vec3(0.50, 0.58, 0.70);',
  '  vec3 toward = vec3(1.55, 1.02, 0.62);',
  '  return mix(away, toward, pow(az, 2.6));',
  '}',
  'void main(){',
  '  vec3 d = normalize(vDir);',
  '  float mu = dot(d, uSunDir), s = max(mu, 0.0);',
  '  float y = d.y, hy = max(y, 0.0);',
  '  vec3 hor = horizonCol(d);',
  '  vec3 zen = vec3(0.24, 0.32, 0.47);',
  '  vec3 col = mix(hor, zen, pow(smoothstep(0.0, 0.75, hy), 0.5));',
  // Mie 前向散射光晕（多层 pow 叠加：宽晕 + 中晕 + 日冕）
  '  col += vec3(1.0, 0.72, 0.42) * (pow(s, 5.0) * 0.35 + pow(s, 40.0) * 0.9 + pow(s, 600.0) * 3.0);',
  // 云：投影到云平面（d.xz / y），fbm + 域扭曲，按太阳方向密度差估算自阴影
  '  if (y > 0.0) {',
  '    vec2 uv = d.xz / (y + 0.06) * 0.55 + time * vec2(0.0035, 0.0012);',
  '    vec2 w = vec2(fbm(uv * 0.35 + 3.1), fbm(uv * 0.35 + 9.7));',
  '    float n = fbm(uv * 0.75 + w * 1.6);',
  '    float cov = smoothstep(0.50, 0.74, n) * smoothstep(0.0, 0.08, y) * (0.55 + 0.45 * smoothstep(0.02, 0.3, y));',
  '    float nS = fbm((uv + normalize(uSunDir.xz + 1e-5) * 0.09) * 0.75 + w * 1.6);',
  '    float lit = clamp(0.45 + (n - nS) * 5.5, 0.0, 1.0);',
  '    float az = pow(clamp(dot(normalize(d.xz + 1e-5), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0), 3.0);',
  '    vec3 shade = mix(vec3(0.36, 0.38, 0.46), vec3(0.62, 0.48, 0.44), az);',
  '    vec3 sunlit = vec3(1.45, 1.02, 0.70) * (0.75 + 1.2 * az);',
  '    vec3 cc = mix(shade, sunlit, lit * lit);',
  '    cc += vec3(1.6, 1.1, 0.65) * pow(s, 10.0) * (1.0 - smoothstep(0.55, 0.9, n)) * 2.5;',   // 银边
  '    cc = mix(cc, hor * 0.95, exp(-y * 9.0) * 0.85);',                                        // 远云融入地平线雾
  '    col = mix(col, cc, cov * 0.92);',
  '  }',
  // 太阳圆盘（HDR，供 Bloom 拾取）
  '  col += vec3(1.0, 0.86, 0.62) * smoothstep(0.99975, 0.99988, mu) * 90.0 * (1.0 - uEnv);',
  // 地平线以下：海面/地面的漫反射近似（PMREM 下半球）
  '  if (y < 0.0) col = mix(hor * 0.85, vec3(0.13, 0.15, 0.16), smoothstep(0.0, 0.18, -y));',
  '  if (uEnv > 0.5) col = min(col, vec3(4.0));',
  '  gl_FragColor = vec4(col, 1.0);',
  '}'
].join('\n');
G.makeSky = function (renderer, env) {
  var mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    uniforms: { uSunDir: { value: renderer.sunDir.clone() }, time: { value: 0 }, uEnv: { value: env ? 1 : 0 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: G.SKY_GLSL
  });
  var mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  if (!env && G.waterMats) G.waterMats.push(mat);            // 每帧推进 time（云层漂移）
  return mesh;
};

/* ---------- 7. 程序化贴图工厂（Canvas 生成，零外部资源） ---------- */
G.Tex = {
  cache: {},
  _cv: function (w, h) {
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    return cv;
  },
  // 沥青路面：噪声底 + 两侧白实线 + 中央黄虚线（v 沿赛道方向平铺）
  road: function () {
    if (this.cache.road) return this.cache.road;
    var cv = this._cv(256, 256), g = cv.getContext('2d');
    g.fillStyle = '#27292d'; g.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 3400; i++) {
      var v = 26 + Math.random() * 30 | 0;
      g.fillStyle = 'rgba(' + v + ',' + v + ',' + (v + 3) + ',' + (Math.random() * 0.55) + ')';
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.6, 1.6);
    }
    // 轻微车辙磨亮（两条纵向亮带，弱化避免发白）
    var grd = g.createLinearGradient(0, 0, 256, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0.22)'); grd.addColorStop(0.28, 'rgba(255,255,255,0.025)');
    grd.addColorStop(0.5, 'rgba(0,0,0,0.14)'); grd.addColorStop(0.72, 'rgba(255,255,255,0.025)');
    grd.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
    // 边线（白，留 3% 边距）
    g.fillStyle = 'rgba(214,210,200,0.78)';
    g.fillRect(256 * 0.045, 0, 5, 256); g.fillRect(256 * 0.955 - 5, 0, 5, 256);
    // 中央黄虚线
    g.fillStyle = 'rgba(214,158,58,0.72)';
    for (var y = 0; y < 256; y += 64) g.fillRect(128 - 2.5, y, 5, 34);
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 8;
    tex.encoding = THREE.sRGBEncoding;             // 关键：画布色值是 sRGB，避免线性误读导致漂白
    this.cache.road = tex; return tex;
  },
  // 路缘石红白条纹（做旧）
  curb: function () {
    if (this.cache.curb) return this.cache.curb;
    var cv = this._cv(64, 64), g = cv.getContext('2d');
    g.fillStyle = '#9c3d2c'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#cfc9bd'; g.fillRect(0, 0, 64, 32);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 30, 64, 4);
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4;
    tex.encoding = THREE.sRGBEncoding;
    this.cache.curb = tex; return tex;
  },
  // 楼宇立面：窗格 + 随机亮灯（同时作 emissiveMap）
  building: function () {
    if (this.cache.building) return this.cache.building;
    var cv = this._cv(128, 256), g = cv.getContext('2d');
    g.fillStyle = '#181c21'; g.fillRect(0, 0, 128, 256);
    for (var y = 6; y < 250; y += 14) {
      for (var x = 6; x < 122; x += 12) {
        var lit = Math.random() < 0.38;
        g.fillStyle = lit ? (Math.random() < 0.6 ? 'rgba(255,190,112,0.9)' : 'rgba(168,192,235,0.72)') : 'rgba(24,29,35,0.95)';
        g.fillRect(x, y, 7, 8);
      }
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.encoding = THREE.sRGBEncoding;
    this.cache.building = tex; return tex;
  },
  // 起终点横幅
  banner: function () {
    if (this.cache.banner) return this.cache.banner;
    var cv = this._cv(512, 96), g = cv.getContext('2d');
    g.fillStyle = '#14181b'; g.fillRect(0, 0, 512, 96);
    g.strokeStyle = '#ffb347'; g.lineWidth = 4; g.strokeRect(6, 6, 500, 84);
    g.fillStyle = '#ffb347'; g.font = '900 52px PingFang SC, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = '12px';
    g.fillText('WILL GP', 256, 52);
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    this.cache.banner = tex; return tex;
  },
  // 起跑线黑白格
  checker: function () {
    if (this.cache.checker) return this.cache.checker;
    var cv = this._cv(128, 32), g = cv.getContext('2d');
    for (var y = 0; y < 2; y++) for (var x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#111417' : '#cfcabb';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    this.cache.checker = tex; return tex;
  },
  // 云朵（径向渐变透明贴图）
  cloud: function () {
    if (this.cache.cloud) return this.cache.cloud;
    var cv = this._cv(128, 128), g = cv.getContext('2d');
    var grd = g.createRadialGradient(64, 64, 8, 64, 64, 62);
    grd.addColorStop(0, 'rgba(255,235,215,0.85)'); grd.addColorStop(0.55, 'rgba(255,220,200,0.35)');
    grd.addColorStop(1, 'rgba(255,210,190,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    var tex = new THREE.CanvasTexture(cv);
    this.cache.cloud = tex; return tex;
  },
  // 问号牌（未上架车辆）
  question: function () {
    if (this.cache.question) return this.cache.question;
    var cv = this._cv(128, 128), g = cv.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0)'; g.clearRect(0, 0, 128, 128);
    g.strokeStyle = '#ffb347'; g.lineWidth = 5;
    g.font = '900 96px PingFang SC, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = 'rgba(255,179,71,0.9)'; g.shadowBlur = 18;
    g.strokeText('?', 64, 70);
    var tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    this.cache.question = tex; return tex;
  }
};

/* ---------- 8. 赛道定义（样条控制点 / 主题 / 环境参数） ---------- */
// 龟图式路径生成：L = 直道(米)，A = 圆弧(半径, 角度)，角度为正即航向角增大（朝赛道 RIGHT 基向转）；采样间距 step
G.turtle = function (sx, sz, h0Deg, ops, step) {
  var pts = [[sx, 0, sz]], x = sx, z = sz, h = h0Deg * Math.PI / 180;
  ops.forEach(function (op) {
    var k, n;
    if (op[0] === 'L') {
      n = Math.max(1, Math.round(op[1] / step));
      for (k = 1; k <= n; k++) { x += Math.sin(h) * op[1] / n; z += Math.cos(h) * op[1] / n; pts.push([x, 0, z]); }
    } else {
      var r = op[1], a = op[2] * Math.PI / 180, sg = a > 0 ? 1 : -1, cx = x + sg * r * Math.cos(h), cz = z - sg * r * Math.sin(h);
      n = Math.max(3, Math.ceil(Math.abs(a) * r / step));
      for (k = 1; k <= n; k++) { var hh = h + a * k / n; pts.push([cx - sg * r * Math.cos(hh), 0, cz + sg * r * Math.sin(hh)]); }
      h += a; x = pts[pts.length - 1][0]; z = pts[pts.length - 1][2];
    }
  });
  pts.pop();                                      // 终点 == 起点，去重
  return pts;
};
G.TRACKS = {
  mountain: {
    id: 'mountain', name: '山脊拉力', tag: 'MOUNTAIN RALLY',
    roadHalf: 5.4, laps: 2,
    // 山脊拉力（约 3.0km）：起点山脊 -> 悬崖 -> 峡谷大桥 -> 沙地高原（跳台）-> 下行发卡 -> 河谷涉水 -> 森林发卡爬坡回到山脊
    pts: G.turtle(-390, 290, 90, [
      ['L', 150], ['A', 110, -24], ['L', 30], ['A', 110, 24], ['L', 110], ['L', 100], ['L', 70],
      ['A', 70, 55], ['L', 70], ['A', 55, -45], ['L', 60], ['A', 60, 80],
      ['L', 90], ['A', 26, 180], ['L', 70], ['A', 26, -180], ['L', 110],
      ['A', 70, 60], ['L', 60], ['A', 50, 30], ['L', 150], ['L', 90],
      ['L', 70], ['A', 40, 90], ['L', 39.41], ['A', 24, -90],
      ['L', 110], ['A', 24, 180], ['L', 110], ['A', 24, -180], ['L', 110], ['A', 24, 180], ['L', 110], ['A', 24, -180], ['L', 238.59],
      ['A', 40, 90], ['A', 40, 90], ['L', 40]
    ], 3.5),
    curveType: 'centripetal', samples: 1650, ver: 'r3',
    theme: 'rally', pbrWorld: true,
    grade: { uExposure: 0.85, uContrast: 1.1, uSat: 0.98 },
    fog: [0x8594ad, -0.00022],                     // 负密度 = 高度雾 + 太阳方向内散射（buildMountainRally 内处理）
    treeCount: 0
  },
  city: {
    id: 'city', name: '滨海大道', tag: 'BAYFRONT CIRCUIT',
    roadHalf: 6.2, laps: 3,
    pts: [
      [0, 0, -250], [0, 0, -120], [-46, 0, -18], [-148, 1, 32], [-162, 2, 142],
      [-80, 1, 214], [34, 0, 236], [148, 1, 192], [186, 0, 92], [142, 0, -24],
      [58, 0, -62], [40, 0, -168]
    ],
    theme: 'city',
    bay: { x: 430, z: 40, w: 900, d: 1100 },      // 海湾水面
    fog: [0x7a5340, 260, 1500],
    treeCount: 40
  },
  harbor: {
    id: 'harbor', name: '海港岸线', tag: 'HARBOR STREET CIRCUIT',
    roadHalf: 6.4, laps: 3,
    // 集装箱码头街道赛（约 1.95km）：起跑直道贴着岸桥轨道，北侧 S 形发卡弯组（右发卡 + 左发卡），
    // 东侧长直道穿过人行天桥，南侧反向 S 形发卡弯组后回到起跑直道。赛道宽 12.8m，混凝土墙贴边。
    pts: G.turtle(-85, -100, 0, [
      ['L', 370], ['A', 50, 90], ['L', 40], ['A', 28, 180], ['L', 24], ['A', 28, -180], ['L', 150], ['A', 45, 90],
      ['L', 330], ['A', 45, 90], ['L', 40], ['A', 28, -180], ['L', 20], ['A', 28, 180], ['L', 151], ['A', 45, 90], ['L', 179]
    ], 3.5),
    curveType: 'centripetal', samples: 1300, ver: 'v2',
    theme: 'harbor', pbrWorld: true,
    fog: [0xa7a39c, 0.00042],                      // 指数雾：颜色 / 密度（大气透视）
    treeCount: 0
  }
};

/* ---------- 9. 赛道环境生成器 ----------
 * 输入：THREE 场景 + 赛道定义；输出 Track 对象（中心线采样、宽度、碰撞查询）
 * 结构：路面带 -> 路缘 -> 护栏 -> 地形 -> 山体/楼宇 -> 树木/路灯 -> 湖海 -> 云 -> 起终点门架
 * ============================================================ */
G.buildTrack = function (scene, def, renderer) {
  var T = { def: def, roadHalf: def.roadHalf };
  var i, j;
  G.waterMats.length = 0;
  scene.traverse(function (o) { if (o.material && o.material.uniforms && o.material.uniforms.time) G.waterMats.push(o.material); });

  // --- 9.1 中心线采样（均匀弧长） ---
  var cps = [];
  for (i = 0; i < def.pts.length; i++) {
    cps.push(new THREE.Vector3(def.pts[i][0], def.pts[i][1], def.pts[i][2]));
  }
  var curve = new THREE.CatmullRomCurve3(cps, true, def.curveType || 'catmullrom', 0.5);
  curve.arcLengthDivisions = 6000;
  var N = def.samples || 600;
  var raw = curve.getSpacedPoints(N);            // raw[N] == raw[0]（闭合）
  var P = [], TAN = [], RIGHT = [];
  var up = new THREE.Vector3(0, 1, 0);
  for (i = 0; i < N; i++) {
    P.push(raw[i].clone());
    var tan = raw[i + 1].clone().sub(raw[i]); tan.y = 0; tan.normalize();
    TAN.push(tan);
    RIGHT.push(new THREE.Vector3().crossVectors(up, tan).normalize()); // 右侧方向
  }
  T.P = P; T.TAN = TAN; T.RIGHT = RIGHT; T.N = N;
  T.totalLen = 0;
  for (i = 0; i < N; i++) T.totalLen += P[(i + 1) % N].distanceTo(P[i]);

  // 最近采样查询：从上次索引附近搜索（帧内代价 O(31)）
  T.nearest = function (pos, lastIdx) {
    var best = -1, bd = 1e9, from, to, k;
    if (lastIdx == null) { from = 0; to = N; } else { from = (lastIdx - 16 + N) % N; to = from + 33; }
    for (k = from; k < to; k++) {
      var idx = k % N, dx = pos.x - P[idx].x, dz = pos.z - P[idx].z;
      var d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = idx; }
    }
    return best;
  };
  // 横向偏移（右为正）
  T.lateral = function (pos, idx) {
    return (pos.x - P[idx].x) * RIGHT[idx].x + (pos.z - P[idx].z) * RIGHT[idx].z;
  };
  // 路面高度（含路拱轻微下落）
  T.heightAt = function (idx, frac) {
    var a = P[idx], b = P[(idx + 1) % N];
    return G.LERP(a.y, b.y, frac || 0);
  };
  if (def.theme === 'rally') return G.buildMountainRally(scene, def, T, renderer);
  if (def.theme === 'harbor') return G.buildHarborCircuit(scene, def, T, renderer);

  // --- 9.2 路面网格（沿中心线的三角带） ---
  var half = def.roadHalf;
  var verts = [], uvs = [], idxArr = [], dist = 0;
  for (i = 0; i <= N; i++) {
    var k2 = i % N, p = P[k2], r = RIGHT[k2];
    if (i > 0) dist += P[i % N].distanceTo(P[(i - 1) % N]);
    verts.push(p.x - r.x * half, p.y, p.z - r.z * half);
    verts.push(p.x + r.x * half, p.y, p.z + r.z * half);
    uvs.push(0, dist / 9, 1, dist / 9);          // 每 9m 平铺一周期（虚线节奏）
  }
  for (i = 0; i < N; i++) {
    var a2 = i * 2;
    idxArr.push(a2, a2 + 2, a2 + 1, a2 + 1, a2 + 2, a2 + 3);
  }
  var rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  rg.setIndex(idxArr);
  rg.computeVertexNormals();
  var roadMat = new THREE.MeshStandardMaterial({ map: G.Tex.road(), roughness: 0.92, metalness: 0 });
  roadMat.map = roadMat.map.clone(); roadMat.map.needsUpdate = true;
  roadMat.map.wrapS = roadMat.map.wrapT = THREE.RepeatWrapping;
  var road = new THREE.Mesh(rg, roadMat);
  road.receiveShadow = true;
  scene.add(road);

  // --- 9.3 路缘石（两侧红白条，微抬高） ---
  var curbMat = new THREE.MeshStandardMaterial({ map: G.Tex.curb(), roughness: 0.8 });
  curbMat.map = curbMat.map.clone(); curbMat.map.needsUpdate = true;
  curbMat.map.wrapS = curbMat.map.wrapT = THREE.RepeatWrapping;
  curbMat.map.repeat.set(1, 1);
  var mkCurb = function (side) {
    var cv2 = [], cu = [], ci = [], cd = 0;
    var wIn = 0.35, wOut = 0.95;
    for (var m = 0; m <= N; m++) {
      var k3 = m % N, p3 = P[k3], r3 = RIGHT[k3];
      if (m > 0) cd += P[m % N].distanceTo(P[(m - 1) % N]);
      var iIn = half + wIn, iOut = half + wOut;
      cv2.push(p3.x + r3.x * iIn * side, p3.y + 0.03, p3.z + r3.z * iIn * side,
               p3.x + r3.x * iOut * side, p3.y + 0.02, p3.z + r3.z * iOut * side);
      cu.push(0, cd / 4, 1, cd / 4);
    }
    for (var m2 = 0; m2 < N; m2++) {
      var a3 = m2 * 2;
      if (side > 0) ci.push(a3, a3 + 2, a3 + 1, a3 + 1, a3 + 2, a3 + 3);
      else ci.push(a3, a3 + 1, a3 + 2, a3 + 1, a3 + 3, a3 + 2);
    }
    var g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(cv2, 3));
    g2.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
    g2.setIndex(ci); g2.computeVertexNormals();
    var mesh = new THREE.Mesh(g2, curbMat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };
  mkCurb(1); mkCurb(-1);

  // --- 9.4 护栏（栏板 + 顶部琥珀反光条 + 立柱 InstancedMesh） ---
  var railH = 0.85, railOff = half + 1.5;
  var railMat = new THREE.MeshStandardMaterial({ color: 0x49525a, roughness: 0.55, metalness: 0.4, side: THREE.DoubleSide });
  var stripMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffb347, emissiveIntensity: 1.6, roughness: 0.6 });
  var mkRail = function (side) {
    var rv = [], ri = [], sv = [], si = [];
    for (var m = 0; m <= N; m++) {
      var k4 = m % N, p4 = P[k4], r4 = RIGHT[k4];
      var bx = p4.x + r4.x * railOff * side, bz = p4.z + r4.z * railOff * side;
      rv.push(bx, p4.y, bz, bx, p4.y + railH, bz);
      sv.push(bx, p4.y + railH, bz, bx, p4.y + railH + 0.1, bz);
    }
    for (var m2 = 0; m2 < N; m2++) {
      var a4 = m2 * 2;
      ri.push(a4, a4 + 1, a4 + 2, a4 + 1, a4 + 3, a4 + 2);
      si.push(a4, a4 + 1, a4 + 2, a4 + 1, a4 + 3, a4 + 2);
    }
    var g3 = new THREE.BufferGeometry();
    g3.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3));
    g3.setIndex(ri); g3.computeVertexNormals();
    var rail = new THREE.Mesh(g3, railMat); rail.castShadow = false; rail.receiveShadow = true;
    scene.add(rail);
    var g4 = new THREE.BufferGeometry();
    g4.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3));
    g4.setIndex(si); g4.computeVertexNormals();
    scene.add(new THREE.Mesh(g4, stripMat));
    // 立柱
    var postGeo = new THREE.BoxGeometry(0.14, railH + 0.25, 0.14);
    var postMat = new THREE.MeshStandardMaterial({ color: 0x5c666d, roughness: 0.6, metalness: 0.5 });
    var count = Math.floor(T.totalLen / 9);
    var posts = new THREE.InstancedMesh(postGeo, postMat, count * 1);
    var M4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s1 = new THREE.Vector3(1, 1, 1);
    var step = N / count;
    for (var c5 = 0; c5 < count; c5++) {
      var k5 = Math.floor(c5 * step) % N, p5 = P[k5], r5 = RIGHT[k5];
      q4.setFromAxisAngle(up, Math.atan2(TAN[k5].x, TAN[k5].z));
      M4.compose(new THREE.Vector3(p5.x + r5.x * railOff * side, p5.y + (railH + 0.25) / 2, p5.z + r5.z * railOff * side), q4, s1);
      posts.setMatrixAt(c5, M4);
    }
    posts.instanceMatrix.needsUpdate = true;
    scene.add(posts);
  };
  mkRail(1); mkRail(-1);
  T.railOff = railOff;                            // 碰撞用

  // --- 9.5 地形 / 海湾 / 远景 ---
  if (def.theme === 'mountain') G._mountainEnv(scene, def, T);
  else G._cityEnv(scene, def, T);

  // --- 9.6 云层（公告板，缓慢漂移） ---
  T.clouds = [];
  var cloudTex = G.Tex.cloud();
  for (i = 0; i < 10; i++) {
    var cm = new THREE.Mesh(
      new THREE.PlaneGeometry(G.RAND(160, 320), G.RAND(60, 110)),
      new THREE.MeshBasicMaterial({ map: cloudTex, transparent: true, opacity: G.RAND(0.24, 0.5), depthWrite: false, fog: false }));
    cm.position.set(G.RAND(-900, 900), G.RAND(190, 330), G.RAND(-900, 900));
    cm.lookAt(0, cm.position.y * 0.5, 0);
    cm.material.opacity *= 0.62;                   // 压低云量，避免卡通感
    scene.add(cm); T.clouds.push(cm);
  }

  // --- 9.7 起终点：格纹线 + 门架 ---
  var sp = P[0], sr = RIGHT[0], st = TAN[0];
  var lineGeo = new THREE.PlaneGeometry(half * 2, 2.4);
  var lineMesh = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({ map: G.Tex.checker(), roughness: 0.85 }));
  lineMesh.rotation.x = -Math.PI / 2;
  lineMesh.rotation.z = -Math.atan2(st.x, st.z);
  lineMesh.position.set(sp.x, sp.y + 0.02, sp.z);
  lineMesh.receiveShadow = true;
  scene.add(lineMesh);
  // 门架横梁 + 双柱
  var gateMat = new THREE.MeshStandardMaterial({ color: 0x22282d, roughness: 0.6, metalness: 0.4 });
  var beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 4, 1.1, 0.7), gateMat);
  var yaw0 = Math.atan2(st.x, st.z);
  beam.position.set(sp.x, sp.y + 6.2, sp.z);
  beam.rotation.y = yaw0 + Math.PI / 2;
  beam.castShadow = true;
  scene.add(beam);
  var ban = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 + 3.6, 0.95),
    new THREE.MeshBasicMaterial({ map: G.Tex.banner(), side: THREE.DoubleSide }));
  ban.position.set(sp.x, sp.y + 6.2, sp.z);
  ban.rotation.y = yaw0 + Math.PI / 2;
  scene.add(ban);
  var ban2 = ban.clone(); ban2.rotation.y += Math.PI; scene.add(ban2);
  var pil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6.4, 0.8), gateMat);
  pil.position.set(sp.x + sr.x * (half + 1.9), sp.y + 3.2, sp.z + sr.z * (half + 1.9));
  pil.castShadow = true; scene.add(pil);
  var pil2 = pil.clone(); pil2.position.set(sp.x - sr.x * (half + 1.9), sp.y + 3.2, sp.z - sr.z * (half + 1.9));
  scene.add(pil2);
  return T;
};

/* ----- 9.5a 山地主题环境：地形（随路面起伏压平）、湖、针叶林、远山 ----- */
G._mountainEnv = function (scene, def, T) {
  var i;
  var P = T.P, N = T.N, half = T.roadHalf;
  var cx = 0, cz = 0;
  for (i = 0; i < N; i++) { cx += P[i].x; cz += P[i].z; }
  cx /= N; cz /= N;
  var SIZE = 1700, SEG = 150;
  var roadY = function (x, z) {                  // 顶点附近路面高度（粗查全采样）
    var bd = 1e18, bi = 0;
    for (var k = 0; k < N; k += 3) {
      var dx = x - P[k].x, dz = z - P[k].z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = k; }
    }
    return { y: P[bi].y, d: Math.sqrt(bd) };
  };
  var lake = def.lake;
  var geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  var pos = geo.attributes.position;
  var colors = new Float32Array(pos.count * 3);
  var cGrass = new THREE.Color(0x4a5c38), cDirt = new THREE.Color(0x6b5a40),
      cRock = new THREE.Color(0x6f6a62), cSnow = new THREE.Color(0xd8d5cc);
  for (i = 0; i < pos.count; i++) {
    var x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
    var near = roadY(x, z);
    var n = G.fbm(x * 0.008 + 7, z * 0.008 + 3, 4);          // 基础起伏
    var ridge = Math.pow(G.fbm(x * 0.0035, z * 0.0035, 3), 1.6) * 90;
    var h = n * 26 + ridge;
    // 距路越近平整；路侧 60m 内与路高等高过渡
    var flat = G.CLAMP((near.d - half - 2) / 42, 0, 1);
    h = G.LERP(near.y - 0.4, h, flat * flat);
    // 湖盆下压
    if (lake) {
      var dl = Math.sqrt((x - lake.x) * (x - lake.x) + (z - lake.z) * (z - lake.z));
      if (dl < lake.r + 26) h = G.LERP(-2.6, h, G.CLAMP((dl - lake.r * 0.55) / (lake.r * 0.45 + 26), 0, 1));
    }
    pos.setX(i, x); pos.setZ(i, z); pos.setY(i, h);
    // 按高度/坡度混色：草地 -> 碎石 -> 岩 -> 雪线
    var t = G.CLAMP(h / 95, 0, 1);
    var c = cGrass.clone().lerp(cRock, G.CLAMP((t - 0.28) * 2.4, 0, 1));
    c.lerp(cSnow, G.CLAMP((h - 74) / 26, 0, 1));
    c.lerp(cDirt, G.CLAMP(1 - near.d / 26, 0, 1) * 0.55);     // 路边露土
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  var terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  terrain.receiveShadow = true;
  scene.add(terrain);
  T.terrainHeight = function (x, z) {
    var near = roadY(x, z);
    var n = G.fbm(x * 0.008 + 7, z * 0.008 + 3, 4);
    var ridge = Math.pow(G.fbm(x * 0.0035, z * 0.0035, 3), 1.6) * 90;
    var h = n * 26 + ridge;
    var flat = G.CLAMP((near.d - half - 2) / 42, 0, 1);
    h = G.LERP(near.y - 0.4, h, flat * flat);
    if (lake) {
      var dl = Math.sqrt((x - lake.x) * (x - lake.x) + (z - lake.z) * (z - lake.z));
      if (dl < lake.r + 26) h = G.LERP(-2.6, h, G.CLAMP((dl - lake.r * 0.55) / (lake.r * 0.45 + 26), 0, 1));
    }
    return h;
  };

  // 湖面（shader 水面）
  if (lake) scene.add(G._waterMesh(lake.x, -1.15, lake.r * 1.15, lake.r * 1.15, lake.z));
  // 远山环（岩石锥体 + 顶点色渐变）
  var mgeo = new THREE.ConeGeometry(1, 1, 7, 4);
  mgeo.translate(0, 0.5, 0);
  var mpos = mgeo.attributes.position, mcol = new Float32Array(mpos.count * 3);
  var mRock = new THREE.Color(0x5c5850), mSnow = new THREE.Color(0xcfc9bd);
  for (i = 0; i < mpos.count; i++) {
    var c2 = mRock.clone().lerp(mSnow, G.CLAMP((mpos.getY(i) - 0.55) * 2.2, 0, 1));
    mcol[i * 3] = c2.r; mcol[i * 3 + 1] = c2.g; mcol[i * 3 + 2] = c2.b;
  }
  mgeo.setAttribute('color', new THREE.BufferAttribute(mcol, 3));
  // 顶点噪声扰动：打破几何对称，消除卡通圆锥感
  var mp = mgeo.attributes.position;
  for (i = 0; i < mp.count; i++) {
    var vx = mp.getX(i), vy = mp.getY(i), vz = mp.getZ(i);
    var nn = G.fbm(vx * 2.3 + 11, vz * 2.3 + 7, 3) - 0.5;
    mp.setX(i, vx * (1 + nn * 0.5));
    mp.setZ(i, vz * (1 + nn * 0.5));
    mp.setY(i, vy * (0.92 + G.fbm(vx * 1.7, vz * 1.7, 2) * 0.2));
  }
  var mmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  var count2 = 14;
  var mountains = new THREE.InstancedMesh(mgeo, mmat, count2);
  var M = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3();
  for (i = 0; i < count2; i++) {
    var ang = (i / count2) * Math.PI * 2 + G.RAND(-0.2, 0.2);
    var dist = G.RAND(640, 860);
    var hh = G.RAND(150, 330), ww = G.RAND(190, 330);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), G.RAND(0, Math.PI * 2));
    M.compose(new THREE.Vector3(cx + Math.cos(ang) * dist, -30, cz + Math.sin(ang) * dist), q, sv.set(ww, hh, ww));
    mountains.setMatrixAt(i, M);
  }
  mountains.instanceMatrix.needsUpdate = true;
  scene.add(mountains);

  // 针叶林：树干 + 双层树冠（两组 InstancedMesh 共享矩阵）
  G._forest(scene, def, T, cx, cz, SIZE);
};

/* ----- 针叶林 ----- */
G._forest = function (scene, def, T, cx, cz, SIZE) {
  var tryN = def.treeCount, mats = [];
  var P = T.P, N = T.N, half = T.roadHalf, lake = def.lake;
  var placed = 0, guard = 0;
  while (placed < tryN && guard++ < tryN * 8) {
    var x = G.RAND(cx - SIZE / 2 + 30, cx + SIZE / 2 - 30);
    var z = G.RAND(cz - SIZE / 2 + 30, cz + SIZE / 2 - 30);
    var bd = 1e18;
    for (var k = 0; k < N; k += 2) {
      var dx = x - P[k].x, dz = z - P[k].z, d = dx * dx + dz * dz;
      if (d < bd) bd = d;
    }
    if (bd < (half + 8) * (half + 8)) continue;                 // 避让赛道
    if (lake) {
      var dl = Math.sqrt((x - lake.x) * (x - lake.x) + (z - lake.z) * (z - lake.z));
      if (dl < lake.r + 10) continue;                            // 避让湖面
    }
    var y = T.terrainHeight ? T.terrainHeight(x, z) : 0;
    if (y < -1.5 || y > 96) continue;                            // 不种水里/雪线以上
    mats.push([x, y, z, G.RAND(0.75, 1.6), G.RAND(0, Math.PI * 2)]);
    placed++;
  }
  var trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 2.4, 5);
  trunkGeo.translate(0, 1.2, 0);
  var leafGeo = new THREE.ConeGeometry(1.5, 4.6, 6);
  leafGeo.translate(0, 4.4, 0);
  var leaf2Geo = new THREE.ConeGeometry(1.05, 3.2, 6);
  leaf2Geo.translate(0, 6.6, 0);
  var trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
  var leafMat = new THREE.MeshStandardMaterial({ color: 0x2f4a2e, roughness: 1, flatShading: true });
  var nT = mats.length;
  var iTrunk = new THREE.InstancedMesh(trunkGeo, trunkMat, nT);
  var iLeaf = new THREE.InstancedMesh(leafGeo, leafMat, nT);
  var iLeaf2 = new THREE.InstancedMesh(leaf2Geo, leafMat, nT);
  var M = new THREE.Matrix4(), qq = new THREE.Quaternion(), sv = new THREE.Vector3(), eul = new THREE.Euler();
  for (var i = 0; i < nT; i++) {
    var m = mats[i];
    eul.set(0, m[4], 0); qq.setFromEuler(eul);
    sv.set(m[3], m[3] * G.RAND(0.9, 1.25), m[3]);
    M.compose(new THREE.Vector3(m[0], m[1] - 0.15, m[2]), qq, sv);
    iTrunk.setMatrixAt(i, M); iLeaf.setMatrixAt(i, M); iLeaf2.setMatrixAt(i, M);
  }
  iTrunk.instanceMatrix.needsUpdate = iLeaf.instanceMatrix.needsUpdate = iLeaf2.instanceMatrix.needsUpdate = true;
  iTrunk.castShadow = iLeaf.castShadow = true;
  scene.add(iTrunk); scene.add(iLeaf); scene.add(iLeaf2);
};

/* ----- 9.5b 城市主题环境：平地广场、楼宇群、路灯、海湾、远处天际线 ----- */
G._cityEnv = function (scene, def, T) {
  var i;
  var P = T.P, N = T.N, half = T.roadHalf;
  var cx = 0, cz = 0;
  for (i = 0; i < N; i++) { cx += P[i].x; cz += P[i].z; }
  cx /= N; cz /= N;
  // 广场地坪（暗色铺装 + 细噪声贴图）
  var cv = document.createElement('canvas'); cv.width = cv.height = 128;
  var g = cv.getContext('2d');
  g.fillStyle = '#282b2f'; g.fillRect(0, 0, 128, 128);
  for (var n2 = 0; n2 < 1100; n2++) {
    var vv = 30 + Math.random() * 22 | 0;
    g.fillStyle = 'rgba(' + vv + ',' + vv + ',' + vv + ',' + Math.random() * 0.4 + ')';
    g.fillRect(Math.random() * 128, Math.random() * 128, 1.4, 1.4);
  }
  var groundTex = new THREE.CanvasTexture(cv);
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping; groundTex.repeat.set(60, 60);
  groundTex.encoding = THREE.sRGBEncoding; groundTex.anisotropy = 4;
  var ground = new THREE.Mesh(new THREE.PlaneGeometry(1500, 1500),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95, color: 0xb9bcc0 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(cx, -0.05, cz);
  ground.receiveShadow = true;
  scene.add(ground);
  T.terrainHeight = function () { return 0; };

  // 海湾水面
  var bay = def.bay;
  scene.add(G._waterMesh(bay.x, -0.4, bay.w, bay.d, bay.z));

  // 楼宇群（InstancedMesh，贴图立面 + 自发光窗）
  var bTex = G.Tex.building();
  var bGeo = new THREE.BoxGeometry(1, 1, 1);
  bGeo.translate(0, 0.5, 0);
  var bMat = new THREE.MeshStandardMaterial({
    color: 0x333840, roughness: 0.75, metalness: 0.12,
    map: bTex, emissive: 0xffc887, emissiveMap: bTex, emissiveIntensity: 0.42
  });
  var bN = 110;
  var builds = new THREE.InstancedMesh(bGeo, bMat, bN);
  var M = new THREE.Matrix4(), qq = new THREE.Quaternion(), sv = new THREE.Vector3();
  var placed = 0, guard = 0;
  while (placed < bN && guard++ < bN * 10) {
    var ang = G.RAND(0, Math.PI * 2), dist = G.RAND(half + 16, 380);
    var x = cx + Math.cos(ang) * dist, z = cz + Math.sin(ang) * dist;
    // 避让海湾
    if (Math.abs(x - bay.x) < bay.w / 2 + 30 && Math.abs(z - bay.z) < bay.d / 2 + 30) continue;
    var bd = 1e18;
    for (var k = 0; k < N; k += 2) {
      var dx = x - P[k].x, dz = z - P[k].z, d = dx * dx + dz * dz;
      if (d < bd) bd = d;
    }
    if (bd < (half + 10) * (half + 10)) continue;
    var w = G.RAND(10, 26), h = G.RAND(14, 70) * (1 - dist / 700);
    eulSet(qq, 0, G.RAND(0, Math.PI), 0);
    M.compose(new THREE.Vector3(x, 0, z), qq, sv.set(w, Math.max(10, h), w));
    builds.setMatrixAt(placed++, M);
  }
  builds.count = placed;
  builds.instanceMatrix.needsUpdate = true;
  builds.castShadow = true;
  scene.add(builds);

  // 远处天际剪影（无光照深色盒，融入雾）
  var skyMat = new THREE.MeshBasicMaterial({ color: 0x35404e, fog: true });
  var sky2 = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), skyMat, 40);
  for (i = 0; i < 40; i++) {
    var a2 = (i / 40) * Math.PI * 2 + G.RAND(-0.1, 0.1);
    var d2 = G.RAND(620, 780);
    var w2 = G.RAND(30, 80), h2 = G.RAND(40, 150);
    eulSet(qq, 0, G.RAND(0, Math.PI), 0);
    M.compose(new THREE.Vector3(cx + Math.cos(a2) * d2, h2 / 2 - 4, cz + Math.sin(a2) * d2), qq, sv.set(w2, h2, w2));
    sky2.setMatrixAt(i, M);
  }
  sky2.instanceMatrix.needsUpdate = true;
  scene.add(sky2);

  // 路灯：灯杆 + 自发光灯头（沿路外侧，bloom 点缀）
  var poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 5.4, 5);
  poleGeo.translate(0, 2.7, 0);
  var poleMat = new THREE.MeshStandardMaterial({ color: 0x444c52, roughness: 0.6, metalness: 0.5 });
  var headGeo = new THREE.SphereGeometry(0.22, 8, 6);
  var headMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffd9a0, emissiveIntensity: 3.2 });
  var lampN = Math.floor(N / 14);
  var poles = new THREE.InstancedMesh(poleGeo, poleMat, lampN);
  var heads = new THREE.InstancedMesh(headGeo, headMat, lampN);
  for (i = 0; i < lampN; i++) {
    var k2 = (i * 14) % N, side = (i % 2) ? 1 : -1;
    var p2 = P[k2], r2 = T.RIGHT[k2];
    var lx = p2.x + r2.x * (half + 3.2) * side, lz = p2.z + r2.z * (half + 3.2) * side;
    M.compose(new THREE.Vector3(lx, p2.y, lz), qq.identity(), sv.set(1, 1, 1));
    poles.setMatrixAt(i, M);
    M.compose(new THREE.Vector3(lx, p2.y + 5.5, lz), qq.identity(), sv.set(1, 1, 1));
    heads.setMatrixAt(i, M);
  }
  poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
  poles.castShadow = true;
  scene.add(poles); scene.add(heads);

  // 城市少量行道树（圆冠）
  G._forest(scene, def, T, cx, cz, 700);
};
function eulSet(q, x, y, z) { q.setFromEuler(new THREE.Euler(x, y, z)); return q; }
/* 海港主题见 game.world.js（G.buildHarborCircuit：写实街道赛 + 集装箱码头） */

/* ----- 水面：PBR 标准材质 + 多层滚动法线（反射天空 PMREM，菲涅尔由 GGX 自然给出）
 * 参数：G._waterMesh(中心x, 水面y, 宽, 深, 中心z) ----- */
G.waterMats = [];                                 // 每帧需要推进 time 的材质（天空/水面）
G._waterMesh = function (x, y, w, d, z) {
  var nrm = G.PBR.waterNormal();
  var tile = 9;                                   // 法线贴图一个周期 9m
  var holder = { uniforms: { time: { value: 0 } } };
  var mat = new THREE.MeshStandardMaterial({
    color: 0x0b1c22, roughness: 0.04, metalness: 0.0, normalMap: nrm,
    normalScale: new THREE.Vector2(0.5, 0.5), envMapIntensity: 1.0
  });
  mat.onBeforeCompile = function (sh) {
    sh.uniforms.time = holder.uniforms.time;
    sh.fragmentShader = 'uniform float time;\n' + sh.fragmentShader.replace('#include <normal_fragment_maps>',
      THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vUv ).xyz * 2.0 - 1.0;', [
        // 三层不同尺度/方向滚动的法线叠加，远处逐渐减弱以避免高频闪烁
        'vec2 n1 = texture2D( normalMap, vUv + time * vec2( 0.021, 0.013 ) ).xy * 2.0 - 1.0;',
        'vec2 n2 = texture2D( normalMap, vUv * 0.29 + time * vec2( -0.008, 0.011 ) ).xy * 2.0 - 1.0;',
        'vec2 n3 = texture2D( normalMap, vUv * 2.7 + time * vec2( 0.034, -0.029 ) ).xy * 2.0 - 1.0;',
        'float fade = 1.0 - 0.7 * smoothstep( 30.0, 900.0, length( vViewPosition ) );',
        'vec3 mapN = vec3( ( n1 * 0.8 + n2 * 1.1 + n3 * 0.45 ) * fade, 1.0 );'
      ].join('\n')));
  };
  mat.customProgramCacheKey = function () { return 'apex-water'; };
  var geo = new THREE.PlaneGeometry(w, d, 1, 1);
  G.scaleUV(geo, w / tile, d / tile);
  var mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  G.waterMats.push(holder);
  return mesh;
};

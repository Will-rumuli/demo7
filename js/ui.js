/**
 * UI 层：用离屏 Canvas2D 重绘 demo10 的 HTML 界面，再作为全屏纹理叠加到 WebGL 画面之上。
 * 小游戏只有首个 canvas 是上屏画布，无法在 WebGL 画布上直接画 2D，所以采用纹理合成。
 */
var WIN = GameGlobal;
var THREE = WIN.THREE;
var G = WIN.G;

(function () {
  'use strict';

  var F_LABEL = '"PingFang SC","Microsoft YaHei",sans-serif';
  var F_NUM = '"DIN Alternate","Arial Narrow","PingFang SC",sans-serif';
  var C = {
    ink: '#04070b', ink2: '#0b1118', bone: '#e6f0f4',
    boneDim: 'rgba(214,232,240,.66)', boneFaint: 'rgba(214,232,240,.22)',
    signal: '#2de2ff', signalHot: '#8cf1ff', rust: '#ff7a2f', steel: '#7f98a6',
    alarm: '#ff4d6d', line: 'rgba(120,220,255,.22)',
    plate: 'rgba(5,12,18,.62)', plateSolid: 'rgba(5,11,17,.94)'
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  var S = { left: 0, top: 0, right: 0, bottom: 0 };
  function fmt(t) {
    if (t == null || !isFinite(t)) return '--:--.--';
    var m = Math.floor(t / 60), s = Math.floor(t % 60), c = Math.floor((t * 100) % 100);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (c < 10 ? '0' : '') + c;
  }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  // 斜切角面板（对应 CSS clip-path）
  function cutPath(g, x, y, w, h, c) {
    g.beginPath();
    g.moveTo(x, y); g.lineTo(x + w - c, y); g.lineTo(x + w, y + c);
    g.lineTo(x + w, y + h); g.lineTo(x + c, y + h); g.lineTo(x, y + h - c);
    g.closePath();
  }
  function txt(g, s, x, y, font, color, align, baseline) {
    g.font = font; g.fillStyle = color;
    g.textAlign = align || 'left'; g.textBaseline = baseline || 'alphabetic';
    g.fillText(s, x, y);
  }
  function spaced(g, s, x, y, font, color, gap, align) {
    g.font = font; g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    var total = 0, i;
    for (i = 0; i < s.length; i++) total += g.measureText(s[i]).width + (i ? gap : 0);
    var px = align === 'center' ? x - total / 2 : (align === 'right' ? x - total : x);
    for (i = 0; i < s.length; i++) { g.fillText(s[i], px, y); px += g.measureText(s[i]).width + gap; }
  }
  function wrap(g, s, x, y, maxW, lh, font, color) {
    g.font = font; g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'top';
    var line = '', cy = y;
    for (var i = 0; i < s.length; i++) {
      var test = line + s[i];
      if (g.measureText(test).width > maxW && line) { g.fillText(line, x, cy); line = s[i]; cy += lh; }
      else line = test;
    }
    if (line) g.fillText(line, x, cy);
    return cy + lh;
  }

  var UI = G.UI = {
    state: 'boot',
    paused: false,
    visible: 'boot',
    finishVisible: false,
    screen: 'boot',
    fps: 0,
    carIndex: 0,
    quality: 'mid',
    _inited: false,
    hits: [],
    active: {},
    boot: { pct: 0, msg: '正在载入赛区', done: false, fade: 0 },
    hud: { lap: '1/3', time: '00:00.00', best: '--:--.--', speed: 0, ratio: 0, boost: 0, firing: false, drift: false, nitro: 0 },
    cd: { label: null, at: 0 },
    msg: { text: '', until: 0 },
    toastMsg: { text: '', until: 0 },
    finish: { map: '', laps: [], total: 0 },
    _statAnim: 0,
    _statTarget: 0,
    settingsOpen: false,
    _layoutBackup: null,
    pilotName: '',
    pilotEditing: false,

    /* ---------- 生命周期 ---------- */
    init: function (ctx) {
      if (this.ctx) { for (var k in ctx) this.ctx[k] = ctx[k]; }
      else this.ctx = ctx;
      this.quality = G.Quality.level || 'mid';
      if (this._inited) return;
      this._inited = true;

      this.dpr = Math.min(WIN.devicePixelRatio || 2, 2);
      this.W = WIN.innerWidth; this.H = WIN.innerHeight;
      this.loadLayout();
      this.pilotName = String(G.store.get('apex_user', '') || '');
      this.volMusic = (G.audio && G.audio.musicVol != null) ? G.audio.musicVol : 0.45;
      this.volSfx = (G.audio && G.audio.sfxVol != null) ? G.audio.sfxVol : 0.7;
      var self0 = this;
      if (wx.onKeyboardInput) wx.onKeyboardInput(function (res) { self0.pilotName = String((res && res.value) || '').slice(0, 12); });
      if (wx.onKeyboardConfirm) wx.onKeyboardConfirm(function (res) {
        if (res && res.value != null) self0.pilotName = String(res.value).slice(0, 12);
        self0.pilotEditing = false;
        try { if (wx.hideKeyboard) wx.hideKeyboard(); } catch (e) {}
      });
      if (wx.onKeyboardComplete) wx.onKeyboardComplete(function () { self0.pilotEditing = false; });

      var cv = wx.createCanvas();
      cv.width = Math.round(this.W * this.dpr);
      cv.height = Math.round(this.H * this.dpr);
      this.cv = cv;
      this.g = cv.getContext('2d');

      this.tex = new THREE.CanvasTexture(cv);
      this.tex.encoding = THREE.sRGBEncoding;
      this.tex.minFilter = THREE.LinearFilter;
      this.tex.magFilter = THREE.LinearFilter;
      this.tex.wrapS = THREE.ClampToEdgeWrapping;
      this.tex.wrapT = THREE.ClampToEdgeWrapping;
      this.tex.generateMipmaps = false;

      this.overlayScene = new THREE.Scene();
      this.overlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      var mat = new THREE.MeshBasicMaterial({
        map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false
      });
      // 兜底：若机型 2D 画布不支持透明通道（清屏后 alpha 仍为 255），
      // 改用加色混合让黑色背景自然消失，避免整块 UI 把 3D 画面盖黑
      var alphaOk = true;
      try {
        this.g.clearRect(0, 0, 2, 2);
        alphaOk = this.g.getImageData(0, 0, 1, 1).data[3] < 250;
      } catch (e) {}
      this._alphaOk = alphaOk;
      if (!alphaOk) mat.blending = THREE.AdditiveBlending;
      this.overlayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      this.overlayScene.add(this.overlayQuad);

      this._bindTouch();
    },

    _bindTouch: function () {
      var self = this;
      var list = function (res, changed) {
        var a = (changed ? res.changedTouches : res.touches) || res.touches || [];
        return a;
      };
      if (wx.onTouchStart) wx.onTouchStart(function (res) {
        var ts = list(res, true);
        for (var i = 0; i < ts.length; i++) self.touchStart(ts[i].identifier, ts[i].clientX, ts[i].clientY);
      });
      if (wx.onTouchMove) wx.onTouchMove(function (res) {
        var ts = list(res, true);
        for (var i = 0; i < ts.length; i++) self.touchMove(ts[i].identifier, ts[i].clientX, ts[i].clientY);
      });
      var end = function (res) {
        var ts = list(res, true);
        for (var i = 0; i < ts.length; i++) self.touchEnd(ts[i].identifier);
      };
      if (wx.onTouchEnd) wx.onTouchEnd(end);
      if (wx.onTouchCancel) wx.onTouchCancel(end);
    },

    /* ---------- 按键布局（可拖拽 / 可缩放，存本地） ---------- */
    defaultPos: function () {
      var W = this.W, H = this.H;
      var st = WIN.__safe || { left: 0, right: 0, bottom: 0 };
      var bottom = 58 + st.bottom, lr = 82, lx = 18 + st.left;
      return {
        left: { x: (lx + lr / 2) / W, y: (H - bottom - lr / 2) / H },
        right: { x: (lx + lr + 12 + lr / 2) / W, y: (H - bottom - lr / 2) / H },
        reset: { x: (lx + 25) / W, y: (H - bottom - lr - 48) / H },
        brake: { x: (W - st.right - 22 - 100 - 26 - 34) / W, y: (H - st.bottom - 40 - 34) / H },
        drift: { x: (W - st.right - 22 - 100 - 26 - 34 - 30 - 16) / W, y: (H - st.bottom - 120 - 30) / H },
        // 氮气键放在刹车正上方（窄屏也不会压到中央车速数字）
        nitro: { x: (W - st.right - 22 - 100 - 26 - 34) / W, y: (H - st.bottom - 120 - 30 - 40 - 32 - 12) / H }
      };
    },
    loadLayout: function () {
      var d = null;
      try {
        var raw = G.store.get('apex_btn_layout', '');
        if (raw) d = JSON.parse(raw);
      } catch (e) { d = null; }
      if (!d || !d.pos || !d.pos.left) d = { scale: 1, pos: this.defaultPos() };
      // 旧版本布局没有复位键 / 氮气键，补默认位置
      if (!d.pos.reset) d.pos.reset = this.defaultPos().reset;
      if (!d.pos.nitro) d.pos.nitro = this.defaultPos().nitro;
      d.scale = clamp(d.scale || 1, 0.7, 1.5);
      G.btnLayout = d;
    },
    saveLayout: function () {
      try { G.store.set('apex_btn_layout', JSON.stringify(G.btnLayout)); } catch (e) {}
    },
    resetLayout: function () {
      G.btnLayout = { scale: 1, pos: this.defaultPos() };
    },
    // 按钮中心/半径（按存储的归一化坐标换算，并限制在屏幕内）
    getCtr: function (id) {
      var L = G.btnLayout || { scale: 1, pos: this.defaultPos() };
      var sc = clamp(L.scale || 1, 0.7, 1.5);
      var baseR = { left: 41, right: 41, reset: 25, brake: 30, drift: 40, nitro: 32 }[id] || 30;
      var p = (L.pos && L.pos[id]) || this.defaultPos()[id];
      var r = baseR * sc;
      var x = clamp(p.x * this.W, r + 4, this.W - r - 4);
      var y = clamp(p.y * this.H, r + 4, this.H - r - 4);
      return { x: x, y: y, r: r, sc: sc };
    },

    driverName: function () {
      return this.pilotName && this.pilotName.trim() ? this.pilotName.trim() : 'WILL RACER';
    },
    showPilot: function () {
      this.screen = 'pilot';
      this.state = 'pilot';
      this._releaseAll();
    },
    confirmPilot: function () {
      var name = String(this.pilotName || '').replace(/\s+/g, ' ').trim().slice(0, 12);
      if (!name) name = 'WILL RACER';
      this.pilotName = name;
      this.pilotEditing = false;
      try { if (wx.hideKeyboard) wx.hideKeyboard(); } catch (e) {}
      try { G.store.set('apex_user', name); } catch (e) {}
      this.show('showroom');
      this.toast('欢迎，' + name, 2200);
    },
    openKeyboard: function () {
      this.pilotEditing = true;
      try {
        if (wx.showKeyboard) {
          wx.showKeyboard({
            defaultValue: this.pilotName || '',
            maxLength: 12, multiple: false, confirmHold: false, confirmType: 'done'
          });
        }
      } catch (e) {}
    },

    /* ---------- 外部 API ---------- */
    click: function () {
      try {
        if (this.ctx && this.ctx.audio) {
          this.ctx.audio.start(); this.ctx.audio.resume(); this.ctx.audio.click();
        }
      } catch (e) {}
    },
    show: function (name) {
      var map = { pilot: 'pilot', showroom: 'showroom', mapsel: 'mapsel', hud: 'race', loading: 'loading' };
      var s = map[name] || name;
      this.screen = s;
      if (s === 'pilot') this.state = 'pilot';
      else if (s === 'showroom') this.state = 'showroom';
      else if (s === 'mapsel') this.state = 'mapsel';
      else if (s === 'race') this.state = 'race';
      this.visible = name;
      this._releaseAll();
    },
    overlay: function (id, on) {
      if (id === 'pause') this.paused = !!on;
      if (id === 'finish') this.finishVisible = !!on;
      if (on) this._releaseAll();
    },
    toast: function (msg, ms) {
      this.toastMsg.text = msg;
      this.toastMsg.until = Date.now() + (ms || 2400);
    },
    setBoot: function (pct, msg) {
      this.boot.pct = clamp(pct, 0, 1);
      if (msg) this.boot.msg = msg;
    },
    hideBoot: function () { this.boot.done = true; this.boot.fade = 0; },
    fatal: function (msg) {
      this.fatalMsg = msg;
      try { wx.showToast({ title: msg, icon: 'none' }); } catch (e) {}
    },
    refreshShowroom: function () {
      this.carIndex = this.ctx && this.ctx.showroom ? this.ctx.showroom.slot : 0;
      this._statAnim = 0;
      this._statTarget = 1;
    },
    setSys: function (fps) { this.fps = fps; },
    switchCar: function (dir) {
      this.click();
      var sr = this.ctx && this.ctx.showroom;
      if (!sr) return;
      sr.slot = (sr.slot + dir + G.CARS.length) % G.CARS.length;
      this.applyCarToShowroom();
      var meta = G.CARS[sr.slot];
      if (!meta.avail) this.toast('该车辆尚未解锁，完成赛事后开放');
    },
    // 把当前槽位的车辆挂到展台；车模未加载时先占位并异步加载
    applyCarToShowroom: function () {
      var self = this;
      var sr = this.ctx && this.ctx.showroom;
      if (!sr) return;
      var meta = G.CARS[sr.slot];
      if (!meta.avail) {
        sr.setCar(G.ghostVisual);
        this.refreshShowroom();
        return;
      }
      var vis = G.carVisuals && G.carVisuals[meta.id];
      if (vis) { sr.setCar(vis); this.refreshShowroom(); return; }
      sr.setCar(G.ghostVisual);
      this.refreshShowroom();
      if (G.CarFactory.failed[meta.id]) { this.toast(meta.name + ' 车模加载失败，已启用备用赛车'); return; }
      this.toast('正在载入 ' + meta.name + ' 车模…', 1800);
      G.CarFactory.load(meta.id, null, function (ok) {
        G.carVisuals[meta.id] = G.CarFactory.build(meta);
        if (G.CARS[self.ctx.showroom.slot].id === meta.id) {
          self.ctx.showroom.setCar(G.carVisuals[meta.id]);
          self.refreshShowroom();
        }
        if (!ok) self.toast(meta.name + ' 车模加载失败，已启用备用赛车');
      });
    },
    toMapSelect: function () {
      var car = G.CARS[this.carIndex];
      if (!car.avail) { this.toast('请先选择已解锁的车辆'); return; }
      this.click(); this.show('mapsel');
    },
    startRace: function (mapId) {
      var self = this;
      var car = G.CARS[this.ctx.showroom.slot] || G.CARS[0];
      var go = function (visual) {
        self.click();
        self.show('loading');
        self.loadingMsg = '正在生成 ' + (G.TRACKS[mapId] ? G.TRACKS[mapId].name : '赛道');
        setTimeout(function () {
          try {
            self.ctx.race.setup(mapId, visual);
            self.show('hud');
            self.ctx.race.begin();
            self.setHudLap(1, self.ctx.race.def.laps);
            var best = parseFloat(G.store.get(G.bestKey(mapId), 'NaN'));
            self.setHudBest(isFinite(best) ? best : null);
          } catch (e) {
            self.show('showroom');
            self.toast('赛道生成失败：' + (e && e.message ? e.message : '未知错误'), 3200);
          }
        }, 60);
      };
      var vis = G.carVisuals[car.id];
      if (!vis && car.avail && !G.CarFactory.failed[car.id]) {
        this.show('loading');
        this.loadingMsg = '正在载入 ' + car.name;
        G.CarFactory.load(car.id, null, function (ok) {
          G.carVisuals[car.id] = G.CarFactory.build(car);
          go(G.carVisuals[car.id]);
        });
      } else {
        go(vis || G.CarFactory.build(car));
      }
    },
    pause: function () {
      if (this.state !== 'race' || this.paused) return;
      this.click();
      if (this.ctx.audio) this.ctx.audio.mute();
      this.overlay('pause', true);
    },
    resume: function () {
      this.overlay('pause', false);
      if (this.ctx.audio) this.ctx.audio.resume();
    },
    restart: function () {
      this.overlay('pause', false);
      this.overlay('finish', false);
      this.ctx.race.restart();
      this.setHudLap(1, this.ctx.race.def.laps);
      this._releaseAll();
    },
    toShowroom: function () {
      this.overlay('pause', false);
      this.overlay('finish', false);
      this.ctx.race.dispose();
      // 比赛时车辆被挂到赛道场景，返回展厅要重新挂回转台
      var sr = this.ctx.showroom;
      if (sr) {
        var meta = G.CARS[sr.slot] || G.CARS[0];
        sr.setCar(meta.avail ? (G.carVisuals[meta.id] || G.ghostVisual) : G.ghostVisual);
      }
      if (this.ctx.audio) this.ctx.audio.mute();
      this.show('showroom');
    },
    showFinish: function (mapName, laps, total) {
      this.finish.map = mapName; this.finish.laps = laps.slice(); this.finish.total = total;
      this.overlay('finish', true);
    },
    setHudLap: function (lap, total) { this.hud.lap = lap + '/' + total; },
    setHudTime: function (t) { this.hud.time = fmt(t); },
    setHudBest: function (t) { this.hud.best = fmt(t); },
    setHudSpeed: function (kmh, s01) { this.hud.speed = kmh; this.hud.ratio = clamp(s01, 0, 1); },
    setDrift: function (on) { this.hud.drift = !!on; },
    setBoost: function (charge, firing, nitro) {
      this.hud.boost = clamp(charge, 0, 1);
      this.hud.firing = !!firing;
      this.hud.nitro = nitro > 0 ? 1 : 0;
    },
    countdown: function (label) {
      if (label == null) { this.cd.label = null; return; }
      this.cd.label = label; this.cd.at = Date.now();
    },
    raceMsg: function (msg, ms) { this.msg.text = msg; this.msg.until = Date.now() + (ms || 2.5) * 1000; },
    syncQuality: function () { this.quality = G.Quality.level; },

    /* ---------- 触屏 ---------- */
    _releaseAll: function () {
      for (var id in this.active) {
        var a = this.active[id];
        if (a && a.btn && G.input) G.input.press(a.btn, false);
      }
      this.active = {};
      if (G.input && G.input.releaseAll) G.input.releaseAll();
    },
    touchStart: function (id, x, y) {
      if (x == null || y == null) return;
      if (G.input && G.input.notifyTouch) G.input.notifyTouch();
      if (this.settingsOpen) { this._settingsStart(id, x, y); return; }
      var hit = this._hit(x, y);
      if (this.paused) { if (hit) this._tap(hit); return; }
      if (this.finishVisible) { if (hit) this._tap(hit); return; }
      if (this.screen === 'pilot') { if (hit) this._tap(hit); return; }
      if (this.screen === 'race') {
        if (hit && (hit.id === 'pause' || hit.id === 'reset' || hit.id === 'nitro')) { this._tap(hit); return; }
        if (hit && hit.btn) {
          G.input.press(hit.btn, true);
          this.active[id] = { btn: hit.btn, x: x, y: y, rect: hit };
        }
        return;
      }
      if (this.screen === 'showroom') {
        if (hit) { this._tap(hit); return; }
        this.active[id] = { drag: true, lastX: x };
        if (G.input) G.input.dragging = true;
        return;
      }
      if (hit) this._tap(hit);
    },
    touchMove: function (id, x, y) {
      if (this.settingsOpen) { this._settingsMove(id, x, y); return; }
      var a = this.active[id];
      if (!a) return;
      if (a.drag) {
        if (G.input) G.input.drag(x - a.lastX);
        a.lastX = x;
      }
    },
    touchEnd: function (id) {
      if (this.settingsOpen) { delete this.active[id]; return; }
      var a = this.active[id];
      if (!a) return;
      if (a.btn && G.input) G.input.press(a.btn, false);
      if (a.drag && G.input) G.input.dragging = false;
      delete this.active[id];
    },
    _addHit: function (id, x, y, w, h, btn) {
      this.hits.push({ id: id, x: x, y: y, w: w, h: h, btn: btn || null });
    },
    _hit: function (x, y) {
      for (var i = this.hits.length - 1; i >= 0; i--) {
        var h = this.hits[i];
        if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
      }
      return null;
    },
    _tap: function (hit) {
      switch (hit.id) {
        case 'prev': this.switchCar(-1); break;
        case 'next': this.switchCar(1); break;
        case 'toMap': this.toMapSelect(); break;
        case 'mapback': this.click(); this.show('showroom'); break;
        case 'map-harbor': this.startRace('harbor'); break;
        case 'map-mountain': this.startRace('mountain'); break;
        case 'map-locked': this.toast('赛道正在重新设计，敬请期待'); break;
        case 'pause': this.pause(); break;
        case 'reset':
          this.click();
          if (this.ctx && this.ctx.race) this.ctx.race.respawn();
          break;
        case 'nitro':
          if (!this.paused && this.ctx && this.ctx.race && this.ctx.race.useNitro) this.ctx.race.useNitro();
          break;
        case 'resume': this.click(); this.resume(); break;
        case 'restart': this.click(); this.restart(); break;
        case 'garage': this.click(); this.toShowroom(); break;
        case 'again': this.click(); this.restart(); break;
        case 'finishGarage': this.click(); this.toShowroom(); break;
        case 'settings': this.openSettings(); break;
        case 'pilot-input': this.openKeyboard(); break;
        case 'pilot-go': this.confirmPilot(); break;
        case 'set-save': this.saveLayout(); this.closeSettings(true); break;
        case 'set-cancel': this.closeSettings(false); break;
        case 'set-reset': this.resetLayout(); break;
        case 'size-minus': G.btnLayout.scale = clamp((G.btnLayout.scale || 1) - 0.05, 0.7, 1.5); break;
        case 'size-plus': G.btnLayout.scale = clamp((G.btnLayout.scale || 1) + 0.05, 0.7, 1.5); break;
        case 'quality':
        case 'q-low': case 'q-mid': case 'q-high':
          var lv = hit.id === 'quality'
            ? (this.quality === 'low' ? 'mid' : this.quality === 'mid' ? 'high' : 'low')
            : hit.id.slice(2);
          this.click();
          this.ctx.renderer.applyQuality(lv);
          this.syncQuality();
          break;
      }
    },

    /* ---------- 设置：按键布局 + 音量 ---------- */
    openSettings: function () {
      try { this._layoutBackup = JSON.parse(JSON.stringify(G.btnLayout)); } catch (e) { this._layoutBackup = null; }
      var au = this.ctx && this.ctx.audio;
      this.volMusic = au ? au.musicVol : (this.volMusic == null ? 0.45 : this.volMusic);
      this.volSfx = au ? au.sfxVol : (this.volSfx == null ? 0.7 : this.volSfx);
      this._volBackup = { music: this.volMusic, sfx: this.volSfx };
      this.settingsOpen = true;
      this._releaseAll();
    },
    closeSettings: function (save) {
      if (!save && this._layoutBackup) G.btnLayout = this._layoutBackup;
      if (!save && this._volBackup) {
        this._setVolume('music', this._volBackup.music);
        this._setVolume('sfx', this._volBackup.sfx);
      }
      this._layoutBackup = null;
      this._volBackup = null;
      this.settingsOpen = false;
      this._releaseAll();
    },
    _setVolume: function (kind, v) {
      v = clamp(v, 0, 1);
      var au = this.ctx && this.ctx.audio;
      if (kind === 'music') { this.volMusic = v; if (au) au.setMusicVolume(v); }
      else { this.volSfx = v; if (au) au.setSfxVolume(v); }
    },
    _settingsStart: function (id, x, y) {
      var hit = this._hit(x, y);
      if (!hit) return;
      if (hit.id === 'vol-music' || hit.id === 'vol-sfx') {
        var kind = hit.id === 'vol-music' ? 'music' : 'sfx';
        this.active[id] = { slider: kind, sx: hit.x, sw: hit.w };
        this._setVolume(kind, (x - hit.x) / hit.w);
        return;
      }
      if (hit.btn) {
        var c = this.getCtr(hit.btn);
        this.active[id] = { dragBtn: hit.btn, ox: x - c.x, oy: y - c.y };
        return;
      }
      if (hit.id === 'set-save' || hit.id === 'set-cancel' || hit.id === 'set-reset' ||
          hit.id === 'size-minus' || hit.id === 'size-plus') {
        this._tap(hit);
      }
    },
    _settingsMove: function (id, x, y) {
      var a = this.active[id];
      if (a && a.slider) { this._setVolume(a.slider, (x - a.sx) / a.sw); return; }
      if (!a || !a.dragBtn) return;
      var c = this.getCtr(a.dragBtn);
      var p = G.btnLayout.pos[a.dragBtn];
      if (!p) return;
      p.x = clamp((x - a.ox) / this.W, c.r / this.W + 0.005, 1 - c.r / this.W - 0.005);
      p.y = clamp((y - a.oy) / this.H, c.r / this.H + 0.005, 1 - c.r / this.H - 0.005);
    },
    _drawSettings: function (g) {
      var W = this.W, H = this.H, i;
      g.fillStyle = 'rgba(2,6,10,.74)'; g.fillRect(0, 0, W, H);
      g.strokeStyle = 'rgba(45,226,255,.09)'; g.lineWidth = 1;
      for (var gx = 0; gx < W; gx += 40) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke(); }
      for (var gy = 0; gy < H; gy += 40) { g.beginPath(); g.moveTo(0, gy); g.lineTo(W, gy); g.stroke(); }

      var pw = Math.min(620, W - 24), px = W / 2 - pw / 2, py = 8 + S.top, ph = 176;
      g.save();
      g.shadowColor = 'rgba(0,0,0,.65)'; g.shadowBlur = 20;
      g.fillStyle = C.plateSolid; cutPath(g, px, py, pw, ph, 16); g.fill();
      g.restore();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.signal; g.fillRect(px, py, pw * 0.5, 2);
      txt(g, '设置', px + 18, py + 26, '900 17px ' + F_LABEL, C.bone);
      txt(g, '拖动按键调整位置，滑杆调整音量', px + 18, py + 44, '500 10px ' + F_LABEL, C.steel);

      // 大小
      var sy = py + 14;
      txt(g, '按钮大小', px + pw - 250, sy + 18, '600 10px ' + F_LABEL, C.steel);
      this._miniBtn(g, 'size-minus', px + pw - 190, sy, 32, 26, '−');
      txt(g, Math.round((G.btnLayout.scale || 1) * 100) + '%', px + pw - 120, sy + 18, '700 13px ' + F_NUM, C.signal, 'center');
      this._miniBtn(g, 'size-plus', px + pw - 84, sy, 32, 26, '+');

      // 操作
      var by = py + 62;
      this._textBtn(g, 'set-reset', px + 18, by, 92, 30, '默认', false);
      this._textBtn(g, 'set-cancel', px + 118, by, 92, 30, '取消', false);
      this._textBtn(g, 'set-save', px + 218, by, 112, 30, '保存', true);

      // 音量
      this._volSlider(g, 'vol-music', px + 18, py + 112, 330, '音乐', this.volMusic == null ? 0.45 : this.volMusic);
      this._volSlider(g, 'vol-sfx', px + 18, py + 144, 330, '音效', this.volSfx == null ? 0.7 : this.volSfx);

      // 可拖拽按钮
      var c;
      c = this.getCtr('left'); this._editMark(g, c, false);
      c = this.getCtr('right'); this._editMark(g, c, false);
      c = this.getCtr('reset'); this._editMark(g, c, false);
      c = this.getCtr('brake'); this._editMark(g, c, false);
      c = this.getCtr('drift'); this._editMark(g, c, false);
      c = this.getCtr('nitro'); this._editMark(g, c, false);
      c = this.getCtr('left'); this._padBtn(g, 'left', c.x, c.y, c.r * 2, 'L', c.sc);
      c = this.getCtr('right'); this._padBtn(g, 'right', c.x, c.y, c.r * 2, 'R', c.sc);
      c = this.getCtr('reset'); this._resetBtn(g, 'reset', c.x, c.y, c.r, c.sc);
      c = this.getCtr('brake'); this._brakeBtn(g, 'brake', c.x, c.y, c.r, c.sc);
      c = this.getCtr('drift'); this._driftBtn(g, 'drift', c.x, c.y, c.r, c.sc);
      c = this.getCtr('nitro'); this._nitroBtn(g, c.x, c.y, c.r, c.sc, true, false);
      // 编辑态命中区（带 btn，用于拖拽）
      this._addHit('nitro-edit', c.x - c.r, c.y - c.r, c.r * 2, c.r * 2, 'nitro');
    },
    _volSlider: function (g, id, x, y, w, label, v) {
      txt(g, label, x, y + 4, '600 11px ' + F_LABEL, C.boneDim);
      var tx = x + 46, tw = w - 46 - 46;
      this._addHit(id, tx, y - 12, tw, 26);
      g.fillStyle = 'rgba(120,220,255,.14)'; g.fillRect(tx, y, tw, 3);
      var gr = g.createLinearGradient(tx, 0, tx + tw, 0);
      gr.addColorStop(0, C.steel); gr.addColorStop(1, C.signal);
      g.fillStyle = gr; g.fillRect(tx, y, tw * v, 3);
      g.save();
      g.shadowColor = 'rgba(45,226,255,.65)'; g.shadowBlur = 8;
      g.beginPath(); g.arc(tx + tw * v, y + 1.5, 6, 0, Math.PI * 2);
      g.fillStyle = C.signal; g.fill();
      g.restore();
      txt(g, Math.round(v * 100) + '%', x + w, y + 4, '700 10px ' + F_NUM, C.bone, 'right');
    },
    _editMark: function (g, c, square) {
      g.save();
      g.setLineDash([5, 5]);
      g.strokeStyle = 'rgba(140,241,255,.42)'; g.lineWidth = 1;
      if (square) g.strokeRect(c.x - c.r - 6, c.y - c.r - 6, c.r * 2 + 12, c.r * 2 + 12);
      else { g.beginPath(); g.arc(c.x, c.y, c.r + 10, 0, Math.PI * 2); g.stroke(); }
      g.setLineDash([]);
      g.strokeStyle = 'rgba(140,241,255,.7)';
      g.beginPath(); g.moveTo(c.x - 4, c.y); g.lineTo(c.x + 4, c.y); g.moveTo(c.x, c.y - 4); g.lineTo(c.x, c.y + 4); g.stroke();
      g.restore();
    },
    _miniBtn: function (g, id, x, y, w, h, label) {
      this._addHit(id, x, y, w, h);
      g.fillStyle = 'rgba(8,20,30,.9)'; cutPath(g, x, y, w, h, 7); g.fill();
      g.strokeStyle = 'rgba(120,220,255,.4)'; g.lineWidth = 1; g.stroke();
      txt(g, label, x + w / 2, y + h / 2, '700 15px ' + F_NUM, C.signal, 'center', 'middle');
    },
    _textBtn: function (g, id, x, y, w, h, label, primary) {
      this._addHit(id, x, y, w, h);
      g.fillStyle = primary ? C.signal : 'rgba(232,228,218,.05)';
      cutPath(g, x, y, w, h, 8); g.fill();
      if (!primary) { g.strokeStyle = C.line; g.lineWidth = 1; g.stroke(); }
      txt(g, label, x + w / 2, y + h / 2, '700 12px ' + F_LABEL, primary ? '#02141a' : C.bone, 'center', 'middle');
    },

    /* ---------- 渲染 ---------- */
    render: function (dt, t) {
      if (!this._inited) return;
      S = WIN.__safe || S;
      var now = Date.now();
      if (this.boot.done && this.boot.fade < 1) this.boot.fade = Math.min(1, this.boot.fade + dt / 0.6);
      if (this.msg.until && now > this.msg.until) this.msg.text = '';
      if (this.toastMsg.until && now > this.toastMsg.until) this.toastMsg.text = '';
      if (this._statAnim < this._statTarget) this._statAnim = Math.min(1, this._statAnim + dt / 0.7);

      // 尺寸变化
      if (WIN.innerWidth !== this.W || WIN.innerHeight !== this.H) {
        this.W = WIN.innerWidth; this.H = WIN.innerHeight;
        this.cv.width = Math.round(this.W * this.dpr);
        this.cv.height = Math.round(this.H * this.dpr);
        this.tex.dispose();
        this.tex = new THREE.CanvasTexture(this.cv);
        this.tex.encoding = THREE.sRGBEncoding;
        this.tex.minFilter = THREE.LinearFilter;
        this.tex.magFilter = THREE.LinearFilter;
        this.tex.wrapS = THREE.ClampToEdgeWrapping;
        this.tex.wrapT = THREE.ClampToEdgeWrapping;
        this.tex.generateMipmaps = false;
        this.overlayQuad.material.map = this.tex;
        this.overlayQuad.material.needsUpdate = true;
      }

      var g = this.g;
      // 2D 重绘与纹理上传限到 30fps（合成每帧都做，避免与 WebGL 帧不同步）
      var animating = this.cd.label != null || (this.boot.done && this.boot.fade < 1) || this._statAnim < this._statTarget;
      if (animating || now - (this._lastDraw || 0) >= 30) {
        this._lastDraw = now;
        g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        g.clearRect(0, 0, this.W, this.H);
        this.hits = [];

        if (this.screen === 'boot' && !this.boot.done) this._drawBoot(g);
        else if (this.screen === 'pilot') this._drawPilot(g);
        else if (this.screen === 'showroom') this._drawShowroom(g);
        else if (this.screen === 'mapsel') this._drawMapsel(g);
        else if (this.screen === 'loading') this._drawLoading(g);
        else if (this.screen === 'race') this._drawHUD(g);

        if (this.screen === 'boot' && this.boot.done) this._drawBoot(g);

        if (this.state === 'race' && this.paused) this._drawPause(g);
        if (this.finishVisible) this._drawFinish(g);
        if (this.settingsOpen) this._drawSettings(g);
        if (this.toastMsg.text) this._drawToast(g);
        if (this.fatalMsg) this._drawFatal(g);

        this.tex.needsUpdate = true;
      }
      this._composite();
    },
    _composite: function () {
      var r = this.ctx && this.ctx.renderer && this.ctx.renderer.renderer;
      if (!r) return;
      var prev = r.autoClear;
      r.autoClear = false;
      r.render(this.overlayScene, this.overlayCam);
      r.autoClear = prev;
    },

    /* ---------- 启动屏 ---------- */
    _drawBoot: function (g) {
      var W = this.W, H = this.H;
      g.globalAlpha = 1 - this.boot.fade;
      g.fillStyle = C.ink; g.fillRect(0, 0, W, H);
      var cy = H * 0.42;
      var f = '900 ' + Math.round(clamp(W * 0.075, 28, 64)) + 'px ' + F_LABEL;
      g.font = f;
      var a = '巴音布鲁克', b = '的干';
      var wA = g.measureText(a).width, wB = g.measureText(b).width;
      var total = wA + wB;
      var x = W / 2 - total / 2;
      txt(g, a, x, cy, f, C.bone, 'left');
      txt(g, b, x + wA, cy, f, C.signal, 'left');
      spaced(g, this.boot.msg, W / 2, cy + 34, '500 12px ' + F_NUM, C.steel, 1.6, 'center');
      var bw = Math.min(320, W * 0.7), bx = W / 2 - bw / 2, by = cy + 52;
      g.fillStyle = '#23282c'; g.fillRect(bx, by, bw, 2);
      g.fillStyle = C.signal; g.fillRect(bx, by, bw * this.boot.pct, 2);
      spaced(g, Math.round(this.boot.pct * 100) + '%', W / 2, by + 22, '600 10px ' + F_NUM, C.signal, 1.2, 'center');
      g.globalAlpha = 1;
    },
    /* ---------- 车手登记 ---------- */
    _drawPilot: function (g) {
      var W = this.W, H = this.H, i;
      var bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, 'rgba(3,9,15,.90)');
      bg.addColorStop(0.6, 'rgba(2,6,10,.94)');
      bg.addColorStop(1, 'rgba(2,5,9,.98)');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);

      g.strokeStyle = 'rgba(45,226,255,.07)'; g.lineWidth = 1;
      for (i = 0; i < W; i += 48) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, H); g.stroke(); }
      for (i = 0; i < H; i += 48) { g.beginPath(); g.moveTo(0, i); g.lineTo(W, i); g.stroke(); }

      // 背景水印
      g.save();
      g.globalAlpha = 0.045;
      g.font = '900 ' + Math.round(W * 0.18) + 'px ' + F_NUM;
      g.fillStyle = C.signal;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('WILL GP', W / 2, H * 0.52);
      g.restore();

      var cx = W / 2;
      var cy = H * 0.36;
      var tf = '900 ' + Math.round(clamp(W * 0.075, 28, 56)) + 'px ' + F_LABEL;
      g.font = tf;
      var a = '巴音布鲁克', b = '的干';
      var wA = g.measureText(a).width, wB = g.measureText(b).width;
      var sx = cx - (wA + wB) / 2;
      txt(g, a, sx, cy - 20, tf, C.bone, 'left');
      txt(g, b, sx + wA, cy - 20, tf, C.signal, 'left');
      spaced(g, '输入车手名', cx, cy + 12, '600 12px ' + F_LABEL, C.steel, 2.4, 'center');

      // 输入卡
      var iw = Math.min(560, W - 48), ih = 84;
      var ix = cx - iw / 2, iy = cy + 34;
      this._addHit('pilot-input', ix, iy, iw, ih);
      g.save();
      g.shadowColor = 'rgba(45,226,255,.5)'; g.shadowBlur = 16;
      cutPath(g, ix, iy, iw, ih, 16);
      g.fillStyle = 'rgba(5,14,22,.92)'; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(45,226,255,.55)'; g.lineWidth = 1.5; g.stroke();
      g.restore();
      g.fillStyle = C.signal; g.fillRect(ix + 20, iy, 46, 2);
      g.fillStyle = 'rgba(45,226,255,.22)'; g.fillRect(ix + 2, iy + 2, iw - 4, 1);

      var nm = String(this.pilotName || '').trim();
      var nameFont = '700 30px ' + F_NUM;
      g.font = nameFont;
      if (nm) {
        txt(g, nm, ix + 22, iy + ih / 2 + 2, nameFont, C.bone, 'left', 'middle');
        var nw = Math.min(g.measureText(nm).width + nm.length * 1.5, iw - 70);
        if (Date.now() % 900 < 520) {
          g.fillStyle = C.signal;
          g.fillRect(ix + 24 + nw, iy + ih / 2 - 15, 2, 30);
        }
        txt(g, nm.length + ' / 12', ix + iw - 18, iy + ih - 18, '500 9px ' + F_NUM, C.steel, 'right');
      } else {
        txt(g, '点击输入车手名', ix + 22, iy + ih / 2 + 2, '500 18px ' + F_LABEL, C.steel, 'left', 'middle');
        if (Date.now() % 900 < 520) {
          g.fillStyle = C.signal;
          g.fillRect(ix + 24 + g.measureText('点击输入车手名').width + 6, iy + ih / 2 - 14, 2, 28);
        }
      }
      g.fillStyle = 'rgba(45,226,255,.35)';
      g.fillRect(ix + iw - 34, iy + 16, 16, 1); g.fillRect(ix + iw - 34, iy + 20, 10, 1);

      // 扫描线
      var scan = iy + 6 + ((Date.now() / 9) % (ih - 12));
      g.fillStyle = 'rgba(45,226,255,.10)';
      g.fillRect(ix + 6, scan, iw - 12, 1);

      // 进入按钮
      var bw = Math.min(340, iw), bh = 54, bx = cx - bw / 2, by = iy + ih + 30;
      this._addHit('pilot-go', bx, by, bw, bh);
      var bgr = g.createLinearGradient(bx, by, bx + bw, by);
      bgr.addColorStop(0, '#1fd2f0'); bgr.addColorStop(1, '#6af0ff');
      g.save();
      g.shadowColor = 'rgba(45,226,255,.55)'; g.shadowBlur = 18;
      g.fillStyle = bgr; cutPath(g, bx, by, bw, bh, 16); g.fill();
      g.restore();
      txt(g, '进入车库', bx + bw / 2, by + bh / 2, '900 17px ' + F_LABEL, '#02141a', 'center', 'middle');
    },
    _drawLoading: function (g) {
      var W = this.W, H = this.H;
      g.fillStyle = C.ink; g.fillRect(0, 0, W, H);
      g.font = '900 ' + Math.round(clamp(W * 0.06, 26, 52)) + 'px ' + F_LABEL;
      var w1 = g.measureText('WILL ').width, w2 = g.measureText('GP').width;
      var x = W / 2 - (w1 + w2) / 2;
      txt(g, 'WILL ', x, H * 0.44, g.font, C.bone, 'left');
      txt(g, 'GP', x + w1, H * 0.44, g.font, C.signal, 'left');
      spaced(g, this.loadingMsg || '正在生成赛道', W / 2, H * 0.44 + 32, '500 12px ' + F_NUM, C.steel, 1.4, 'center');
    },

    /* ---------- 展厅 ---------- */
    _drawShowroom: function (g) {
      var W = this.W, H = this.H, i;
      var car = G.CARS[this.carIndex] || G.CARS[0];
      // 短屏（手机横屏 ~390 高）用紧凑卡，避免卡片顶到顶栏/底栏
      var compact = W < 760 || H < 620 || W / H < 1.15;
      var pad = compact ? 14 : 26;
      var padL = pad + S.left, padR = pad + S.right, padT = pad + S.top, padB = pad + S.bottom;
      var CAP = WIN.__capsule;
      var capB = CAP ? CAP.bottom : 0;

      // 左侧 / 底部压暗
      var lg = g.createLinearGradient(0, 0, W * 0.6, 0);
      lg.addColorStop(0, 'rgba(2,6,10,.82)'); lg.addColorStop(0.55, 'rgba(2,6,10,.30)'); lg.addColorStop(1, 'rgba(2,6,10,0)');
      g.fillStyle = lg; g.fillRect(0, 0, W, H);
      var bg = g.createLinearGradient(0, H, 0, H * 0.7);
      bg.addColorStop(0, 'rgba(2,6,10,.78)'); bg.addColorStop(1, 'rgba(2,6,10,0)');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);

      // 顶栏
      var topY = padT;
      g.fillStyle = C.signal;
      cutPath(g, padL, topY, 30, 30, 10); g.fill();
      g.fillStyle = C.ink;
      cutPath(g, padL + 7, topY + 7, 16, 16, 6); g.fill();
      txt(g, 'WILL GP', padL + 42, topY + 16, '900 20px ' + F_NUM, C.bone, 'left', 'middle');
      txt(g, '巴音布鲁克的干 · 车手 ' + this.driverName(), padL + 42, topY + 30, '500 10px ' + F_LABEL, C.steel, 'left', 'middle');

      // 画质
      var sysY = Math.max(topY + 52, capB + 46);
      txt(g, '画质 ' + ({ low: '低', mid: '中', high: '高' })[this.quality], W - padR, sysY, '500 10px ' + F_NUM, C.steel, 'right');
      this._addHit('quality', W - padR - 150, sysY - 12, 150, 40);

      // 车辆档案卡（按屏幕高度选择紧凑/完整布局）
      var cw = compact ? Math.min(260, W * 0.62) : Math.min(340, W * 0.46);
      var ch = compact ? 178 : 412;
      var cx = compact ? 12 + S.left : padL;
      var cy = compact ? Math.max(74 + S.top, capB + 44)
        : Math.max(H / 2 - ch / 2, 84 + S.top);
      if (cy + ch > H - padB - 64) cy = Math.max(60 + S.top, H - padB - 64 - ch);

      var cg = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
      cg.addColorStop(0, 'rgba(8,20,30,.86)'); cg.addColorStop(1, 'rgba(4,10,16,.68)');
      g.fillStyle = cg; cutPath(g, cx, cy, cw, ch, 20); g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.signal; g.fillRect(cx, cy + 22, 3, ch - 44);
      var tx = cx + 18;

      var slot = this.carIndex + 1;
      txt(g, '0' + slot, tx, cy + 26, '600 11px ' + F_NUM, C.signal, 'left', 'middle');
      txt(g, '/ 0' + G.CARS.length, tx + 22, cy + 26, '600 11px ' + F_NUM, C.steel, 'left', 'middle');
      txt(g, '车辆档案', tx + 62, cy + 26, '600 11px ' + F_LABEL, C.steel, 'left', 'middle');
      if (!car.avail) txt(g, '未解锁', cx + cw - 18, cy + 26, '700 10px ' + F_LABEL, C.alarm, 'right', 'middle');

      var nameY = cy + (compact ? 66 : 92);
      g.font = 'italic 900 ' + (compact ? 36 : 54) + 'px ' + F_NUM;
      var ng = g.createLinearGradient(0, nameY - (compact ? 36 : 54), 0, nameY);
      ng.addColorStop(0, '#ffffff'); ng.addColorStop(1, '#9fe9f7');
      g.fillStyle = ng;
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillText(car.name, tx, nameY);
      txt(g, car.cn, tx, cy + (compact ? 86 : 112), '700 ' + (compact ? 14 : 17) + 'px ' + F_LABEL, C.bone);
      txt(g, car.sub, tx, cy + (compact ? 102 : 128), '500 10px ' + F_NUM, C.steel);

      // 标签
      var tagY = cy + (compact ? 116 : 142), tagX = tx;
      for (i = 0; i < car.tags.length; i++) {
        var tg = car.tags[i];
        g.font = '600 11px ' + F_LABEL;
        var tw = g.measureText(tg).width + 20;
        if (tagX + tw > cx + cw - 16) break;
        g.fillStyle = 'rgba(45,226,255,.09)';
        cutPath(g, tagX, tagY, tw, 22, 6); g.fill();
        g.strokeStyle = 'rgba(45,226,255,.32)'; g.lineWidth = 1; g.stroke();
        txt(g, tg, tagX + tw / 2, tagY + 11, '600 11px ' + F_LABEL, C.signal, 'center', 'middle');
        tagX += tw + 6;
      }

      if (!compact) {
        var contentW = cw - 36;
        // 简介
        wrap(g, car.desc, tx, cy + 180, contentW, 18, '400 12px ' + F_LABEL, C.boneDim);
        // 规格 2x2
        var sy = cy + 236;
        for (i = 0; i < car.spec.length; i++) {
          var s = car.spec[i], col = i % 2, row = (i / 2) | 0;
          var sx2 = tx + col * (contentW / 2), sy2 = sy + row * 40;
          txt(g, s[0], sx2, sy2, '500 10px ' + F_LABEL, C.steel);
          txt(g, s[1] + (s[2] ? ' ' + s[2] : ''), sx2, sy2 + 18, '700 17px ' + F_NUM, C.bone);
          if (row === 0) {
            g.strokeStyle = 'rgba(120,220,255,.12)'; g.lineWidth = 1;
            g.beginPath(); g.moveTo(sx2, sy2 + 30); g.lineTo(sx2 + contentW / 2 - 14, sy2 + 30); g.stroke();
          }
        }
        // 性能条（demo10 展厅档案的 5 项）
        var stY = cy + 322;
        for (i = 0; i < car.stats.length; i++) {
          var st = car.stats[i], rowY = stY + i * 17;
          txt(g, st[0], tx, rowY, '600 10px ' + F_LABEL, C.boneDim);
          var barX = tx + 38, barW = contentW - 38 - 30;
          g.fillStyle = 'rgba(120,220,255,.16)';
          for (var b = 0; b < barW; b += 10) g.fillRect(barX + b, rowY - 8, 7, 5);
          g.fillStyle = C.signal;
          var fillW = barW * (st[1] || 0) * this._statAnim;
          for (var b2 = 0; b2 < fillW; b2 += 10) g.fillRect(barX + b2, rowY - 8, Math.min(7, fillW - b2), 5);
          txt(g, String(Math.round((st[1] || 0) * 100)), tx + contentW, rowY, '700 11px ' + F_NUM, C.bone, 'right');
        }
      } else {
        // 紧凑卡：一行关键规格，保证第二辆车的性能优势可见
        var specLine = [];
        for (i = 0; i < car.spec.length; i++) {
          if (car.spec[i][1] && car.spec[i][1] !== '--') specLine.push(car.spec[i][0] + ' ' + car.spec[i][1]);
        }
        txt(g, specLine.join(' · '), tx, cy + ch - 14, '600 10px ' + F_NUM, C.signal);
      }

      // 底部操作
      var by2 = H - padB - 46;
      var dw = 46;
      this._addHit('prev', padL, by2, dw, dw);
      g.fillStyle = 'rgba(6,16,24,.7)'; cutPath(g, padL, by2, dw, dw, 10); g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      txt(g, '◀', padL + dw / 2, by2 + dw / 2, '700 16px ' + F_LABEL, C.signal, 'center', 'middle');

      this._addHit('next', padL + dw + 8, by2, dw, dw);
      g.fillStyle = 'rgba(6,16,24,.7)'; cutPath(g, padL + dw + 8, by2, dw, dw, 10); g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      txt(g, '▶', padL + dw + 8 + dw / 2, by2 + dw / 2, '700 16px ' + F_LABEL, C.signal, 'center', 'middle');

      // 指示点
      var dotsX = padL + dw * 2 + 28, dotsY = by2 + dw / 2 + 12;
      for (i = 0; i < G.CARS.length; i++) {
        g.fillStyle = i === this.carIndex ? C.signal : C.boneFaint;
        g.save(); g.translate(dotsX + i * 34, dotsY); g.transform(1, 0, -0.42, 1, 0, 0);
        g.fillRect(0, 0, 28, 4); g.restore();
      }

      // 选择赛道按钮
      var bw = compact ? Math.min(180, W * 0.46) : 210, bh = compact ? 48 : 58;
      var bx = W - padR - bw, byy = H - padB - bh;

      // 设置入口（按键布局），放在选择赛道左侧
      var setW = 104, setH = 30;
      var setX = bx - setW - 10, setY = byy + (bh - setH) / 2;
      this._addHit('settings', setX, setY, setW, setH);
      g.save();
      cutPath(g, setX, setY, setW, setH, 8);
      g.fillStyle = 'rgba(6,16,24,.72)'; g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.strokeStyle = C.signal; g.lineWidth = 1.4;
      g.beginPath(); g.arc(setX + 16, setY + setH / 2, 5, 0, Math.PI * 2); g.stroke();
      for (var gi = 0; gi < 4; gi++) {
        var ga = gi * Math.PI / 2;
        g.beginPath();
        g.moveTo(setX + 16 + Math.cos(ga) * 6, setY + setH / 2 + Math.sin(ga) * 6);
        g.lineTo(setX + 16 + Math.cos(ga) * 8, setY + setH / 2 + Math.sin(ga) * 8);
        g.stroke();
      }
      txt(g, '设置', setX + 28, setY + setH / 2, '600 10px ' + F_LABEL, C.bone, 'left', 'middle');
      g.restore();

      this._addHit(car.avail ? 'toMap' : 'toMapLocked', bx, byy, bw, bh);
      var bgr = g.createLinearGradient(bx, byy, bx + bw, byy);
      bgr.addColorStop(0, car.avail ? '#1fd2f0' : '#5b7480'); bgr.addColorStop(1, car.avail ? '#6af0ff' : '#5b7480');
      g.fillStyle = bgr; cutPath(g, bx, byy, bw, bh, 16); g.fill();
      txt(g, car.avail ? '选择赛道' : '未解锁', bx + bw / 2, byy + bh / 2, '900 16px ' + F_LABEL, '#02141a', 'center', 'middle');
    },

    /* ---------- 赛道封面：按真实中心线生成的空中俯瞰轨迹图（离屏缓存） ---------- */
    _trackCover: function (mapId) {
      this._covers = this._covers || {};
      if (this._covers[mapId] !== undefined) return this._covers[mapId];
      this._covers[mapId] = this._buildTrackCover(mapId);
      return this._covers[mapId];
    },
    _buildTrackCover: function (mapId) {
      var def = G.TRACKS && G.TRACKS[mapId];
      if (!def || !def.pts || !THREE || !wx.createCanvas) return null;
      try {
        var W = 360, H = 220, i;
        var cps = [];
        for (i = 0; i < def.pts.length; i++) cps.push(new THREE.Vector3(def.pts[i][0], 0, def.pts[i][2]));
        var curve = new THREE.CatmullRomCurve3(cps, true, def.curveType || 'catmullrom', 0.5);
        curve.arcLengthDivisions = 2000;
        var raw = curve.getSpacedPoints(240);

        // 世界坐标 -> 画布：竖长赛道旋转 90° 以填满横向缩略图
        var b0x = 1e9, b1x = -1e9, b0z = 1e9, b1z = -1e9;
        for (i = 0; i < raw.length; i++) {
          var q0 = raw[i];
          if (q0.x < b0x) b0x = q0.x;
          if (q0.x > b1x) b1x = q0.x;
          if (q0.z < b0z) b0z = q0.z;
          if (q0.z > b1z) b1z = q0.z;
        }
        var rot90 = (b1z - b0z) > (b1x - b0x) * 1.05;
        var pts2 = [];
        for (i = 0; i < raw.length; i++) {
          var q1 = raw[i];
          pts2.push(rot90 ? { x: q1.z, z: -q1.x } : { x: q1.x, z: q1.z });
        }
        var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
        for (i = 0; i < pts2.length; i++) {
          var p = pts2[i];
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.z < minZ) minZ = p.z;
          if (p.z > maxZ) maxZ = p.z;
        }
        var pad = 30;
        var sc = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxZ - minZ));
        var ox = W / 2 - (minX + maxX) * 0.5 * sc, oz = H / 2 - (minZ + maxZ) * 0.5 * sc;
        var X = function (x) { return ox + x * sc; }, Z = function (z) { return oz + z * sc; };

        var cv = wx.createCanvas();
        cv.width = W; cv.height = H;
        var g = cv.getContext('2d');

        // 底图：深色航拍
        var bg = g.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#0b1c26'); bg.addColorStop(0.55, '#07111a'); bg.addColorStop(1, '#040a10');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);
        var sea = g.createRadialGradient(W * 0.24, H * 0.18, 6, W * 0.24, H * 0.18, W * 0.6);
        sea.addColorStop(0, 'rgba(52,150,180,.18)');
        sea.addColorStop(1, 'rgba(52,150,180,0)');
        g.fillStyle = sea; g.fillRect(0, 0, W, H);
        // 码头堆场网格 + 集装箱块（压低存在感，突出赛道）
        g.strokeStyle = 'rgba(150,195,215,.045)'; g.lineWidth = 1;
        for (var gx = 0; gx <= W; gx += 30) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke(); }
        for (var gy = 0; gy <= H; gy += 30) { g.beginPath(); g.moveTo(0, gy); g.lineTo(W, gy); g.stroke(); }
        g.fillStyle = 'rgba(160,200,220,.05)';
        for (var bx = 18; bx < W - 12; bx += 36) {
          for (var by = 14; by < H - 10; by += 24) {
            if ((bx + by) % 9 < 4) continue;
            g.fillRect(bx, by, 21, 9);
          }
        }

        // 赛道路径
        var path = function () {
          g.beginPath();
          g.moveTo(X(pts2[0].x), Z(pts2[0].z));
          for (var q = 1; q < pts2.length; q++) g.lineTo(X(pts2[q].x), Z(pts2[q].z));
          g.closePath();
        };
        g.lineJoin = 'round'; g.lineCap = 'round';
        // 外发光
        g.save();
        g.shadowColor = 'rgba(45,226,255,.75)'; g.shadowBlur = 16;
        g.strokeStyle = 'rgba(45,226,255,.22)'; g.lineWidth = 17; path(); g.stroke();
        g.restore();
        // 青色路缘 + 明亮沥青，小尺寸下也能一眼看清轨迹
        g.strokeStyle = 'rgba(45,226,255,.62)'; g.lineWidth = 12; path(); g.stroke();
        g.strokeStyle = '#93aec0'; g.lineWidth = 8.5; path(); g.stroke();
        g.setLineDash([5, 6]);
        g.strokeStyle = 'rgba(6,14,20,.72)'; g.lineWidth = 1.6; path(); g.stroke();
        g.setLineDash([]);

        // 起终点
        var p0 = pts2[0], p1 = pts2[1];
        var ang = Math.atan2(Z(p1.z) - Z(p0.z), X(p1.x) - X(p0.x));
        g.save();
        g.translate(X(p0.x), Z(p0.z)); g.rotate(ang);
        g.fillStyle = '#8cf1ff'; g.shadowColor = 'rgba(45,226,255,.9)'; g.shadowBlur = 8;
        g.fillRect(-1.5, -8, 3, 16);
        g.restore();

        // 暗角
        var vg = g.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, W * 0.74);
        vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
        g.fillStyle = vg; g.fillRect(0, 0, W, H);
        return cv;
      } catch (e) { return null; }
    },

    /* ---------- 选赛道 ---------- */
    _drawMapsel: function (g) {
      var W = this.W, H = this.H;
      g.fillStyle = 'rgba(2,5,9,.55)'; g.fillRect(0, 0, W, H);
      var pw = Math.min(600, W - 28);
      var compact = H < 520;
      var cardH = compact ? 60 : 74;
      var ph = 78 + cardH * 3 + 16 + 46 + 26;
      var px = W / 2 - pw / 2, py = Math.max(8, H / 2 - ph / 2);
      g.fillStyle = 'rgba(4,10,15,.96)'; cutPath(g, px, py, pw, ph, 22); g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.signal; g.fillRect(px, py, pw * 0.6, 3);

      txt(g, '车手 ' + this.driverName(), px + 22, py + 24, '500 10px ' + F_LABEL, C.signal);
      txt(g, '选择赛道', px + 22, py + 52, '900 26px ' + F_LABEL, C.bone);
      txt(g, G.CARS[this.carIndex] ? G.CARS[this.carIndex].name : '', px + pw - 22, py + 52, '700 12px ' + F_NUM, C.steel, 'right');

      var list = [
        { id: 'harbor', name: '海港岸线', stats: '全长 ~1.95 km · 4 个发卡弯 · 难度 ★★★★☆', locked: false, color: '#1e3140' },
        { id: 'mountain', name: '山脊拉力', stats: '全长 ~3.1 km × 2 圈 · 铺装/砂石/泥泞/沙地 · 难度 ★★★★★', locked: false, color: '#26383c' },
        { id: 'city', name: '滨海大道', stats: '', locked: true, color: '#172435' }
      ];
      var cy = py + 66;
      for (var i = 0; i < list.length; i++) {
        var d = list[i], ch = cardH, y = cy + i * (ch + 10);
        g.fillStyle = 'rgba(8,20,30,.62)'; cutPath(g, px + 16, y, pw - 32, ch, 12); g.fill();
        g.strokeStyle = d.locked ? 'rgba(120,220,255,.10)' : C.line; g.lineWidth = 1; g.stroke();
        if (d.locked) g.globalAlpha = 0.55;
        // 封面：从真实中心线生成的空中俯瞰轨迹图
        var thw = compact ? 100 : 140;
        g.save();
        rr(g, px + 16, y + 1, thw, ch - 2, 9);
        g.clip();
        var cover = this._trackCover(d.id);
        if (cover) {
          // 等比裁切铺满，避免封面被横向拉伸
          var dw = thw, dh = ch - 2, dRatio = dw / dh, sRatio = cover.width / cover.height;
          var sx = 0, sy = 0, sw = cover.width, sh = cover.height;
          if (sRatio > dRatio) { sw = sh * dRatio; sx = (cover.width - sw) / 2; }
          else { sh = sw / dRatio; sy = (cover.height - sh) / 2; }
          g.drawImage(cover, sx, sy, sw, sh, px + 16, y + 1, dw, dh);
        } else {
          var tg2 = g.createLinearGradient(px + 16, y, px + 16 + thw, y + ch);
          tg2.addColorStop(0, '#2a3a49'); tg2.addColorStop(1, d.color);
          g.fillStyle = tg2; g.fillRect(px + 16, y + 1, thw, ch - 2);
        }
        if (d.locked) { g.fillStyle = 'rgba(4,10,15,.58)'; g.fillRect(px + 16, y + 1, thw, ch - 2); }
        g.restore();
        g.strokeStyle = 'rgba(120,220,255,.2)'; g.lineWidth = 1;
        rr(g, px + 16, y + 1, thw, ch - 2, 9); g.stroke();
        // 文本
        var tx = px + 16 + thw + 14;
        txt(g, d.name, tx, y + (compact ? 24 : 30), '900 ' + (compact ? 16 : 19) + 'px ' + F_LABEL, C.bone);
        if (d.stats) txt(g, d.stats, tx, y + (compact ? 46 : 54), '400 11px ' + F_LABEL, C.boneDim);
        if (d.locked) {
          var bw2 = 132, bx2 = px + pw - 30 - bw2;
          g.fillStyle = 'rgba(5,12,18,.9)'; g.fillRect(bx2, y + ch / 2 - 12, bw2, 24);
          txt(g, '待开发', bx2 + bw2 / 2, y + ch / 2, '700 10px ' + F_LABEL, C.boneDim, 'center', 'middle');
          g.globalAlpha = 1;
          g.strokeStyle = 'rgba(120,220,255,.1)';
        } else {
          this._addHit('map-' + d.id, px + 16, y, pw - 32, ch);
        }
        if (d.locked) this._addHit('map-locked', px + 16, y, pw - 32, ch);
      }

      // 返回
      var by = py + ph - 46 - 14, bw3 = pw - 44;
      this._addHit('mapback', px + 22, by, bw3, 42);
      g.fillStyle = 'rgba(232,228,218,.04)'; g.fillRect(px + 22, by, bw3, 42);
      g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(px + 22, by, bw3, 42);
      txt(g, '◀ 返回展厅', px + 22 + bw3 / 2, by + 21, '600 14px ' + F_LABEL, C.bone, 'center', 'middle');
    },

    /* ---------- HUD ---------- */
    _drawHUD: function (g) {
      var W = this.W, H = this.H;
      var padL = 16 + S.left, padT = 14 + S.top, padR = S.right, padB = S.bottom;

      // 圈速面板
      var lw = 186, lh = 94;
      g.save();
      g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 12;
      g.fillStyle = C.plate; g.fillRect(padL, padT, lw, lh);
      g.restore();
      g.fillStyle = C.signal; g.fillRect(padL, padT, 3, lh);
      g.fillStyle = 'rgba(45,226,255,.16)'; g.fillRect(padL + 3, padT, lw - 3, 1);
      // 车手名
      txt(g, '车手', padL + 12, padT + 18, '500 9px ' + F_LABEL, C.steel);
      var dn = this.driverName();
      g.font = '700 12px ' + F_NUM;
      while (dn.length > 1 && g.measureText(dn).width > lw - 24) dn = dn.slice(0, -1);
      txt(g, dn, padL + lw - 12, padT + 18, '700 12px ' + F_NUM, C.signal, 'right');
      g.strokeStyle = 'rgba(120,220,255,.18)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL + 10, padT + 25); g.lineTo(padL + lw - 10, padT + 25); g.stroke();
      var rows = [['圈数', this.hud.lap, C.bone], ['单圈', this.hud.time, C.signal], ['最佳', this.hud.best, C.bone]];
      for (var i = 0; i < rows.length; i++) {
        var ry = padT + 41 + i * 19;
        txt(g, rows[i][0], padL + 12, ry, '500 10px ' + F_LABEL, C.steel);
        txt(g, rows[i][1], padL + lw - 12, ry, '700 14px ' + F_NUM, rows[i][2], 'right');
      }

      // 暂停按钮（放到微信胶囊按钮下方，避免被遮挡）
      var padTopY = Math.max(padT, (WIN.__capsule ? WIN.__capsule.bottom + 8 : 0));
      var px = W - padR - 16 - 44;
      this._addHit('pause', px, padTopY, 44, 44);
      g.save();
      g.shadowColor = 'rgba(45,226,255,.35)'; g.shadowBlur = 8;
      cutPath(g, px, padTopY, 44, 44, 8);
      g.fillStyle = 'rgba(6,16,24,.7)'; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.bone; g.fillRect(px + 17, padTopY + 14, 4, 16); g.fillRect(px + 25, padTopY + 14, 4, 16);
      g.fillStyle = C.signal; g.fillRect(px + 4, padTopY + 4, 10, 2);
      g.restore();

      // 中央车速 / 氮气（缩小并压到底部中央，避免挡住车辆）
      var cx = W / 2;
      var sby = H - padB - Math.round(H * 0.20);
      var sp = Math.round(clamp(H * 0.075, 28, 40));
      g.save();
      g.shadowColor = this.hud.drift ? 'rgba(45,226,255,.6)' : 'rgba(0,0,0,.85)';
      g.shadowBlur = this.hud.drift ? 14 : 8;
      txt(g, String(Math.round(this.hud.speed)), cx, sby, 'italic 900 ' + sp + 'px ' + F_NUM,
        this.hud.drift ? C.signal : C.bone, 'center');
      g.restore();
      txt(g, 'KM/H', cx, sby + 13, '500 9px ' + F_NUM, C.steel, 'center');
      var barW = 110;
      g.fillStyle = 'rgba(232,228,218,.16)'; g.fillRect(cx - barW / 2, sby + 20, barW, 2);
      var sg = g.createLinearGradient(cx - barW / 2, 0, cx + barW / 2, 0);
      sg.addColorStop(0, C.steel); sg.addColorStop(1, C.signal);
      g.fillStyle = sg; g.fillRect(cx - barW / 2, sby + 20, barW * this.hud.ratio, 2);

      var nitroReady = this.hud.nitro > 0;
      txt(g, nitroReady ? '氮气 ×1' : '氮气', cx, sby + 34, '600 8px ' + F_LABEL,
        (this.hud.firing || nitroReady) ? C.rust : C.steel, 'center');
      var segW = barW / 12;
      g.save();
      g.translate(cx - barW / 2, sby + 45);
      g.transform(1, 0, -0.32, 1, 0, 0);
      for (var b = 0; b < 12; b++) {
        g.fillStyle = 'rgba(120,220,255,.18)';
        g.fillRect(b * segW, 0, segW - 3, 7);
      }
      var bw = barW * (this.hud.firing ? 1 : this.hud.boost);
      for (var b2 = 0; b2 < 12 && b2 * segW < bw; b2++) {
        g.fillStyle = this.hud.firing ? '#ff9a3a' : (nitroReady ? '#ffc24a' : C.signal);
        if (this.hud.firing) { g.shadowColor = 'rgba(255,140,40,.9)'; g.shadowBlur = 6; }
        g.fillRect(b2 * segW, 0, Math.min(segW - 3, bw - b2 * segW), 7);
        g.shadowBlur = 0;
      }
      g.restore();

      // 左侧转向
      var c;
      c = this.getCtr('left'); this._padBtn(g, 'left', c.x, c.y, c.r * 2, 'L', c.sc);
      c = this.getCtr('right'); this._padBtn(g, 'right', c.x, c.y, c.r * 2, 'R', c.sc);
      c = this.getCtr('reset'); this._resetBtn(g, 'reset', c.x, c.y, c.r, c.sc);

      // 右侧刹车 / 漂移 / 氮气
      c = this.getCtr('brake'); this._brakeBtn(g, 'brake', c.x, c.y, c.r, c.sc);
      c = this.getCtr('drift'); this._driftBtn(g, 'drift', c.x, c.y, c.r, c.sc);
      c = this.getCtr('nitro'); this._nitroBtn(g, c.x, c.y, c.r, c.sc, nitroReady, this.hud.firing);

      // 倒计时
      if (this.cd.label != null) {
        var age = (Date.now() - this.cd.at) / 1000;
        var sc = 1 + Math.max(0, 0.6 - age) * 1.2;
        var alpha = age > 0.75 ? Math.max(0, 1 - (age - 0.75) / 0.15) : 1;
        g.globalAlpha = alpha;
        g.save();
        g.translate(W / 2, H * 0.34); g.scale(sc, sc);
        txt(g, this.cd.label, 0, 0, '900 ' + Math.round(clamp(H * 0.2, 64, 150)) + 'px ' + F_LABEL, C.signal, 'center', 'middle');
        g.restore();
        g.globalAlpha = 1;
      }

      // 漂移提示
      if (this.hud.drift) {
        spaced(g, '漂移', W / 2, H * 0.2, '900 20px ' + F_LABEL, C.signal, 3, 'center');
      }
      // 比赛消息
      if (this.msg.text) {
        g.font = '500 13px ' + F_NUM;
        var mw = g.measureText(this.msg.text).width + 36;
        var mx = W / 2 - mw / 2, my = Math.max(padT + 4, Math.round(H * 0.10));
        g.fillStyle = C.plate; g.fillRect(mx, my, mw, 34);
        g.fillStyle = C.signal; g.fillRect(mx, my, 3, 34);
        txt(g, this.msg.text, W / 2, my + 17, '500 13px ' + F_NUM, C.bone, 'center', 'middle');
      }
    },

    _pressed: function (id) {
      for (var k in this.active) {
        var a = this.active[k];
        if (a && a.btn === id) return true;
      }
      return false;
    },

    // 方向键 C 方案：圆形玻璃 + 大号白色箭头（无文字）
    _padBtn: function (g, id, cx, cy, size, side, sc) {
      var pressed = this._pressed(id);
      var k = sc || 1;
      var r = size / 2;
      this._addHit(id, cx - r, cy - r, r * 2, r * 2, id);
      g.save();
      g.shadowColor = 'rgba(70,170,255,.6)'; g.shadowBlur = pressed ? 22 : 12;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      var gr = g.createRadialGradient(cx, cy - r * 0.4, r * 0.15, cx, cy, r);
      gr.addColorStop(0, pressed ? 'rgba(130,215,255,.50)' : 'rgba(70,150,235,.26)');
      gr.addColorStop(1, pressed ? 'rgba(25,100,190,.40)' : 'rgba(6,28,58,.55)');
      g.fillStyle = gr; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = pressed ? 'rgba(235,252,255,.95)' : 'rgba(160,220,255,.5)';
      g.lineWidth = 1.8; g.stroke();
      g.beginPath(); g.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(160,220,255,.18)'; g.lineWidth = 1; g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.26)'; g.lineWidth = 2 * k;
      g.beginPath(); g.arc(cx, cy, r - 3.5 * k, -2.5, -0.75); g.stroke();

      g.strokeStyle = pressed ? '#ffffff' : 'rgba(245,252,255,.95)';
      g.lineWidth = 8 * k; g.lineCap = 'round'; g.lineJoin = 'round';
      g.shadowColor = 'rgba(120,220,255,.75)'; g.shadowBlur = pressed ? 18 : 6;
      g.beginPath();
      if (side === 'L') { g.moveTo(cx + 14 * k, cy - 17 * k); g.lineTo(cx - 12 * k, cy); g.lineTo(cx + 14 * k, cy + 17 * k); }
      else { g.moveTo(cx - 14 * k, cy - 17 * k); g.lineTo(cx + 12 * k, cy); g.lineTo(cx - 14 * k, cy + 17 * k); }
      g.stroke();
      g.restore();
    },

    // 刹车：蓝色玻璃圆键 + 踏板图标
    _brakeBtn: function (g, id, cx, cy, r, sc) {
      var pressed = this._pressed(id);
      var k = sc || 1;
      this._addHit(id, cx - r, cy - r, r * 2, r * 2, id);
      g.save();
      g.shadowColor = 'rgba(70,170,255,.55)'; g.shadowBlur = pressed ? 20 : 11;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      var gr = g.createRadialGradient(cx, cy - r * 0.35, r * 0.15, cx, cy, r);
      gr.addColorStop(0, pressed ? 'rgba(130,215,255,.50)' : 'rgba(60,135,220,.24)');
      gr.addColorStop(1, pressed ? 'rgba(25,100,190,.42)' : 'rgba(6,26,52,.58)');
      g.fillStyle = gr; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = pressed ? 'rgba(235,252,255,.95)' : 'rgba(160,220,255,.52)';
      g.lineWidth = 1.6; g.stroke();
      g.beginPath(); g.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(160,220,255,.16)'; g.lineWidth = 1; g.stroke();

      // 踏板（正视，垂直居中）
      g.save();
      g.translate(cx, cy);
      var pw = r * 0.46, ph = r * 0.82;
      g.shadowColor = 'rgba(120,220,255,.7)'; g.shadowBlur = 8;
      rr(g, -pw / 2, -ph / 2, pw, ph, 5 * k);
      g.fillStyle = pressed ? '#ffffff' : 'rgba(222,245,255,.95)';
      g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(10,55,100,.7)'; g.lineWidth = 2 * k; g.lineCap = 'round';
      for (var i = -1; i <= 1; i++) {
        g.beginPath();
        g.moveTo(-pw * 0.30, i * ph * 0.20);
        g.lineTo(pw * 0.30, i * ph * 0.20);
        g.stroke();
      }
      g.restore();

      g.restore();
    },

    // 漂移：QQ 飞车风格的大号火焰圆键
    _driftBtn: function (g, id, cx, cy, r, sc) {
      var pressed = this._pressed(id);
      var k = sc || 1;
      this._addHit(id, cx - r, cy - r, r * 2, r * 2, id);
      g.save();
      g.shadowColor = 'rgba(255,120,40,.8)'; g.shadowBlur = pressed ? 30 : 18;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      var gr = g.createRadialGradient(cx, cy - r * 0.45, r * 0.15, cx, cy, r);
      gr.addColorStop(0, pressed ? '#ffe0a8' : '#ffc06a');
      gr.addColorStop(0.5, pressed ? '#ff8a2e' : '#f4681f');
      gr.addColorStop(1, pressed ? '#c83a12' : '#8c240c');
      g.fillStyle = gr; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(255,225,180,.9)'; g.lineWidth = 2; g.stroke();
      g.beginPath(); g.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,240,210,.25)'; g.lineWidth = 1; g.stroke();
      g.strokeStyle = 'rgba(255,240,210,.35)'; g.lineWidth = 3 * k; g.lineCap = 'round';
      g.beginPath(); g.arc(cx, cy + r * 0.08, r * 0.62, 0.35, Math.PI - 0.35); g.stroke();
      txt(g, '漂移', cx, cy - 2, '900 ' + Math.round(r * 0.6) + 'px ' + F_LABEL, '#fff', 'center', 'middle');
      g.restore();
    },

    // 氮气：漂移集满后点亮，手动点击释放一次爆发
    _nitroBtn: function (g, cx, cy, r, sc, ready, firing) {
      var k = sc || 1;
      this._addHit('nitro', cx - r, cy - r, r * 2, r * 2);
      var lit = ready || firing;
      g.save();
      g.shadowColor = lit ? 'rgba(255,170,60,.85)' : 'rgba(0,0,0,.35)';
      g.shadowBlur = lit ? (firing ? 26 : 15) : 6;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      var gr = g.createRadialGradient(cx, cy - r * 0.42, r * 0.15, cx, cy, r);
      if (lit) {
        gr.addColorStop(0, firing ? '#fff6cf' : '#ffe7a6');
        gr.addColorStop(0.55, firing ? '#ffd23a' : '#ffab35');
        gr.addColorStop(1, '#93400b');
      } else {
        gr.addColorStop(0, 'rgba(28,40,50,.88)');
        gr.addColorStop(1, 'rgba(7,13,19,.82)');
      }
      g.fillStyle = gr; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = lit ? 'rgba(255,240,205,.95)' : 'rgba(120,150,170,.34)';
      g.lineWidth = lit ? 2 : 1.4; g.stroke();
      g.beginPath(); g.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
      g.strokeStyle = lit ? 'rgba(255,245,215,.3)' : 'rgba(120,150,170,.14)';
      g.lineWidth = 1; g.stroke();

      // 闪电图标
      g.beginPath();
      g.moveTo(cx + r * 0.13, cy - r * 0.62);
      g.lineTo(cx - r * 0.35, cy + r * 0.06);
      g.lineTo(cx - r * 0.06, cy + r * 0.06);
      g.lineTo(cx - r * 0.17, cy + r * 0.62);
      g.lineTo(cx + r * 0.37, cy - r * 0.10);
      g.lineTo(cx + r * 0.07, cy - r * 0.10);
      g.closePath();
      g.fillStyle = lit ? '#fffdf4' : 'rgba(140,170,190,.42)';
      if (lit) { g.shadowColor = 'rgba(255,220,150,.95)'; g.shadowBlur = 10; }
      g.fill();
      g.restore();
    },

    // 复位按钮：撞墙后把车放回赛道中央并对准赛道方向
    _resetBtn: function (g, id, cx, cy, r, sc) {
      var pressed = this._pressed(id);
      var k = sc || 1;
      this._addHit(id, cx - r, cy - r, r * 2, r * 2, id);
      g.save();
      g.shadowColor = 'rgba(45,226,255,.45)'; g.shadowBlur = pressed ? 16 : 8;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      var gr = g.createRadialGradient(cx, cy - r * 0.3, r * 0.2, cx, cy, r);
      gr.addColorStop(0, pressed ? 'rgba(45,226,255,.32)' : 'rgba(10,24,34,.86)');
      gr.addColorStop(1, pressed ? 'rgba(10,60,80,.5)' : 'rgba(4,10,16,.62)');
      g.fillStyle = gr; g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = pressed ? '#8cf1ff' : 'rgba(120,220,255,.55)';
      g.lineWidth = 1.5; g.stroke();

      // 回转箭头
      var rr = r * 0.48, a0 = -Math.PI * 0.35, a1 = Math.PI * 1.2;
      g.strokeStyle = '#8cf1ff'; g.lineWidth = 2.4 * k; g.lineCap = 'round';
      g.beginPath(); g.arc(cx, cy, rr, a0, a1); g.stroke();
      var ax = cx + Math.cos(a1) * rr, ay = cy + Math.sin(a1) * rr;
      g.beginPath();
      g.moveTo(ax + 6 * k, ay - 1 * k);
      g.lineTo(ax - 4 * k, ay - 4 * k);
      g.lineTo(ax - 1 * k, ay + 6 * k);
      g.closePath(); g.fillStyle = '#8cf1ff'; g.fill();

      g.restore();
    },

    /* ---------- 暂停 ---------- */
    _drawPause: function (g) {
      var W = this.W, H = this.H;
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, W, H);
      var pw = Math.min(420, W - 32), ph = 240;
      var px = W / 2 - pw / 2, py = H / 2 - ph / 2;
      g.fillStyle = C.plateSolid; cutPath(g, px, py, pw, ph, 20); g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.signal; g.fillRect(px, py, pw, 3);
      txt(g, '已暂停', px + 24, py + 44, '900 30px ' + F_LABEL, C.bone);

      var bw = pw - 48, bx = px + 24;
      this._addHit('resume', bx, py + 78, bw, 46);
      g.fillStyle = C.signal; g.fillRect(bx, py + 78, bw, 46);
      txt(g, '继续比赛', bx + bw / 2, py + 101, '800 15px ' + F_LABEL, '#02141a', 'center', 'middle');

      var hw = (bw - 10) / 2;
      this._addHit('restart', bx, py + 134, hw, 42);
      this._addHit('garage', bx + hw + 10, py + 134, hw, 42);
      g.fillStyle = 'rgba(232,228,218,.04)'; g.fillRect(bx, py + 134, hw, 42); g.fillRect(bx + hw + 10, py + 134, hw, 42);
      g.strokeStyle = C.line; g.strokeRect(bx, py + 134, hw, 42); g.strokeRect(bx + hw + 10, py + 134, hw, 42);
      txt(g, '重新开始', bx + hw / 2, py + 155, '600 13px ' + F_LABEL, C.bone, 'center', 'middle');
      txt(g, '回到展厅', bx + hw + 10 + hw / 2, py + 155, '600 13px ' + F_LABEL, C.bone, 'center', 'middle');

      this._addHit('settings', bx, py + 192, 92, 30);
      g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(bx, py + 192, 92, 30);
      txt(g, '设置', bx + 46, py + 207, '600 12px ' + F_LABEL, C.bone, 'center', 'middle');

      txt(g, '画质', bx + 112, py + 206, '500 10px ' + F_LABEL, C.steel);
      var qs = [{ id: 'q-low', t: '低' }, { id: 'q-mid', t: '中' }, { id: 'q-high', t: '高' }];
      var qw = 54, qx = px + pw - 24 - qw * 3 - 2;
      g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(qx, py + 192, qw * 3 + 2, 30);
      for (var i = 0; i < 3; i++) {
        this._addHit(qs[i].id, qx + 1 + i * qw, py + 193, qw, 28);
        var on = qs[i].id === 'q-' + this.quality;
        if (on) { g.fillStyle = C.signal; g.fillRect(qx + 1 + i * qw, py + 193, qw, 28); }
        txt(g, qs[i].t, qx + 1 + i * qw + qw / 2, py + 207, '600 12px ' + F_LABEL, on ? '#1a1206' : C.boneDim, 'center', 'middle');
      }
    },

    /* ---------- 结算 ---------- */
    _drawFinish: function (g) {
      var W = this.W, H = this.H;
      var laps = this.finish.laps || [];
      g.fillStyle = 'rgba(0,0,0,.58)'; g.fillRect(0, 0, W, H);
      var pw = Math.min(420, W - 32);
      var ph = 250 + Math.max(1, laps.length) * 30;
      var px = W / 2 - pw / 2, py = Math.max(12, H / 2 - ph / 2);
      g.fillStyle = C.plateSolid; cutPath(g, px, py, pw, ph, 20); g.fill();
      g.strokeStyle = C.line; g.lineWidth = 1; g.stroke();
      g.fillStyle = C.signal; g.fillRect(px, py, pw, 3);
      txt(g, '完赛成绩', px + 24, py + 28, '600 10px ' + F_LABEL, C.signal);
      txt(g, this.finish.map || '海港岸线', px + 24, py + 60, '900 28px ' + F_LABEL, C.bone);
      var dn = '车手 ' + this.driverName();
      g.font = '600 11px ' + F_LABEL;
      while (dn.length > 2 && g.measureText(dn).width > pw * 0.42) dn = dn.slice(0, -1);
      txt(g, dn, px + pw - 24, py + 60, '600 11px ' + F_LABEL, C.signal, 'right');

      var bestI = 0;
      for (var i = 1; i < laps.length; i++) if (laps[i] < laps[bestI]) bestI = i;
      var ry = py + 78;
      for (var j = 0; j < laps.length; j++) {
        var best = j === bestI;
        txt(g, '第 ' + (j + 1) + ' 圈' + (best ? ' ◆' : ''), px + 24, ry, '500 13px ' + F_LABEL, best ? C.signal : C.boneDim);
        txt(g, fmt(laps[j]), px + pw - 24, ry, '700 13px ' + F_NUM, best ? C.signal : C.bone, 'right');
        g.strokeStyle = 'rgba(120,220,255,.22)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(px + 24, ry + 9); g.lineTo(px + pw - 24, ry + 9); g.stroke();
        ry += 30;
      }
      txt(g, '总计', px + 24, ry + 14, '500 13px ' + F_LABEL, C.boneDim);
      txt(g, fmt(this.finish.total), px + pw - 24, ry + 14, '800 16px ' + F_NUM, C.signal, 'right');

      var bx = px + 24, bw = pw - 48;
      this._addHit('again', bx, ry + 34, bw, 44);
      g.fillStyle = C.signal; g.fillRect(bx, ry + 34, bw, 44);
      txt(g, '再来一局', bx + bw / 2, ry + 56, '800 15px ' + F_LABEL, '#02141a', 'center', 'middle');
      this._addHit('finishGarage', bx, ry + 86, bw, 40);
      g.fillStyle = 'rgba(232,228,218,.04)'; g.fillRect(bx, ry + 86, bw, 40);
      g.strokeStyle = C.line; g.strokeRect(bx, ry + 86, bw, 40);
      txt(g, '回到展厅', bx + bw / 2, ry + 106, '600 13px ' + F_LABEL, C.bone, 'center', 'middle');
    },

    /* ---------- 提示 ---------- */
    _drawToast: function (g) {
      var W = this.W, H = this.H;
      g.font = '500 12px ' + F_LABEL;
      var tw = g.measureText(this.toastMsg.text).width + 32;
      var x = W / 2 - tw / 2, y = H - 168;
      g.fillStyle = 'rgba(5,12,18,.9)'; g.fillRect(x, y, tw, 32);
      g.fillStyle = C.signal; g.fillRect(x, y, 3, 32);
      txt(g, this.toastMsg.text, W / 2, y + 16, '500 12px ' + F_LABEL, C.bone, 'center', 'middle');
    },
    _drawFatal: function (g) {
      var W = this.W, H = this.H;
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(0, 0, W, H);
      txt(g, this.fatalMsg, W / 2, H / 2, '600 13px ' + F_LABEL, C.alarm, 'center', 'middle');
    }
  };
})();

var WIN = GameGlobal;
var THREE = WIN.THREE;
var G = WIN.G;

/* ============================================================
 * 巴音布鲁克的干 —— game.world.js
 * 写实化资产层（全部程序化，零外部贴图）：
 *   W1 可平铺噪声 · W2 PBR 贴图工厂（albedo / normal / roughness 一次生成）
 *   W3 几何构建器（世界尺度 UV + 顶点色 + 合并为单 DrawCall）
 *   W4 海港街道赛：路面/路肩/白线/混凝土墙/防碎网/起跑灯架/看台/观众
 *   W5 集装箱码头：岸壁/岸桥/轮胎吊/堆场/货轮/高杆灯/建筑
 *   W6 远景：斜拉桥、对岸城市天际线、远山、锚地船只
 * 尺度全部按真实世界：40 尺箱 12.19×2.59×2.44m、岸桥轨距 30.5m、主梁高 48m、货轮 300m。
 * ============================================================ */
(function () {
'use strict';
var TAU = Math.PI * 2;
G.WATER_Y = -3.2;

/* ---------- W1. 可平铺噪声（周期边界，贴图无缝） ---------- */
G.SS = function (a, b, x) { var t = (x - a) / (b - a); t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); };
G.pHash = function (x, y, s) { var h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
G.pNoise = function (x, y, px, py, s) {
  var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  var x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  var a = G.pHash(x0, y0, s), b = G.pHash(x1, y0, s), c = G.pHash(x0, y1, s), d = G.pHash(x1, y1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
// u,v ∈ [0,1) 的贴图空间分形噪声；p 为基础周期（整数）
G.pFbm = function (u, v, p, oct, s) {
  var a = 0.5, f = 1, sum = 0, nrm = 0;
  for (var i = 0; i < oct; i++) { sum += a * G.pNoise(u * p * f, v * p * f, p * f, p * f, s + i * 13); nrm += a; a *= 0.5; f *= 2; }
  return sum / nrm;
};
G.rng = function (seed) {
  var a = seed | 0;
  return function () {
    a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};

/* ---------- W2. PBR 贴图工厂 ---------- */
G.PBR = {
  cache: {},
  _tex: function (data, w, h, srgb) {
    var t = new THREE.DataTexture(new Uint8Array(data.buffer), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = 8;
    if (srgb) t.encoding = THREE.sRGBEncoding;
    t.needsUpdate = true;
    return t;
  },
  // 高度场 -> 切线空间法线（周期边界）；k 为凹凸强度
  _normal: function (hg, w, h, k) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var l = hg[y * w + (x - 1 + w) % w], r = hg[y * w + (x + 1) % w];
      var dn = hg[((y - 1 + h) % h) * w + x], up = hg[((y + 1) % h) * w + x];
      var nx = (l - r) * k, ny = (dn - up) * k, il = 1 / Math.sqrt(nx * nx + ny * ny + 1), i = (y * w + x) * 4;
      out[i] = (nx * il * 0.5 + 0.5) * 255; out[i + 1] = (ny * il * 0.5 + 0.5) * 255;
      out[i + 2] = (il * 0.5 + 0.5) * 255; out[i + 3] = 255;
    }
    return out;
  },
  // fn(u, v, o, x, y)：写入 o.r/o.g/o.b（sRGB 0..1）、o.h（高度）、o.ro（粗糙度）；行 0 = v 0（贴图底部）
  make: function (key, w, h, bump, fn) {
    if (this.cache[key]) return this.cache[key];
    var alb = new Uint8ClampedArray(w * h * 4), rou = new Uint8ClampedArray(w * h * 4), hg = new Float32Array(w * h);
    var o = { r: 0, g: 0, b: 0, h: 0, ro: 1 };
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      fn(x / w, y / h, o, x, y);
      var i = y * w + x, j = i * 4;
      alb[j] = o.r * 255; alb[j + 1] = o.g * 255; alb[j + 2] = o.b * 255; alb[j + 3] = 255;
      rou[j] = rou[j + 1] = rou[j + 2] = o.ro * 255; rou[j + 3] = 255;
      hg[i] = o.h;
    }
    var res = { map: this._tex(alb, w, h, true), roughnessMap: this._tex(rou, w, h, false),
      normalMap: this._tex(this._normal(hg, w, h, bump), w, h, false) };
    this.cache[key] = res;
    return res;
  },
  // 沥青：骨料颗粒 + 黏结料 + 裂缝填缝（灌缝沥青更黑更亮）；一个周期 6m
  asphalt: function () {
    return this.make('asphalt', 512, 512, 1.4, function (u, v, o, x, y) {
      var big = G.pFbm(u, v, 4, 3, 11);
      var stone = G.pNoise(u * 150, v * 150, 150, 150, 3), stone2 = G.pNoise(u * 330, v * 330, 330, 330, 5);
      var px = G.pHash(x, y, 9);
      var st = G.SS(0.55, 0.85, stone * 0.62 + stone2 * 0.5 - 0.06);
      var seal = 0;
      var g = (0.33 + (big - 0.5) * 0.05 + (px - 0.5) * 0.04 + st * 0.09) * (1 - seal * 0.35);
      o.r = g; o.g = g * 0.995; o.b = g * 1.0;
      o.h = st * 0.55 + px * 0.25 + stone2 * 0.2 - seal * 0.05;
      o.ro = 0.95 - st * 0.08;
    });
  },
  // 混凝土：大块水渍 + 中频斑驳 + 气孔；一个周期 4m
  concrete: function () {
    return this.make('concrete', 512, 512, 1.6, function (u, v, o, x, y) {
      var big = G.pFbm(u, v, 3, 4, 31), mid = G.pFbm(u, v, 12, 3, 37);
      var p = G.SS(0.78, 0.9, G.pNoise(u * 160, v * 160, 160, 160, 41)), px = G.pHash(x, y, 43);
      var g = 0.6 + (big - 0.5) * 0.18 + (mid - 0.5) * 0.08 + (px - 0.5) * 0.04 - p * 0.16;
      o.r = g; o.g = g * 0.985; o.b = g * 0.955;
      o.h = 0.5 + (mid - 0.5) * 0.3 + px * 0.12 - p * 0.5;
      o.ro = 0.9 + (px - 0.5) * 0.08;
    });
  },
  // 赛道混凝土护墙：4m 一节（v=0 处接缝）+ 底部轮胎擦痕（u 为剖面方向）
  barrier: function () {
    return this.make('barrier', 512, 512, 1.8, function (u, v, o, x, y) {
      var big = G.pFbm(u, v, 3, 4, 61), mid = G.pFbm(u, v, 10, 3, 67), px = G.pHash(x, y, 69);
      var j = Math.min(v, 1 - v) * 4;                               // 距接缝米数
      var joint = G.SS(0.018, 0.006, j);
      var rub = G.SS(0.6, 0.85, G.pNoise(u * 40, v * 3, 40, 3, 71) * 0.6 + G.pFbm(u, v, 6, 3, 73) * 0.4) * G.SS(0.14, 0.05, u) * G.SS(0.0, 0.02, u);
      var g = (0.72 + (big - 0.5) * 0.14 + (mid - 0.5) * 0.06 + (px - 0.5) * 0.03) * (1 - joint * 0.6) * (1 - rub * 0.45);
      o.r = g; o.g = g * 0.99; o.b = g * 0.97;
      o.h = 0.6 - joint * 0.6 + (mid - 0.5) * 0.2 + px * 0.06;
      o.ro = 0.85 - rub * 0.3 + (px - 0.5) * 0.06;
    });
  },
  // 涂装钢结构：雨痕竖纹 + 钢板焊缝（1m）+ 零星锈斑；白色底，靠顶点色染色
  paint: function () {
    return this.make('paint', 512, 512, 1.2, function (u, v, o, x, y) {
      var big = G.pFbm(u, v, 3, 4, 51);
      var streak = G.pNoise(u * 64, v * 3, 64, 3, 53);
      var rust = G.SS(0.78, 0.9, G.pFbm(u, v, 8, 3, 57));
      var fv = (v * 4) % 1, seam = G.SS(0.014, 0.0, Math.min(fv, 1 - fv));
      var g = 0.93 - (big - 0.5) * 0.07 - G.SS(0.55, 0.9, streak) * 0.09 - seam * 0.12;
      o.r = G.LERP(g, 0.46, rust); o.g = G.LERP(g, 0.3, rust); o.b = G.LERP(g, 0.2, rust);
      o.h = 0.5 - seam * 0.5 + rust * 0.12;
      o.ro = 0.42 + (big - 0.5) * 0.1 + streak * 0.1 + rust * 0.4;
    });
  },
  // 彩钢瓦楞墙板（仓库外墙）：竖向梯形波纹 0.25m 一个周期（贴图周期 4m = 16 波）
  cladding: function () {
    return this.make('cladding', 512, 512, 3.2, function (u, v, o, x, y) {
      var f = (u * 16) % 1, prof = f < 0.12 ? f / 0.12 : (f < 0.45 ? 1 : (f < 0.57 ? 1 - (f - 0.45) / 0.12 : 0));
      var big = G.pFbm(u, v, 3, 3, 81), streak = G.pNoise(u * 64, v * 2, 64, 2, 83);
      var g = 0.86 - (big - 0.5) * 0.08 - G.SS(0.6, 0.9, streak) * 0.08 - (1 - v) * 0.05;
      o.r = g; o.g = g; o.b = g;
      o.h = prof; o.ro = 0.5 + streak * 0.1;
    });
  },
  // 路肩：红白 1m 条纹（u 横向、v 沿线 2m 一周期）+ 轮胎橡胶痕
  kerb: function () {
    return this.make('kerb', 128, 256, 2.0, function (u, v, o, x, y) {
      var red = v < 0.5, px = G.pHash(x, y, 91);
      var rub = G.SS(0.45, 0.75, G.pFbm(u, v, 4, 3, 93)) * 0.5;
      var edge = G.SS(0.03, 0.0, Math.min(Math.abs(v - 0.5), Math.min(v, 1 - v)));
      var r = red ? 0.68 : 0.86, g = red ? 0.14 : 0.85, b = red ? 0.11 : 0.82;
      var k = (1 - rub) * (0.94 + px * 0.08) * (1 - edge * 0.3);
      o.r = r * k; o.g = g * k; o.b = b * k;
      o.h = 0.5 + px * 0.2 - edge * 0.3; o.ro = 0.5 + rub * 0.3;
    });
  },
  waterNormal: function () {
    if (this.cache.water) return this.cache.water;
    var w = 256, hg = new Float32Array(w * w);
    for (var y = 0; y < w; y++) for (var x = 0; x < w; x++) {
      var u = x / w, v = y / w;
      hg[y * w + x] = G.pFbm(u, v, 4, 5, 101) * 0.7 + G.pNoise(u * 24, v * 24, 24, 24, 107) * 0.3;
    }
    var t = this._tex(this._normal(hg, w, w, 14), w, w, false);
    this.cache.water = t;
    return t;
  },
  // 集装箱瓦楞法线/粗糙度（全品牌共享）：u∈[0,0.8) 侧板（44 道波纹），u∈[0.8,1] 箱门
  containerNR: function () {
    if (this.cache.ctrNR) return this.cache.ctrNR;
    var W = 1024, H = 256, SIDE = 819, hg = new Float32Array(W * H), rou = new Uint8ClampedArray(W * H * 4);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var h, v = y / H, rail = v < 0.045 || v > 0.955;
      if (x < SIDE) {
        var f = (x / (SIDE / 44)) % 1;
        h = f < 0.14 ? f / 0.14 : (f < 0.5 ? 1 : (f < 0.64 ? 1 - (f - 0.5) / 0.14 : 0));
        if (x < 8 || x > SIDE - 9) h = 1.2;
      } else {
        var lx = (x - SIDE) / (W - SIDE), fd = (lx * 18) % 1;
        h = 0.5 + 0.3 * Math.sin(fd * TAU);
        var bars = [0.18, 0.36, 0.64, 0.82];
        for (var b = 0; b < 4; b++) if (Math.abs(lx - bars[b]) < 0.012) h = 1.6;
        if (lx < 0.03 || lx > 0.97 || Math.abs(lx - 0.5) < 0.004) h = 1.2;
      }
      if (rail) h = 1.4;
      hg[y * W + x] = h * 0.5;
      var j = (y * W + x) * 4; rou[j] = rou[j + 1] = rou[j + 2] = (0.5 + G.pHash(x, y, 7) * 0.12) * 255; rou[j + 3] = 255;
    }
    var nr = { normalMap: this._tex(this._normal(hg, W, H, 2.4), W, H, false), roughnessMap: this._tex(rou, W, H, false) };
    nr.normalMap.wrapS = nr.normalMap.wrapT = nr.roughnessMap.wrapS = nr.roughnessMap.wrapT = THREE.ClampToEdgeWrapping;
    this.cache.ctrNR = nr;
    return nr;
  },
  // 集装箱品牌涂装（Canvas 绘制 logo/箱号/箱门，再逐像素做风化：底部积尘、雨痕、锈斑、顶部褪色）
  container: function (br) {
    var key = 'ctr_' + br.id;
    if (this.cache[key]) return this.cache[key];
    var W = 1024, H = 256, SIDE = 819, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = br.base; g.fillRect(0, 0, W, H);
    g.save(); g.fillStyle = br.text; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '900 92px "Arial Black", "Helvetica Neue", Arial, sans-serif';
    var tw = g.measureText(br.name).width, sc = Math.min(1, 370 / tw);
    g.translate(410, 136); g.scale(sc, 1); g.fillText(br.name, 0, 0); g.restore();
    g.fillStyle = br.text; g.textAlign = 'right'; g.font = '700 17px Arial, sans-serif';
    g.fillText(br.code + 'U ' + (100000 + ((br.name.length * 7919) % 899999)) + ' 3', SIDE - 18, 30);
    g.fillText('45G1', SIDE - 18, 52);
    var dx = SIDE, dw = W - SIDE;
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(dx + dw / 2 - 1, 8, 2, H - 16);
    g.fillStyle = 'rgba(220,220,215,0.55)';
    [0.18, 0.36, 0.64, 0.82].forEach(function (f) { g.fillRect(dx + f * dw - 2, 8, 4, H - 16); });
    g.fillStyle = 'rgba(0,0,0,0.5)';
    [0.18, 0.36, 0.64, 0.82].forEach(function (f) { g.fillRect(dx + f * dw - 7, 128, 14, 6); });
    g.fillStyle = br.text; g.textAlign = 'center'; g.font = '700 15px Arial, sans-serif';
    g.fillText(br.name, dx + dw * 0.27, 34);
    var img = g.getImageData(0, 0, W, H), d = img.data;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var u = x / W, vv = y / H, i = (y * W + x) * 4;
      var grime = G.SS(0.55, 1.0, vv) * 0.28;
      var st = G.SS(0.58, 0.86, G.pNoise(u * 140, vv * 2.5, 140, 3, br.seed)) * 0.16 * (0.4 + vv);
      var rust = G.SS(0.8, 0.9, G.pFbm(u, vv, 10, 3, br.seed + 5)) * 0.85;
      var dent = (G.pFbm(u, vv, 5, 2, br.seed + 9) - 0.5) * 0.08;
      var m = (1 - grime - st + dent) * (1 + (1 - vv) * 0.07) + (G.pHash(x, y, br.seed) - 0.5) * 0.03;
      d[i] = G.LERP(d[i] * m, 118, rust); d[i + 1] = G.LERP(d[i + 1] * m, 70, rust); d[i + 2] = G.LERP(d[i + 2] * m, 44, rust);
    }
    g.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    this.cache[key] = t;
    return t;
  },
  // 防碎网（菱形钢丝网，带 alpha）
  chainlink: function () {
    if (this.cache.chain) return this.cache.chain;
    var cv = document.createElement('canvas'); cv.width = cv.height = 64;
    var g = cv.getContext('2d');
    g.strokeStyle = 'rgba(150,156,160,1)'; g.lineWidth = 2.2;
    for (var k = -1; k <= 1; k++) {
      g.beginPath(); g.moveTo(k * 64, 0); g.lineTo(k * 64 + 64, 64); g.stroke();
      g.beginPath(); g.moveTo(k * 64 + 64, 0); g.lineTo(k * 64, 64); g.stroke();
    }
    var t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.encoding = THREE.sRGBEncoding;
    this.cache.chain = t;
    return t;
  },
  // 赞助商广告图集：8 行（每行一个虚构品牌，横向 2048 = 12m 一块墙板）
  sponsors: function () {
    if (this.cache.sponsors) return this.cache.sponsors;
    var cv = document.createElement('canvas'); cv.width = 2048; cv.height = 1024;
    var g = cv.getContext('2d');
    var rows = [
      ['#0d0f12', '#ffb347', 'WILL GP', 'stripe'], ['#f2f0ea', '#c8102e', 'APEX ENERGY', 'swoosh'],
      ['#1f3a5c', '#f2f0ea', 'SALTLINE LOGISTICS', 'none'], ['#f2c230', '#111111', 'NOVA TYRES', 'chev'],
      ['#0f6e6e', '#f2f0ea', 'BAYSIDE BANK', 'none'], ['#b0181f', '#f8f6f0', 'KESTREL OIL', 'stripe'],
      ['#2b2d7a', '#f2f0ea', 'ORBIT TELECOM', 'dots'], ['#26292d', '#f2f0ea', 'HARBOR LINE', 'checker']
    ];
    for (var r = 0; r < 8; r++) {
      var y0 = r * 128, R = rows[r];
      g.fillStyle = R[0]; g.fillRect(0, y0, 2048, 128);
      g.fillStyle = R[1];
      if (R[3] === 'stripe') { g.fillRect(0, y0 + 112, 2048, 8); g.fillRect(0, y0 + 8, 2048, 4); }
      if (R[3] === 'chev') for (var cx = 0; cx < 2048; cx += 64) { g.beginPath(); g.moveTo(cx, y0 + 100); g.lineTo(cx + 24, y0 + 114); g.lineTo(cx, y0 + 128); g.fill(); }
      if (R[3] === 'checker') for (var q = 0; q < 2048; q += 32) { g.fillRect(q, y0 + ((q / 32) % 2 ? 0 : 16), 16, 16); g.fillRect(q + 16, y0 + ((q / 32) % 2 ? 16 : 0), 16, 16); }
      if (R[3] === 'dots') for (var dd = 0; dd < 2048; dd += 40) { g.beginPath(); g.arc(dd + 20, y0 + 116, 4, 0, TAU); g.fill(); }
      g.font = '900 86px "Arial Black", "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (var k = 0; k < 2; k++) {
        g.save(); g.translate(512 + k * 1024, y0 + 66); g.scale(0.92, 1);
        if (R[3] === 'swoosh') { g.fillStyle = R[1]; g.beginPath(); g.ellipse(-440, 0, 46, 18, -0.4, 0, TAU); g.fill(); }
        g.fillStyle = R[1]; g.fillText(R[2], 0, 0); g.restore();
      }
    }
    var t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    this.cache.sponsors = t;
    return t;
  },
  // 玻璃幕墙/窗格（map + emissiveMap）：一个周期 12m × 12m（3 层 × 4 跨）
  windows: function (lit) {
    var key = 'win' + lit;
    if (this.cache[key]) return this.cache[key];
    var make = function (emissive) {
      var cv = document.createElement('canvas'); cv.width = 256; cv.height = 256;
      var g = cv.getContext('2d'), rnd = G.rng(77);
      // 玻璃幕墙：深色镀膜玻璃 + 竖向铝框 + 每层层间窗槛墙（spandrel）
      g.fillStyle = emissive ? '#000' : '#38434d'; g.fillRect(0, 0, 256, 256);
      for (var fy = 0; fy < 3; fy++) {
        var y0 = fy * 85;
        if (!emissive) {
          var grd = g.createLinearGradient(0, y0, 0, y0 + 85);
          grd.addColorStop(0, '#46525d'); grd.addColorStop(1, '#2c353e');
          g.fillStyle = grd; g.fillRect(0, y0, 256, 85);
          g.fillStyle = '#6d747a'; g.fillRect(0, y0 + 70, 256, 15);
        }
        for (var fx = 0; fx < 8; fx++) {
          var on = rnd() < lit, warm = rnd() < 0.75, x = fx * 32 + 2, y = y0 + 4;
          if (emissive) { g.fillStyle = on ? (warm ? 'rgb(255,200,140)' : 'rgb(200,220,255)') : '#000'; g.fillRect(x + 2, y + 6, 26, 56); }
          else if (on) { g.fillStyle = warm ? 'rgba(220,190,150,0.55)' : 'rgba(180,200,225,0.5)'; g.fillRect(x + 2, y + 6, 26, 56); }
        }
        if (!emissive) { g.fillStyle = '#8b9298'; for (var mx = 0; mx <= 256; mx += 32) g.fillRect(mx - 1, y0, 3, 85); }
      }
      var t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
      return t;
    };
    var res = { map: make(false), emissiveMap: make(true) };
    this.cache[key] = res;
    return res;
  },
  // 文字贴片（船名、距离牌）：透明底
  label: function (text, w, h, color, bg, font) {
    var key = 'lbl_' + text + w + h + color + bg;
    if (this.cache[key]) return this.cache[key];
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = font || ('900 ' + Math.round(h * 0.7) + 'px "Arial Black", Arial, sans-serif');
    var tw = g.measureText(text).width, sc = Math.min(1, w * 0.92 / tw);
    g.save(); g.translate(w / 2, h / 2 + h * 0.03); g.scale(sc, 1); g.fillText(text, 0, 0); g.restore();
    var t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 8;
    this.cache[key] = t;
    return t;
  },
  // 车底接触阴影（径向渐变）
  contact: function () {
    if (this.cache.contact) return this.cache.contact;
    var cv = document.createElement('canvas'); cv.width = 128; cv.height = 256;
    var g = cv.getContext('2d');
    var grd = g.createRadialGradient(64, 128, 10, 64, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.92)'); grd.addColorStop(0.45, 'rgba(0,0,0,0.6)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.save(); g.scale(1, 1); g.fillStyle = grd; g.fillRect(0, 0, 128, 256); g.restore();
    var t = new THREE.CanvasTexture(cv);
    this.cache.contact = t;
    return t;
  }
};

G.CONTAINER_BRANDS = [
  { id: 'saltline', name: 'SALTLINE', code: 'SLT', base: '#22405f', text: '#ecebe4', w: 3, seed: 201 },
  { id: 'hansa', name: 'HANSA BAY', code: 'HBA', base: '#c25e27', text: '#f3f0e8', w: 2, seed: 211 },
  { id: 'everwave', name: 'EVERWAVE', code: 'EVW', base: '#2f5a40', text: '#ecebe4', w: 2, seed: 221 },
  { id: 'oceanix', name: 'OCEANIX', code: 'OCX', base: '#6a9cc4', text: '#f6f6f2', w: 2, seed: 231 },
  { id: 'meridian', name: 'MERIDIAN', code: 'MRD', base: '#7a2b25', text: '#efe9df', w: 2, seed: 241 },
  { id: 'tritan', name: 'TRITAN', code: 'TRT', base: '#8a8f94', text: '#1c1e21', w: 2, seed: 251 },
  { id: 'willlog', name: 'WILL LOGISTICS', code: 'WLL', base: '#dcd7cb', text: '#22405f', w: 1, seed: 261 },
  { id: 'kestrel', name: 'KESTREL', code: 'KST', base: '#c79b2e', text: '#1d1e20', w: 1, seed: 271 }
];

/* ---------- W3. 几何构建器 ---------- */
G.scaleUV = function (g, su, sv) {
  var uv = g.attributes.uv;
  for (var i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
};
// BoxGeometry 每个面的 UV 按真实尺寸缩放（s 米一个贴图周期），贴图密度处处一致
G.boxUV = function (g, w, h, d, s) {
  var uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (var f = 0; f < 6; f++) for (var k = 0; k < 4; k++) {
    var i = f * 4 + k;
    uv.setXY(i, uv.getX(i) * dims[f][0] / s, uv.getY(i) * dims[f][1] / s);
  }
  return g;
};
G.mergeGeos = function (geos) {
  var list = [], total = 0, i, hasColor = true;
  for (i = 0; i < geos.length; i++) {
    var g = geos[i].index ? geos[i].toNonIndexed() : geos[i];
    if (!g.attributes.normal) g.computeVertexNormals();
    list.push(g); total += g.attributes.position.count;
    if (!g.attributes.color) hasColor = false;
  }
  var pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  var col = hasColor ? new Float32Array(total * 3) : null, o = 0;
  for (i = 0; i < list.length; i++) {
    var a = list[i].attributes, n = a.position.count;
    pos.set(a.position.array, o * 3); nor.set(a.normal.array, o * 3);
    if (a.uv) uv.set(a.uv.array, o * 2);
    if (col) col.set(a.color.array, o * 3);
    o += n;
  }
  var out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
};
var _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _m = new THREE.Matrix4();
var _one = new THREE.Vector3(1, 1, 1), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();
var _Z = new THREE.Vector3(0, 0, 1);
// 构建器：所有零件带顶点色（材质用 vertexColors 染色），最终合并为一个 Mesh
G.GB = function (uvScale) { this.geos = []; this.col = new THREE.Color(1, 1, 1); this.s = uvScale || 4; };
G.GB.prototype = {
  c: function (hex) { this.col.set(hex); return this; },
  _put: function (g, m) {
    if (m) g.applyMatrix4(m);
    var n = g.attributes.position.count, cc = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) { cc[i * 3] = this.col.r; cc[i * 3 + 1] = this.col.g; cc[i * 3 + 2] = this.col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    if (!g.attributes.normal) g.computeVertexNormals();
    this.geos.push(g);
    return this;
  },
  _mat: function (x, y, z, rx, ry, rz) {
    _e.set(rx || 0, ry || 0, rz || 0, 'YXZ'); _q.setFromEuler(_e); _v.set(x || 0, y || 0, z || 0);
    return _m.compose(_v, _q, _one);
  },
  box: function (w, h, d, x, y, z, rx, ry, rz) {
    var g = new THREE.BoxGeometry(w, h, d); G.boxUV(g, w, h, d, this.s);
    return this._put(g, this._mat(x, y, z, rx, ry, rz));
  },
  cyl: function (rt, rb, h, seg, x, y, z, rx, ry, rz) {
    var g = new THREE.CylinderGeometry(rt, rb, h, seg || 12, 1);
    G.scaleUV(g, TAU * Math.max(rt, rb) / this.s, h / this.s);
    return this._put(g, this._mat(x, y, z, rx, ry, rz));
  },
  // 两点间方截面构件（斜撑、拉索、桁架腹杆）
  beam: function (ax, ay, az, bx, by, bz, w, h) {
    _a.set(ax, ay, az); _b.set(bx, by, bz);
    var len = Math.max(0.01, _a.distanceTo(_b)), g = new THREE.BoxGeometry(w, h || w, len);
    G.boxUV(g, w, h || w, len, this.s);
    _d.subVectors(_b, _a).normalize(); _q.setFromUnitVectors(_Z, _d);
    _v.addVectors(_a, _b).multiplyScalar(0.5);
    return this._put(g, _m.compose(_v, _q, _one));
  },
  geo: function (g, m) { return this._put(g, m || null); },
  mesh: function (mat, cast, recv) {
    var me = new THREE.Mesh(G.mergeGeos(this.geos), mat);
    this.geos = [];
    me.castShadow = cast !== false; me.receiveShadow = recv !== false;
    return me;
  }
};
// 无实例化兜底：把每个实例的变换/颜色烘焙进一张合并网格（真机部分 WebGL1 上下文里
// InstancedMesh 画不出来，树/石头/路桩会整片消失，这里退化为普通 Mesh）
G.bakedInstances = function (geo, mat, list, cast) {
  var pA = geo.attributes.position, nA = geo.attributes.normal, uA = geo.attributes.uv, cA = geo.attributes.color;
  var ix = geo.index, vc = pA.count, cnt = list.length, i, t;
  var pos = new Float32Array(vc * cnt * 3);
  var nor = nA ? new Float32Array(vc * cnt * 3) : null;
  var uvs = uA ? new Float32Array(vc * cnt * 2) : null;
  var cols = cA ? new Float32Array(vc * cnt * 3) : null;   // 几何自带的顶点色（白柱黑带、云杉明暗）需要保留
  var faces = ix ? ix.count : vc;
  var out = ix ? new (vc * cnt > 65535 ? Uint32Array : Uint16Array)(faces * cnt) : null;
  var q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
  var m = new THREE.Matrix4(), nm = new THREE.Matrix3(), col = new THREE.Color();
  var ar = 0, ag = 0, ab = 0, tinted = false;
  for (t = 0; t < cnt; t++) {
    var L = list[t];
    e.set(0, L[3] || 0, 0); q.setFromEuler(e); v.set(L[0], L[1], L[2]);
    s.set(L[4] == null ? 1 : L[4], L[5] == null ? 1 : L[5], L[6] == null ? 1 : L[6]);
    m.compose(v, q, s);
    if (nor) nm.getNormalMatrix(m);
    var me = m.elements, ne = nm.elements;
    if (L[7] != null) { if (L[7].isColor) col.copy(L[7]); else col.set(L[7]); ar += col.r; ag += col.g; ab += col.b; tinted = true; }
    var base = t * vc;
    for (i = 0; i < vc; i++) {
      var x = pA.getX(i), y = pA.getY(i), z = pA.getZ(i), o3 = (base + i) * 3;
      pos[o3] = me[0] * x + me[4] * y + me[8] * z + me[12];
      pos[o3 + 1] = me[1] * x + me[5] * y + me[9] * z + me[13];
      pos[o3 + 2] = me[2] * x + me[6] * y + me[10] * z + me[14];
      if (nor) {
        var nx = nA.getX(i), ny = nA.getY(i), nz = nA.getZ(i);
        var tx = ne[0] * nx + ne[3] * ny + ne[6] * nz;
        var ty = ne[1] * nx + ne[4] * ny + ne[7] * nz;
        var tz = ne[2] * nx + ne[5] * ny + ne[8] * nz;
        var il = 1 / (Math.sqrt(tx * tx + ty * ty + tz * tz) || 1);
        nor[o3] = tx * il; nor[o3 + 1] = ty * il; nor[o3 + 2] = tz * il;
      }
      if (uvs) { uvs[(base + i) * 2] = uA.getX(i); uvs[(base + i) * 2 + 1] = uA.getY(i); }
      if (cols) { cols[o3] = cA.getX(i); cols[o3 + 1] = cA.getY(i); cols[o3 + 2] = cA.getZ(i); }
    }
    if (out) for (i = 0; i < faces; i++) out[t * faces + i] = ix.getX(i) + base;
  }
  var bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) bg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uvs) bg.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (cols) bg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  if (out) bg.setIndex(new THREE.BufferAttribute(out, 1));
  bg.computeBoundingSphere();
  var mm = mat.clone();
  // Material.clone() 不会复制自有属性上的着色器钩子，地形/岩石/水面的 onBeforeCompile 必须手动带上，
  // 否则烘焙后这些材质会退化成“无贴图的纯色材质”（石头发白正是这个原因）
  if (mat.onBeforeCompile && mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) mm.onBeforeCompile = mat.onBeforeCompile;
  if (mat.customProgramCacheKey && mat.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) mm.customProgramCacheKey = mat.customProgramCacheKey;
  // 实例色不做逐顶点属性（部分真机上不生效，石头会发白），改成把该块平均色调乘进材质颜色
  if (tinted) { mm.color = (mm.color ? mm.color.clone() : new THREE.Color(1, 1, 1)).multiply(new THREE.Color(ar / cnt, ag / cnt, ab / cnt)); }
  mm.needsUpdate = true;
  var mesh = new THREE.Mesh(bg, mm);
  mesh.castShadow = cast !== false; mesh.receiveShadow = true;
  return mesh;
};
// 实例化辅助：list = [[x, y, z, yaw, sx, sy, sz, colorHex|Color]]
G.instanced = function (geo, mat, list, cast) {
  if (WIN.__noInst) return G.bakedInstances(geo, mat, list, cast);
  var im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length)), col = new THREE.Color();
  for (var i = 0; i < list.length; i++) {
    var L = list[i];
    _e.set(0, L[3] || 0, 0); _q.setFromEuler(_e); _v.set(L[0], L[1], L[2]);
    im.setMatrixAt(i, _m.compose(_v, _q, _b.set(L[4] || 1, L[5] || 1, L[6] || 1)));
    if (L[7] != null) { if (L[7].isColor) col.copy(L[7]); else col.set(L[7]); im.setColorAt(i, col); }
  }
  im.count = list.length;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.castShadow = cast !== false; im.receiveShadow = true;
  im.frustumCulled = false;                       // r147 实例包围球不含实例偏移，关闭裁剪避免误剔除
  return im;
};

/* ---------- W4. 海港街道赛 ---------- */
var HB = G.HB = {};
var WHITE = 0xe9e7e0, BLUE = 0x2d669e, DARK = 0x1c1e21, STEEL = 0x5b6064;

HB.mats = function () {
  var pa = G.PBR.paint(), co = G.PBR.concrete(), ba = G.PBR.barrier(), cl = G.PBR.cladding();
  var lit = G.PBR.windows(0.35), sp = G.PBR.sponsors();
  return {
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, map: pa.map, normalMap: pa.normalMap, roughnessMap: pa.roughnessMap, roughness: 1, metalness: 0.0 }),
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, map: pa.map, roughnessMap: pa.roughnessMap, roughness: 0.85, metalness: 0.6 }),
    concrete: new THREE.MeshStandardMaterial({ vertexColors: true, map: co.map, normalMap: co.normalMap, roughnessMap: co.roughnessMap, roughness: 1 }),
    barrier: new THREE.MeshStandardMaterial({ map: ba.map, normalMap: ba.normalMap, roughnessMap: ba.roughnessMap, roughness: 1 }),
    cladding: new THREE.MeshStandardMaterial({ vertexColors: true, map: cl.map, normalMap: cl.normalMap, roughnessMap: cl.roughnessMap, roughness: 1, metalness: 0.2 }),
    plain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.92 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0b1015, roughness: 0.06, metalness: 0.9 }),
    windows: new THREE.MeshStandardMaterial({ map: lit.map, emissiveMap: lit.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.12, metalness: 0.55 }),
    sponsor: new THREE.MeshStandardMaterial({ map: sp, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    sponsorBoard: new THREE.MeshStandardMaterial({ map: sp, roughness: 0.5, side: THREE.DoubleSide }),
    lampWarm: new THREE.MeshStandardMaterial({ color: 0x222018, emissive: 0xffd9a8, emissiveIntensity: 7 }),
    lampRed: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a10, emissiveIntensity: 14 }),
    led: new THREE.MeshStandardMaterial({ color: 0x001100, emissive: 0x30ff60, emissiveIntensity: 5 })
  };
};

HB.frame = function (c, i) {
  i = ((i % c.N) + c.N) % c.N;
  var t = c.TAN[i];
  return { i: i, p: c.P[i], r: c.RIGHT[i], t: t, yaw: Math.atan2(t.x, t.z) };
};
HB.idxAtD = function (c, d) {
  d = ((d % c.len) + c.len) % c.len;
  var lo = 0, hi = c.N;
  while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (c.D[mid] <= d) lo = mid; else hi = mid; }
  return lo;
};
// 局部坐标 -> 世界：X = 横向（RIGHT），Z = 沿线（TAN）
HB.place = function (obj, f, side) {
  obj.position.copy(f.p);
  obj.rotation.y = f.yaw + (side < 0 ? Math.PI : 0);
  return obj;
};
// 沿中心线扫掠剖面 prof=[[lat, y], ...]：法线 = 切线 × 剖面方向（剖面顺序决定朝向）
HB.sweep = function (c, i0, i1, prof, us, vs, yFn) {
  var m = prof.length, n = i1 - i0 + 1, pos = new Float32Array(n * m * 3), uv = new Float32Array(n * m * 2), idx = [];
  var pl = [0], j, s;
  for (j = 1; j < m; j++) pl.push(pl[j - 1] + Math.hypot(prof[j][0] - prof[j - 1][0], prof[j][1] - prof[j - 1][1]));
  var dAcc = c.D[((i0 % c.N) + c.N) % c.N];
  for (s = 0; s < n; s++) {
    var k = ((i0 + s) % c.N + c.N) % c.N, p = c.P[k], r = c.RIGHT[k];
    if (s > 0) dAcc += p.distanceTo(c.P[((i0 + s - 1) % c.N + c.N) % c.N]);
    var ys = yFn ? yFn(s, n) : 1;
    for (j = 0; j < m; j++) {
      var o = s * m + j;
      pos[o * 3] = p.x + r.x * prof[j][0]; pos[o * 3 + 1] = p.y + prof[j][1] * ys; pos[o * 3 + 2] = p.z + r.z * prof[j][0];
      uv[o * 2] = pl[j] / us; uv[o * 2 + 1] = dAcc / vs;
    }
  }
  for (s = 0; s < n - 1; s++) for (j = 0; j < m - 1; j++) {
    var a = s * m + j, b = a + 1, cc = a + m, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
};
// 单侧剖面：side=+1 原样，side=-1 镜像并反转顺序（保持法线朝外）
HB.sideProf = function (prof, side) {
  var p = prof.map(function (q) { return [q[0] * side, q[1]]; });
  if (side < 0) p.reverse();
  return p;
};

/* ----- W4.1 路面：横向 1m 细分，顶点色烘焙大尺度斑块 + 行车线胶痕 + 制动区 ----- */
HB.road = function (c) {
  var W = c.wallIn + 0.12, cols = 17, L = [], j, i;
  for (j = 0; j <= cols; j++) L.push(-W + 2 * W * j / cols);
  var m = L.length, nv = (c.N + 1) * m, pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3), idx = [];
  var tile = 6;
  for (i = 0; i <= c.N; i++) {
    var k = i % c.N, p = c.P[k], r = c.RIGHT[k];
    var kk = c.K[k], ka = c.K[(k + 16) % c.N];
    var line = G.CLAMP((kk * 1.4 - ka * 0.8) * 650, -1, 1) * c.half * 0.6;    // 赛车线：入弯外侧 → 弯心内侧
    var brake = G.CLAMP((Math.abs(ka) - Math.abs(kk)) * 700, 0, 1);
    var macro = G.fbm(c.D[i] * 0.011 + 3.1, 1.7, 3);
    for (j = 0; j < m; j++) {
      var lat = L[j], vi = i * m + j;
      pos[vi * 3] = p.x + r.x * lat; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z + r.z * lat;
      uv[vi * 2] = lat / tile; uv[vi * 2 + 1] = c.D[i] / tile;
      var patch = G.fbm(c.D[i] * 0.045 + lat * 0.13, lat * 0.07 + 9, 3);
      var rub = Math.exp(-Math.pow((lat - line - 0.85) / 0.95, 2)) + Math.exp(-Math.pow((lat - line + 0.85) / 0.95, 2));
      var dust = G.SS(c.half - 0.4, c.half + 1.4, Math.abs(lat));
      var v = 0.9 + (macro - 0.5) * 0.3 + (patch - 0.5) * 0.2;
      v *= 1 - Math.min(1, rub) * (0.2 + brake * 0.3);
      v *= 1 + dust * 0.16;
      col[vi * 3] = v; col[vi * 3 + 1] = v * 0.995; col[vi * 3 + 2] = v * 0.985;
    }
  }
  for (i = 0; i < c.N; i++) for (j = 0; j < m - 1; j++) {
    var a = i * m + j, b = a + 1, cc = a + m, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  var tx = G.PBR.asphalt();
  var mat = new THREE.MeshStandardMaterial({ map: tx.map, normalMap: tx.normalMap, roughnessMap: tx.roughnessMap,
    vertexColors: true, roughness: 1, normalScale: new THREE.Vector2(0.28, 0.28) });
  var mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  c.scene.add(mesh);
  c.asphalt = tx;
};

/* ----- W4.2 路肩：按曲率自动布置（弯心内侧 + 出弯外侧），两端渐变收口 ----- */
HB.kerbs = function (c) {
  var thr = 1 / 85, start = 0, i, runs = [];
  for (i = 0; i < c.N; i++) if (Math.abs(c.K[i]) < thr * 0.5) { start = i; break; }
  var inRun = false, a = 0;
  for (var s = 0; s <= c.N; s++) {
    var k = (start + s) % c.N, on = Math.abs(c.K[k]) > thr;
    if (on && !inRun) { inRun = true; a = start + s; }
    if (!on && inRun) { inRun = false; runs.push([a, start + s - 1]); }
  }
  c.runs = runs;
  var tx = G.PBR.kerb(), parts = [], kw = 1.15, h0 = c.half + 0.12;
  var prof = [[h0, 0.004], [h0 + 0.3, 0.04], [h0 + kw, 0.055], [h0 + kw + 0.06, 0.0]];
  var taper = function (s, n) { return Math.min(1, s / 5, (n - 1 - s) / 5); };
  runs.forEach(function (r) {
    var mid = (r[0] + r[1]) >> 1, side = c.K[mid % c.N] > 0 ? 1 : -1;
    parts.push(HB.sweep(c, r[0] - 8, r[1] + 8, HB.sideProf(prof, side), kw + 0.45, 2, taper));
    parts.push(HB.sweep(c, mid, r[1] + 26, HB.sideProf(prof, -side), kw + 0.45, 2, taper));
  });
  if (!parts.length) return;
  var mesh = new THREE.Mesh(G.mergeGeos(parts), new THREE.MeshStandardMaterial({
    map: tx.map, normalMap: tx.normalMap, roughnessMap: tx.roughnessMap, roughness: 1 }));
  mesh.receiveShadow = true;
  c.scene.add(mesh);
};

/* ----- W4.3 路面标线：两侧白线、起跑线、发车格 ----- */
HB.lines = function (c) {
  var parts = [], s, hw = 0.075;
  for (s = -1; s <= 1; s += 2) parts.push(HB.sweep(c, 0, c.N, HB.sideProf([[c.half - hw, 0.004], [c.half + hw, 0.004]], s), 1, 4));
  var f0 = HB.frame(c, 0);
  var quad = function (f, lat, along, w, d) {
    var g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
    g.translate(lat, 0.005, along); g.rotateY(f.yaw); g.translate(f.p.x, f.p.y, f.p.z);
    parts.push(g);
  };
  quad(f0, 0, 0, c.half * 2, 0.6);                               // 起跑/终点线
  for (var k = 0; k < 10; k++) {                                  // 发车格（交错排列，向后 8m 一格）
    var back = 10 + k * 8, f = HB.frame(c, HB.idxAtD(c, c.len - back)), lat = (k % 2 ? 1 : -1) * 2.7;
    quad(f, lat, 0, 2.2, 0.15);
    quad(f, lat - 1.05, -0.55, 0.15, 1.1); quad(f, lat + 1.05, -0.55, 0.15, 1.1);
  }
  var mat = new THREE.MeshStandardMaterial({ color: 0xe8e6de, roughness: 0.62, normalMap: c.asphalt.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  var mesh = new THREE.Mesh(G.mergeGeos(parts), mat);
  mesh.receiveShadow = true;
  c.scene.add(mesh);
};

/* ----- W4.4 混凝土墙（新泽西轮廓）+ 广告包墙 + 防碎网 + 立柱 + 轮胎缓冲墙 ----- */
HB.walls = function (c, M) {
  var Wn = c.wallIn, top = 1.05, tw = 0.55, parts = [], s;
  for (s = -1; s <= 1; s += 2) {
    [[[Wn, 0], [Wn + 0.04, 0.3], [Wn + 0.09, top]], [[Wn + 0.09, top], [Wn + tw, top]], [[Wn + tw, top], [Wn + tw + 0.08, 0]]]
      .forEach(function (f) { parts.push(HB.sweep(c, 0, c.N, HB.sideProf(f, s), 4, 4)); });
  }
  var wall = new THREE.Mesh(G.mergeGeos(parts), M.barrier);
  wall.castShadow = true; wall.receiveShadow = true;
  c.scene.add(wall);

  // 广告包墙：每 12m 一块，30% 留白（露出混凝土）
  var pos = [], uv = [], segL = 12, i;
  for (s = -1; s <= 1; s += 2) for (i = 0; i < c.N; i++) {
    var d0 = c.D[i], d1 = c.D[i + 1], seg = Math.floor(d0 / segL);
    if (G.pHash(seg, s, 3) < 0.3) continue;
    var row = Math.floor(G.pHash(seg, s, 7) * 8);
    var u0 = (d0 - seg * segL) / segL, u1 = Math.min(1, (d1 - seg * segL) / segL);
    if (s < 0) { u0 = 1 - u0; u1 = 1 - u1; }
    var vt = 1 - row / 8 - 0.004, vb = 1 - (row + 1) / 8 + 0.004;
    var pa = c.P[i], pb = c.P[(i + 1) % c.N], ra = c.RIGHT[i], rb = c.RIGHT[(i + 1) % c.N];
    var lb = s * (Wn + 0.012), lt = s * (Wn + 0.075), yb = 0.14, yt = 0.96;
    var A0 = [pa.x + ra.x * lb, yb, pa.z + ra.z * lb], A1 = [pa.x + ra.x * lt, yt, pa.z + ra.z * lt];
    var B0 = [pb.x + rb.x * lb, yb, pb.z + rb.z * lb], B1 = [pb.x + rb.x * lt, yt, pb.z + rb.z * lt];
    var tA0 = [u0, vb], tA1 = [u0, vt], tB0 = [u1, vb], tB1 = [u1, vt];
    var tri = s > 0 ? [A0, B0, A1, A1, B0, B1] : [A1, B1, A0, A0, B1, B0];
    var tuv = s > 0 ? [tA0, tB0, tA1, tA1, tB0, tB1] : [tA1, tB1, tA0, tA0, tB1, tB0];
    for (var q = 0; q < 6; q++) { pos.push(tri[q][0], tri[q][1], tri[q][2]); uv.push(tuv[q][0], tuv[q][1]); }
  }
  var sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  sg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  sg.computeVertexNormals();
  var wrap = new THREE.Mesh(sg, M.sponsor);
  wrap.receiveShadow = true;
  c.scene.add(wrap);

  // 防碎网（半透明钢丝网）+ 顶/底横杆
  var fl = Wn + 0.5, fparts = [], rails = [];
  for (s = -1; s <= 1; s += 2) {
    fparts.push(HB.sweep(c, 0, c.N, HB.sideProf([[fl, top], [fl, 4.4]], s), 0.32, 0.32));
    rails.push(HB.sweep(c, 0, c.N, HB.sideProf([[fl, 4.32], [fl, 4.42]], s), 1, 4));
    rails.push(HB.sweep(c, 0, c.N, HB.sideProf([[fl, 2.7], [fl, 2.76]], s), 1, 4));
  }
  var fence = new THREE.Mesh(G.mergeGeos(fparts), new THREE.MeshStandardMaterial({
    map: G.PBR.chainlink(), transparent: true, alphaTest: 0.04, depthWrite: false, side: THREE.DoubleSide,
    roughness: 0.5, metalness: 0.6 }));
  fence.renderOrder = 2;
  c.scene.add(fence);
  var railMat = new THREE.MeshStandardMaterial({ color: 0x8a9095, roughness: 0.45, metalness: 0.8, side: THREE.DoubleSide });
  c.scene.add(new THREE.Mesh(G.mergeGeos(rails), railMat));
  var posts = [];
  for (s = -1; s <= 1; s += 2) for (i = 0; i < c.N; i += 2) {
    var f = HB.frame(c, i);
    posts.push([f.p.x + f.r.x * fl * s, top + 1.7, f.p.z + f.r.z * fl * s, f.yaw]);
  }
  c.scene.add(G.instanced(new THREE.BoxGeometry(0.1, 3.4, 0.1), railMat, posts, true));

  // 重刹弯外侧 TecPro 缓冲墙（红蓝交替）
  var tp = [], cBlue = new THREE.Color(0x1f4f9a), cRed = new THREE.Color(0xb3221c);
  c.runs.forEach(function (r) {
    var mid = (r[0] + r[1]) >> 1, side = c.K[mid % c.N] > 0 ? -1 : 1, peak = 0;
    for (var q = r[0]; q <= r[1]; q++) peak = Math.max(peak, Math.abs(c.K[q % c.N]));
    if (peak < 1 / 45) return;
    for (var k = r[0] - 22, n = 0; k <= mid + 4; k++, n++) {
      var ff = HB.frame(c, k), lat = side * (Wn - 0.45);
      tp.push([ff.p.x + ff.r.x * lat, 0.5, ff.p.z + ff.r.z * lat, ff.yaw, 1, 1, (c.D[ff.i + 1] - c.D[ff.i]) * 1.02, n % 2 ? cBlue : cRed]);
      var inner = side > 0 ? c.T.innerR : c.T.innerL;                 // 碰撞使用缓冲墙的内侧面
      inner[ff.i] = Wn - 0.9; inner[(ff.i + 1) % c.N] = Wn - 0.9; inner[(ff.i + c.N - 1) % c.N] = Wn - 0.9;
    }
  });
  if (tp.length) c.scene.add(G.instanced(new THREE.BoxGeometry(0.9, 1.0, 1), new THREE.MeshStandardMaterial({ roughness: 0.55 }), tp, true));
};

/* ----- W4.5 起跑灯架：桁架 + 5 组红灯（倒计时逐组点亮，全灭即发车） ----- */
HB.gantry = function (c, M) {
  var f = HB.frame(c, 0), W = c.wallIn + 1.1, b = new G.GB(3), x;
  b.c(0x2a2e33);
  b.box(0.5, 8.8, 0.5, -W, 4.4, 0).box(0.5, 8.8, 0.5, W, 4.4, 0);
  [7.3, 8.5].forEach(function (y) { [-0.55, 0.55].forEach(function (z) { b.box(2 * W, 0.2, 0.2, 0, y, z); }); });
  for (x = -W; x < W - 0.1; x += 1.2) {
    [-0.55, 0.55].forEach(function (z) { b.box(0.08, 1.2, 0.08, x, 7.9, z); b.beam(x, 7.3, z, x + 1.2, 8.5, z, 0.06); });
  }
  b.c(0x0c0d0f).box(4.8, 1.6, 0.42, 0, 6.35, -0.62);
  b.box(0.16, 1.1, 0.16, -1.6, 7.2, -0.62).box(0.16, 1.1, 0.16, 1.6, 7.2, -0.62);
  var g = b.mesh(M.steel);
  c.scene.add(HB.place(g, f, 1));
  var lamps = [];
  for (var k = 0; k < 5; k++) {
    var mat = new THREE.MeshStandardMaterial({ color: 0x140303, emissive: 0xff0000, emissiveIntensity: 0, roughness: 0.3 });
    var lg = new G.GB(1);
    lg.cyl(0.17, 0.17, 0.06, 16, 1.7 - k * 0.85, 6.7, -0.86, Math.PI / 2, 0, 0);
    lg.cyl(0.17, 0.17, 0.06, 16, 1.7 - k * 0.85, 6.15, -0.86, Math.PI / 2, 0, 0);
    var lm = lg.mesh(mat, false, false);
    c.scene.add(HB.place(lm, f, 1));
    lamps.push(mat);
  }
  c.T.setLights = function (n) {
    for (var q = 0; q < 5; q++) { lamps[q].emissiveIntensity = q < n ? 2.2 : 0; lamps[q].color.setHex(q < n ? 0x660a04 : 0x140303); }
  };
  // 横梁赞助商牌（前后各一块，单面朝外）
  var holder = new THREE.Group();
  [-1, 1].forEach(function (dir) {
    var pg = new THREE.PlaneGeometry(2 * W - 1, 1.25), uv = pg.attributes.uv;
    for (var q = 0; q < uv.count; q++) uv.setY(q, uv.getY(q) / 8 + 7 / 8);
    var board = new THREE.Mesh(pg, M.sponsor);
    board.position.set(0, 9.5, dir * 0.07);
    if (dir < 0) board.rotation.y = Math.PI;
    holder.add(board);
  });
  var back = new THREE.Mesh(new THREE.BoxGeometry(2 * W - 0.9, 1.35, 0.12), M.rubber); back.position.y = 9.5; holder.add(back);
  var pole = new THREE.Mesh(new THREE.BoxGeometry(2 * W - 1, 0.12, 0.12), M.rubber); pole.position.y = 8.8; holder.add(pole);
  c.scene.add(HB.place(holder, f, 1));
};

/* ----- W4.6 看台：阶梯混凝土 + 座椅 + 观众（实例化）+ 雨棚 ----- */
HB.grandstand = function (c, M, iC, side, len, crowd, heads) {
  var f = HB.frame(c, iC), base = c.wallIn + 4.2, rows = 13, dep = 0.85, rise = 0.46, y0 = 1.9;
  var b = new G.GB(4), rnd = G.rng(iC * 7 + 3), r, z;
  var X = new THREE.Vector3(f.r.x * side, 0, f.r.z * side), Zv = new THREE.Vector3(f.t.x * side, 0, f.t.z * side);
  var shirt = [0x8a1c24, 0xd8d6cf, 0x1f3a5c, 0xc98a3a, 0x2b2b2b, 0x3a5e85, 0xb8a85a, 0x5b7550, 0x9a5236, 0x6e7378, 0x1a1a1a, 0x4a4a52];
  var skin = [0xe0b48f, 0xc69070, 0x9b6a4c, 0xf0caa6];
  for (r = 0; r < rows; r++) {
    var x = base + r * dep + dep / 2, yt = y0 + r * rise;
    b.c(0x9a9c9c).box(dep, yt, len, x, yt / 2, 0);
    b.c(r % 4 === 3 ? 0xd9d7d0 : 0x1f4f8a).box(0.5, 0.36, len, x + 0.1, yt + 0.18, 0);
    for (z = -len / 2 + 0.4; z < len / 2 - 0.4; z += 0.56) {
      if (Math.abs(((z + len / 2) % 18) - 9) < 0.9) continue;     // 过道
      if (rnd() > 0.8) continue;
      var lx = x - 0.02 + (rnd() - 0.5) * 0.08, ly = yt + 0.62, lz = z + (rnd() - 0.5) * 0.1;
      var wx = f.p.x + X.x * lx + Zv.x * lz, wz = f.p.z + X.z * lx + Zv.z * lz;
      crowd.push([wx, f.p.y + ly, wz, f.yaw, 1, 0.9 + rnd() * 0.2, 1, shirt[(rnd() * shirt.length) | 0]]);
      heads.push([wx, f.p.y + ly + 0.42, wz, f.yaw, 1, 1, 1, skin[(rnd() * skin.length) | 0]]);
    }
  }
  var xb = base + rows * dep + 0.3, yb = y0 + rows * rise;
  b.c(0x74787b).box(0.4, yb + 3.2, len, xb, (yb + 3.2) / 2, 0);
  for (z = -len / 2; z <= len / 2 + 0.1; z += 12) b.c(0x3c4146).box(0.35, 7.4, 0.35, xb - 0.4, yb + 3.7, z);
  b.c(0xcfd2d4).box(rows * dep + 3.5, 0.32, len + 2, base + rows * dep / 2 - 1.2, yb + 7.4, 0, 0, 0, 0.05);
  var mesh = b.mesh(M.paint);
  c.scene.add(HB.place(mesh, f, side));
  // 雨棚前沿广告板
  var pg = new THREE.PlaneGeometry(len, 1.1), uv = pg.attributes.uv, row = 1 + (iC % 6);
  for (var q = 0; q < uv.count; q++) uv.setY(q, uv.getY(q) / 8 + (7 - row) / 8);
  pg.rotateY(-Math.PI / 2);
  var fascia = new THREE.Mesh(pg, M.sponsorBoard);
  fascia.position.set(base - 2.95, yb + 7.0, 0);
  var grp = new THREE.Group(); grp.add(fascia);
  c.scene.add(HB.place(grp, f, side));
};

/* ----- W4.7 赛道周边：人行天桥、裁判岗、刹车距离牌 ----- */
HB.trackside = function (c, M) {
  // 背直道人行天桥（赞助商横幅）
  var iB = c.T.nearest(new THREE.Vector3(176, 0, -10)), f = HB.frame(c, iB), b = new G.GB(3), W = c.wallIn + 2.2;
  b.c(0x3d4247).box(2 * W, 0.45, 3.0, 0, 6.3, 0);
  [-1.5, 1.5].forEach(function (z) {
    b.box(2 * W, 0.18, 0.18, 0, 6.6, z).box(2 * W, 0.18, 0.18, 0, 8.4, z);
    for (var x = -W; x < W - 0.1; x += 2) { b.box(0.12, 1.8, 0.12, x, 7.5, z); b.beam(x, 6.6, z, x + 2, 8.4, z, 0.08); }
  });
  b.c(0x2e3338).box(0.2, 2.0, 3.2, 0, 9.0, 0);
  [-1, 1].forEach(function (sd) { b.c(0x50565b).box(3.2, 9.4, 4.2, sd * (W + 1.6), 4.7, 0); b.c(0x2e3338).box(3.4, 0.3, 4.4, sd * (W + 1.6), 9.5, 0); });
  c.scene.add(HB.place(b.mesh(M.steel), f, 1));
  var bg = new THREE.Group();
  [-1, 1].forEach(function (sd) {
    var pg = new THREE.PlaneGeometry(2 * W - 2, 1.5), uv = pg.attributes.uv;
    for (var q = 0; q < uv.count; q++) uv.setY(q, uv.getY(q) / 8 + 6 / 8);
    var m = new THREE.Mesh(pg, M.sponsorBoard); m.position.set(0, 7.45, sd * 1.62); bg.add(m);
  });
  c.scene.add(HB.place(bg, f, 1));

  // 裁判岗（带绿色 LED 信号板）
  var mb = new G.GB(2), leds = new G.GB(1);
  for (var d = 120; d < c.len - 60; d += 210) {
    var ff = HB.frame(c, HB.idxAtD(c, d)), sd = c.K[ff.i] > 0 ? -1 : 1, lat = sd * (c.wallIn + 2.4);
    var px = ff.p.x + ff.r.x * lat, pz = ff.p.z + ff.r.z * lat;
    mb.c(0xd85a1c).box(2.2, 2.7, 2.2, px, 1.35, pz, 0, ff.yaw, 0);
    mb.c(0xe9e7e0).box(2.4, 0.2, 2.4, px, 2.8, pz, 0, ff.yaw, 0);
    var ll = sd * (c.wallIn + 0.35);
    leds.box(0.12, 0.55, 0.9, ff.p.x + ff.r.x * ll, 1.55, ff.p.z + ff.r.z * ll, 0, ff.yaw, 0);
  }
  c.scene.add(mb.mesh(M.paint));
  c.scene.add(leds.mesh(M.led, false, false));

  // 重刹区距离牌 150 / 100 / 50
  c.runs.forEach(function (r) {
    var prev = 0;
    for (var q = r[0] - 1; q > r[0] - 200; q--) { if (Math.abs(c.K[((q % c.N) + c.N) % c.N]) > 1 / 300) break; prev++; }
    if (prev < 70) return;
    var mid = (r[0] + r[1]) >> 1, side = c.K[mid % c.N] > 0 ? -1 : 1;
    [150, 100, 50].forEach(function (dist) {
      var fb = HB.frame(c, HB.idxAtD(c, c.D[((r[0] % c.N) + c.N) % c.N] - dist)), lat = side * (c.wallIn + 0.28);
      var tex = G.PBR.label(String(dist), 256, 192, '#111', '#f2f0ea');
      var pl = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.0), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
      pl.position.set(fb.p.x + fb.r.x * lat, 1.75, fb.p.z + fb.r.z * lat);
      pl.rotation.y = fb.yaw + Math.PI;
      c.scene.add(pl);
    });
  });
};

/* ---------- W5. 集装箱码头 ---------- */
HB.addCtr = function (c, x, y, z, yaw, len, brand, tint) {
  var key = brand + '_' + (len > 8 ? 40 : 20);
  (c.ctr[key] = c.ctr[key] || []).push([x, y, z, yaw, 1, 1, 1, tint]);
};
HB.pickBrand = function (rnd) {
  var B = G.CONTAINER_BRANDS, tot = 0, i;
  for (i = 0; i < B.length; i++) tot += B[i].w;
  var t = rnd() * tot;
  for (i = 0; i < B.length; i++) { t -= B[i].w; if (t <= 0) return i; }
  return 0;
};
HB.containerGeo = function (len) {
  var g = new THREE.BoxGeometry(2.44, 2.59, len), uv = g.attributes.uv;
  var s0 = len > 8 ? 0 : 0.2, s1 = len > 8 ? 0.8 : 0.6;
  var map = function (face, u0, u1) {
    for (var k = 0; k < 4; k++) { var i = face * 4 + k; uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), uv.getY(i)); }
  };
  map(0, s0, s1); map(1, s0, s1); map(2, 0.3, 0.5); map(3, 0.3, 0.5); map(4, 0.8, 1); map(5, 0.8, 1);
  g.translate(0, 1.295, 0);
  return g;
};
HB.flushContainers = function (c) {
  var nr = G.PBR.containerNR(), g40 = HB.containerGeo(12.19), g20 = HB.containerGeo(6.06), total = 0;
  G.CONTAINER_BRANDS.forEach(function (br, bi) {
    var mat = new THREE.MeshStandardMaterial({ map: G.PBR.container(br), normalMap: nr.normalMap, roughnessMap: nr.roughnessMap,
      roughness: 1, metalness: 0.15, normalScale: new THREE.Vector2(1, 1) });
    [40, 20].forEach(function (sz) {
      var list = c.ctr[bi + '_' + sz];
      if (!list || !list.length) return;
      total += list.length;
      c.scene.add(G.instanced(sz === 40 ? g40 : g20, mat, list, true));
    });
  });
  c.T.containerCount = total;
};
// 堆场箱区：沿 axis 方向排列（'z' 或 'x'）；rows 横排数，tiers 最大层高
HB.block = function (c, ox, oz, length, rows, axis, rnd, opt) {
  opt = opt || {};
  var pitchR = 2.8, pitchB = 12.75, maxT = opt.tiers || 5, clear = c.wallIn + 5;
  c.blocks.push([ox, oz, length, rows, axis]);
  var inKeep = function (x, z) { for (var q = 0; q < c.keep.length; q++) if (Math.hypot(x - c.keep[q][0], z - c.keep[q][1]) < c.keep[q][2]) return true; return false; };
  for (var a = 0; a + 12.19 <= length; a += pitchB) {
    var twenty = rnd() < (opt.p20 != null ? opt.p20 : 0.25);
    for (var r = 0; r < rows; r++) {
      var lx = r * pitchR, la = a + 6.1;
      var wx = axis === 'z' ? ox + lx : ox + la, wz = axis === 'z' ? oz + la : oz + lx;
      var ex = axis === 'z' ? 0 : 6.1, ez = axis === 'z' ? 6.1 : 0;
      if (c.T.dist(wx, wz) < clear || c.T.dist(wx - ex, wz - ez) < clear || c.T.dist(wx + ex, wz + ez) < clear) continue;
      if (inKeep(wx, wz)) continue;
      var nT = Math.floor(G.CLAMP(G.fbm(wx * 0.045 + 3, wz * 0.03, 2) * (maxT + 2.2) - 1.0 + (rnd() - 0.5) * 1.6, 0, maxT));
      if (opt.full) nT = maxT - (rnd() < 0.2 ? 1 : 0);
      var yaw = axis === 'z' ? 0 : Math.PI / 2, brand = opt.brand != null ? opt.brand : HB.pickBrand(rnd);
      for (var t = 0; t < nT; t++) {
        var tint = new THREE.Color().setScalar(0.8 + rnd() * 0.2);
        var b = opt.brand != null ? opt.brand : (rnd() < 0.6 ? brand : HB.pickBrand(rnd));
        if (twenty) {
          HB.addCtr(c, wx - ex * 0.5, t * 2.59, wz - ez * 0.5, yaw, 6.06, b, tint);
          HB.addCtr(c, wx + ex * 0.5, t * 2.59, wz + ez * 0.5, yaw, 6.06, opt.brand != null ? b : HB.pickBrand(rnd), tint);
        } else HB.addCtr(c, wx, t * 2.59, wz, yaw, 12.19, b, tint);
      }
    }
  }
};

/* ----- 岸桥（STS）：轨距 30.5m、门框 18m、主梁 48m、A 字架顶 78m、前伸 62m、后伸 24m ----- */
HB.stsMesh = function (M, boomUp) {
  var b = new G.GB(4), Gg = 30.5, Zl = 9, H = 45.5, GY = 48, red = [], warm = [];
  b.c(DARK);
  [0, Gg].forEach(function (x) { [-Zl, Zl].forEach(function (z) {
    b.box(1.9, 1.4, 4.6, x, 0.95, z);
    [-1.5, -0.5, 0.5, 1.5].forEach(function (w) { b.cyl(0.42, 0.42, 0.32, 12, x, 0.42, z + w, 0, 0, Math.PI / 2); });
  }); });
  b.c(WHITE);
  [0, Gg].forEach(function (x) { [-Zl, Zl].forEach(function (z) { b.box(1.9, H - 1.6, 1.9, x, 1.6 + (H - 1.6) / 2, z); }); });
  [-Zl, Zl].forEach(function (z) { b.box(Gg, 2.2, 1.6, Gg / 2, 14, z); });
  [0, Gg].forEach(function (x) {
    b.box(1.6, 1.8, 2 * Zl, x, 14, 0);
    b.box(2.4, 2.6, 2 * Zl + 2, x, H, 0);
    b.beam(x, 16, -Zl, x, H - 1.4, 0, 0.8).beam(x, 16, Zl, x, H - 1.4, 0, 0.8);
    b.box(1.4, GY - H, 1.4, x, (H + GY) / 2 + 0.6, -4.2).box(1.4, GY - H, 1.4, x, (H + GY) / 2 + 0.6, 4.2);
  });
  // 主梁（后伸段 + 门框段）
  b.c(BLUE);
  [-4.2, 4.2].forEach(function (z) { b.box(Gg + 26, 3.2, 1.5, (Gg + 2 - 24) / 2, GY + 1.6, z); });
  for (var x = -22; x <= Gg; x += 6) b.box(0.6, 0.6, 8.4, x, GY + 3.0, 0);
  // 前伸臂（铰点 hx,hy；仰起 78°）
  var hx = Gg + 2, hy = GY + 1.6, ang = boomUp ? 1.36 : 0, ca = Math.cos(ang), sa = Math.sin(ang);
  var bp = function (dx, dy) { return [hx + dx * ca - dy * sa, hy + dx * sa + dy * ca]; };
  [-4.2, 4.2].forEach(function (z) {
    var p0 = bp(0, 0), p1 = bp(57, 0), p2 = bp(62, 0);
    b.c(BLUE).beam(p0[0], p0[1], z, p1[0], p1[1], z, 1.5, 3.0);
    b.c(0xc8261d).beam(p1[0], p1[1], z, p2[0], p2[1], z, 1.55, 3.05);
  });
  b.c(BLUE);
  for (var d = 4; d <= 60; d += 8) { var pp = bp(d, 1.4); b.box(0.6, 0.6, 8.4, pp[0], pp[1], 0); }
  // A 字架 + 前拉杆 + 后拉杆
  b.c(WHITE);
  var ax = Gg - 4, ay = GY + 30;
  [-1, 1].forEach(function (s) {
    b.beam(Gg + 1.5, GY + 3.2, s * 4.2, ax, ay, s * 3.2, 1.25);
    b.beam(Gg - 16, GY + 3.2, s * 4.2, ax, ay, s * 3.2, 1.25);
    var f1 = bp(30, 1.6), f2 = bp(56, 1.6);
    b.beam(ax, ay, s * 3.2, f1[0], f1[1], s * 4.2, 0.38).beam(ax, ay, s * 3.2, f2[0], f2[1], s * 4.2, 0.38);
    b.beam(ax, ay, s * 3.2, -21, GY + 3.2, s * 4.2, 0.45);
  });
  b.box(1.5, 1.5, 7.8, ax, ay, 0);
  b.beam(ax, ay - 8, -3.5, ax, ay - 8, 3.5, 0.6);
  // 机房 + 小车 + 司机室
  b.c(0xdedcd5).box(13, 7, 10.4, -14, GY + 6.7, 0);
  b.c(BLUE).box(13.1, 0.9, 10.5, -14, GY + 9.6, 0);
  b.c(0x3c4146).box(13.05, 3.0, 0.2, -14, GY + 5.2, 5.25);
  var tx = boomUp ? -3 : Gg + 22;
  b.c(0xdedcd5).box(7, 2.6, 9.6, tx, GY + 4.5, 0);
  b.c(0x2a2f35).box(3.2, 3.2, 3.2, tx + 1.5, GY - 1.9, -2.6);
  b.c(0x0e1318).box(3.25, 1.4, 3.25, tx + 1.5, GY - 1.6, -2.6);
  if (!boomUp) {
    b.c(DARK);
    [-1.6, 1.6].forEach(function (dx) { [-1.2, 1.2].forEach(function (dz) { b.beam(tx + dx, GY, dz, tx + dx, 35.6, dz, 0.06); }); });
    b.c(0xd4a020).box(2.6, 0.9, 12.4, tx, 35.1, 0);
  }
  // 检修平台/栏杆（深灰格栅）+ 爬梯塔
  b.c(0x5a5f63);
  [-1, 1].forEach(function (s) { b.box(Gg + 26, 0.12, 1.1, (Gg + 2 - 24) / 2, GY + 3.25, s * 5.6); b.box(Gg + 26, 1.0, 0.05, (Gg + 2 - 24) / 2, GY + 3.8, s * 6.1); });
  for (var k = 0; k < 10; k++) b.box(2.4, 0.12, 1.2, -2.2, 4 + k * 4.2, Zl + 2.2);
  b.box(0.25, 44, 0.25, -3.3, 22, Zl + 2.2).box(0.25, 44, 0.25, -1.1, 22, Zl + 2.2);
  // 航空障碍灯 + 主梁下泛光灯
  red.push([ax, ay + 1.2, 0]); var tip = bp(62, 3.2); red.push([tip[0], tip[1], 0]); red.push([-24, GY + 3.6, 0]);
  [-12, 6, Gg - 4].forEach(function (x) { [-4.2, 4.2].forEach(function (z) { warm.push([x, GY - 0.3, z]); }); });
  return { mesh: b.mesh(M.paint), red: red, warm: warm, spreader: boomUp ? null : [tx, 32.5] };
};

/* ----- 轮胎吊（RTG）：跨距 23.5m、高 21m ----- */
HB.rtgMesh = function (M) {
  var b = new G.GB(3), S = 23.5, Hh = 21, Z = 3.4;
  [-1, 1].forEach(function (sx) {
    var x = sx * S / 2;
    b.c(WHITE);
    [-Z, Z].forEach(function (z) { b.box(1.1, Hh - 1.6, 1.1, x, 1.6 + (Hh - 1.6) / 2, z); });
    b.box(1.3, 1.5, 2 * Z + 3.4, x, 1.3, 0);
    b.beam(x, 6, -Z, x, 17, Z, 0.45).beam(x, 6, Z, x, 17, -Z, 0.45);
    b.c(DARK);
    [-Z - 0.9, -Z + 0.6, Z - 0.6, Z + 0.9].forEach(function (z) { b.cyl(0.78, 0.78, 0.55, 14, x, 0.78, z, 0, 0, Math.PI / 2); });
  });
  b.c(BLUE);
  [-Z, Z].forEach(function (z) { b.box(S + 2.2, 1.7, 1.2, 0, Hh, z); });
  b.c(0xdedcd5).box(4.6, 2.2, 2 * Z + 1.4, 3, Hh + 1.9, 0);
  b.box(4.2, 3.2, 2 * Z + 1.2, -S / 2 + 1.2, Hh + 2.4, 0);
  b.c(0x1b2026).box(2.2, 2.4, 2.2, 3, Hh - 2.2, -Z + 1.5);
  b.c(DARK);
  [-1.2, 1.2].forEach(function (dz) { b.beam(1.5, Hh, dz, 1.5, 12.6, dz, 0.05).beam(4.5, Hh, dz, 4.5, 12.6, dz, 0.05); });
  b.c(0xd4a020).box(2.6, 0.7, 12.4, 3, 12.3, 0);
  return b.mesh(M.paint);
};

/* ----- 货轮：放样船体（球鼻艏省略，船艏收尖、外飘）+ 甲板箱位 + 上层建筑 + 烟囱 + 船名 ----- */
HB.ship = function (c, M, o) {
  var W = G.WATER_Y, L = o.L, B = o.B, H = o.H, n = 48, grp = new THREE.Group(), rnd = G.rng(o.seed || 9);
  var halfW = function (s) {
    if (s < 0.05) return B / 2 * (0.84 + 0.16 * Math.sqrt(s / 0.05));
    if (s < 0.76) return B / 2;
    return B / 2 * Math.pow(Math.cos((s - 0.76) / 0.24 * Math.PI / 2), 0.7);
  };
  var deckY = function (s) { return W + H + 3.5 * Math.pow(Math.max(0, (s - 0.84) / 0.16), 2); };
  var cNavy = new THREE.Color(o.hull || 0x1c2a38), cBlack = new THREE.Color(0x141618), cRed = new THREE.Color(0x7a2a22);
  var ring = function (s) {
    var w = halfW(s), wt = Math.min(B / 2, w * (s > 0.76 ? 1 + 0.3 * (s - 0.76) / 0.24 : 1) + (s > 0.97 ? 0 : 0)), yD = deckY(s), yK = W - o.draft + (s > 0.9 ? (s - 0.9) * 40 : 0);
    var pts = [[-wt, yD, cNavy], [-w, W + 0.8, cNavy], [-w, W + 0.6, cBlack], [-w, W - 0.4, cBlack], [-w, W - 0.6, cRed],
      [-w * 0.96, W - 8, cRed], [-w * 0.62, yK, cRed], [0, yK - 0.2, cRed], [w * 0.62, yK, cRed], [w * 0.96, W - 8, cRed],
      [w, W - 0.6, cRed], [w, W - 0.4, cBlack], [w, W + 0.6, cBlack], [w, W + 0.8, cNavy], [wt, yD, cNavy]];
    return pts;
  };
  var m = 15, pos = [], col = [], uv = [], idx = [], i, j, s;
  for (i = 0; i <= n; i++) {
    s = i / n; var rg = ring(s);
    for (j = 0; j < m; j++) { pos.push(rg[j][0], rg[j][1], s * L); col.push(rg[j][2].r, rg[j][2].g, rg[j][2].b); uv.push(s * L / 6, rg[j][1] / 6); }
  }
  for (i = 0; i < n; i++) for (j = 0; j < m - 1; j++) { var a = i * m + j, bb = a + 1, cc = a + m, dd = cc + 1; idx.push(a, bb, cc, bb, dd, cc); }
  var base = pos.length / 3, r0 = ring(0), cy = 0;
  for (j = 0; j < m; j++) cy += r0[j][1]; cy /= m;
  pos.push(0, cy, 0); col.push(cNavy.r, cNavy.g, cNavy.b); uv.push(0, 0);
  for (j = 0; j < m - 1; j++) idx.push(base, j + 1, j);
  var hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  hg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  hg.setIndex(idx); hg.computeVertexNormals();
  var hull = new THREE.Mesh(hg, M.paint); hull.castShadow = true; hull.receiveShadow = true; grp.add(hull);
  // 甲板
  var dp = [], di = [];
  for (i = 0; i <= n; i++) { s = i / n; var rr = ring(s); dp.push(rr[0][0], rr[0][1] - 0.05, s * L, rr[m - 1][0], rr[m - 1][1] - 0.05, s * L); }
  for (i = 0; i < n; i++) { var a2 = i * 2; di.push(a2, a2 + 2, a2 + 1, a2 + 1, a2 + 2, a2 + 3); }
  var dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3)); dg.setIndex(di); dg.computeVertexNormals();
  var deck = new THREE.Mesh(dg, new THREE.MeshStandardMaterial({ color: 0x4a5048, roughness: 0.85 })); deck.receiveShadow = true; grp.add(deck);

  var b = new G.GB(4), sB = o.bridgeAt || 0.68, sF = 0.16, yD0 = W + H;
  // 上层建筑（驾驶楼）+ 翼桥 + 桅杆
  var bw = B * 0.6, bz = sB * L;
  b.c(0xe6e3da).box(bw, 26, 12, 0, yD0 + 13, bz);
  for (var fl = 0; fl < 8; fl++) b.c(0x1a2229).box(bw + 0.06, 1.0, 12.06, 0, yD0 + 3 + fl * 2.9, bz);
  b.c(0xe6e3da).box(B + 1.5, 3.2, 7, 0, yD0 + 27.6, bz + 2.5);
  b.c(0x10171d).box(B + 1.56, 1.3, 7.06, 0, yD0 + 27.8, bz + 2.5);
  b.c(0xe6e3da).box(0.6, 9, 0.6, 0, yD0 + 33.7, bz).box(5, 0.3, 0.3, 0, yD0 + 36.5, bz);
  // 机舱棚 + 烟囱（公司色带）
  b.c(0x2b3138).box(B * 0.5, 16, 10, 0, yD0 + 8, sF * L);
  b.c(o.stripe || 0xc25e27).box(B * 0.5 + 0.06, 2.4, 10.06, 0, yD0 + 13, sF * L);
  // 舱口盖 + 绑扎桥
  var bayLen = 13.6, bays = [];
  for (var bzp = 0.07 * L; bzp + 12.2 < 0.88 * L; bzp += bayLen) {
    var sc = (bzp + 6.1) / L;
    if (Math.abs(sc - sB) < 0.035 || Math.abs(sc - sF) < 0.03) continue;
    bays.push(bzp + 6.1);
  }
  bays.forEach(function (z) {
    var w = halfW(z / L) * 2 * 0.92;
    b.c(0x39443f).box(w, 1.0, 12.6, 0, deckY(z / L) + 0.5, z);
    b.c(0x6f7478).box(w, 0.3, 0.6, 0, deckY(z / L) + 6.2, z + 6.6);
    b.box(0.3, 5.2, 0.3, -w / 2, deckY(z / L) + 3.6, z + 6.6).box(0.3, 5.2, 0.3, w / 2, deckY(z / L) + 3.6, z + 6.6);
  });
  var sm = b.mesh(M.paint); grp.add(sm);
  // 甲板集装箱
  var place = function (lx, ly, lz, b2, tint) {
    // 船体局部 -> 世界：绕 Y 旋转 o.yaw
    var cs = Math.cos(o.yaw), sn = Math.sin(o.yaw);
    var wx = o.x + lx * cs + lz * sn, wz = o.z + (-lx * sn + lz * cs);
    HB.addCtr(c, wx, ly, wz, o.yaw, 12.19, b2, tint);
  };
  var simple = [];
  bays.forEach(function (z) {
    var w = halfW(z / L) * 2 * 0.92, rows = Math.floor(w / 2.52), y0 = deckY(z / L) + 1.0;
    var hBase = 4 + Math.floor(rnd() * 4) - (z / L > 0.8 ? 2 : 0);
    for (var r = 0; r < rows; r++) {
      var lx = (r - (rows - 1) / 2) * 2.52, edge = Math.min(r, rows - 1 - r) < 1 ? 1 : 0;
      var tiers = Math.max(1, hBase - edge - (rnd() < 0.15 ? 1 : 0) + (o.light ? -2 : 0));
      if (o.simple) { simple.push([lx, y0, z, tiers]); continue; }
      for (var t = 0; t < tiers; t++) place(lx, y0 + t * 2.59, z, HB.pickBrand(rnd), new THREE.Color().setScalar(0.82 + rnd() * 0.18));
    }
  });
  if (o.simple) {
    var sb = new G.GB(8), pal = [0x7a2b25, 0x22405f, 0x2f5a40, 0xc25e27, 0x8a8f94, 0x6a9cc4];
    simple.forEach(function (q) { sb.c(pal[(rnd() * pal.length) | 0]).box(2.44, q[3] * 2.59, 12.19, q[0], q[1] + q[3] * 1.295, q[2]); });
    grp.add(sb.mesh(M.plain, false, false));
  }
  // 船名（两舷，船艏附近）
  if (o.name) {
    var tex = G.PBR.label(o.name, 1024, 128, '#ecebe4', null);
    var nm = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });
    [-1, 1].forEach(function (sd) {
      var zz = 0.9 * L, w = halfW(0.9) * (1 + 0.3 * (0.9 - 0.76) / 0.24) + 0.08;
      var pl = new THREE.Mesh(new THREE.PlaneGeometry(26, 3.2), nm);
      pl.position.set(sd * w * 0.98, deckY(0.9) - 3.0, zz);
      pl.rotation.y = sd * Math.PI / 2;
      grp.add(pl);
    });
  }
  grp.position.set(o.x, 0, o.z);
  grp.rotation.y = o.yaw;
  c.scene.add(grp);
  return grp;
};

/* ----- 码头岸壁、系缆桩、护舷、岸桥轨道 ----- */
HB.quay = function (c, M) {
  var QX = c.QX, NZ = c.NZ, Wy = G.WATER_Y, b = new G.GB(4), z;
  // 岸壁立面（顶点色：潮位线以下发暗发绿）
  var mkFace = function (len, rotY, px, pz) {
    var g = new THREE.PlaneGeometry(len, 7, Math.ceil(len / 20), 7), p = g.attributes.position, colA = new Float32Array(p.count * 3);
    g.translate(0, -3.5, 0);
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i), wet = G.SS(Wy + 1.6, Wy - 0.2, y), n = 0.85 + G.hash2(Math.round(p.getX(i) / 20), i % 7) * 0.12;
      colA[i * 3] = n * (1 - wet * 0.55); colA[i * 3 + 1] = n * (1 - wet * 0.45); colA[i * 3 + 2] = n * (1 - wet * 0.5);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colA, 3));
    G.scaleUV(g, len / 4, 7 / 4);
    g.rotateY(rotY); g.translate(px, 0, pz);
    var mm = new THREE.Mesh(g, M.concrete); mm.receiveShadow = true; c.scene.add(mm);
  };
  mkFace(NZ + 1800, -Math.PI / 2, QX, (NZ - 1800) / 2);
  mkFace(3400 - QX, 0, (QX + 3400) / 2, NZ);
  // 压顶 + 黄色警示边线
  b.c(0xbdbab3).box(1.0, 0.3, NZ + 1800, QX + 0.5, 0.12, (NZ - 1800) / 2);
  b.c(0xbdbab3).box(3400 - QX, 0.3, 1.0, (QX + 3400) / 2, 0.12, NZ - 0.5);
  b.c(0xd9a521).box(0.22, 0.02, NZ + 1800, QX + 1.4, 0.005, (NZ - 1800) / 2);
  // 岸桥轨道（钢轨 + 轨道槽）
  [-100, -130.5].forEach(function (x) {
    b.c(0x77746e).box(1.4, 0.02, 2400, x, 0.004, -600);
    b.c(0x9da3a8).box(0.12, 0.09, 2400, x, 0.04, -600);
  });
  // 码头车道黄线
  for (z = -1700; z < NZ - 20; z += 9) b.c(0xd9a521).box(0.15, 0.02, 4.5, -116, 0.006, z);
  var bm = b.mesh(M.concrete); c.scene.add(bm);
  // 系缆桩 + 护舷
  var bol = new G.GB(1), fen = new G.GB(2);
  for (z = -1700; z < NZ - 10; z += 22) {
    bol.c(0x2a2c2e).cyl(0.26, 0.32, 0.55, 12, QX + 1.0, 0.28, z).c(0xd9a521).cyl(0.4, 0.4, 0.12, 12, QX + 1.0, 0.6, z);
    fen.c(0x161718).cyl(0.85, 0.85, 1.6, 14, QX - 0.8, -1.4, z, 0, 0, Math.PI / 2).c(0x232527).box(0.35, 3.0, 3.6, QX - 1.7, -1.4, z);
  }
  c.scene.add(bol.mesh(M.paint));
  c.scene.add(fen.mesh(M.plain));
};

HB.ground = function (c, M) {
  var x0 = c.QX, x1 = 3400, z0 = -3400, z1 = c.NZ;
  var g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 170, 190);
  g.rotateX(-Math.PI / 2); g.translate((x0 + x1) / 2, -0.03, (z0 + z1) / 2);
  var p = g.attributes.position, uv = g.attributes.uv, col = new Float32Array(p.count * 3);
  for (var i = 0; i < p.count; i++) {
    var x = p.getX(i), z = p.getZ(i);
    uv.setXY(i, x / 5, z / 5);
    var v = 0.8 + (G.fbm(x * 0.004 + 5, z * 0.004, 3) - 0.5) * 0.4 + (G.fbm(x * 0.03, z * 0.03 + 7, 2) - 0.5) * 0.14;
    col[i * 3] = v; col[i * 3 + 1] = v * 0.99; col[i * 3 + 2] = v * 0.97;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  var mesh = new THREE.Mesh(g, M.concrete);
  mesh.receiveShadow = true;
  c.scene.add(mesh);
  c.scene.add(G._waterMesh(0, G.WATER_Y, 12000, 12000, 0));
};

HB.cranes = function (c, M) {
  var red = c.red, warm = c.warm;
  var down = HB.stsMesh(M, false), up = HB.stsMesh(M, true);
  [[-180, 0], [-100, 0], [-22, 0], [140, 1], [222, 1], [415, 0]].forEach(function (q) {
    var src = q[1] ? up : down, m = src.mesh.clone(), zc = q[0];
    m.position.set(-100, 0, zc); m.rotation.y = Math.PI;
    c.scene.add(m);
    var w = function (p) { return [-100 - p[0], p[1], zc - p[2]]; };
    src.red.forEach(function (p) { red.push(w(p)); });
    src.warm.forEach(function (p) { warm.push(w(p)); });
    if (src.spreader) {                                               // 吊具上挂着一只箱子
      var rnd = G.rng(zc + 99);
      HB.addCtr(c, -100 - src.spreader[0], src.spreader[1] - 2.59, zc, 0, 12.19, HB.pickBrand(rnd), new THREE.Color(0xffffff));
    }
  });
  // 轮胎吊
  var rtg = HB.rtgMesh(M);
  [[-31, 60], [-5, -120], [168, 40], [232, -150], [264, 220], [200, 330]].forEach(function (q) {
    if (c.T.dist(q[0], q[1]) < c.wallIn + 16) return;
    var m = rtg.clone(); m.position.set(q[0], 0, q[1]); c.scene.add(m);
  });
};

HB.yard = function (c) {
  var rnd = G.rng(4242);
  // 内场（被赛道环绕）；与赛道重叠的箱位由距离检测自动剔除，自然形成贴墙的“集装箱峡谷”
  [-50, -24, 2, 28, 54, 80, 106].forEach(function (x) { HB.block(c, x, -250, 440, 6, 'z', rnd); });
  [-40, 60].forEach(function (x) { HB.block(c, x, 222, 90, 6, 'x', rnd, { tiers: 4 }); });
  // 东侧主堆场（东直道两侧）
  [140, 196, 228, 260, 292, 324].forEach(function (x) { HB.block(c, x, -420, 860, 6, 'z', rnd, { tiers: 5 }); });
  // 南侧（横向排列）
  [-372, -402].forEach(function (z) { HB.block(c, -70, z, 260, 6, 'x', rnd, { tiers: 4 }); });
  // 北侧空箱堆场（20 尺、同一船公司、堆到 7 层）
  [380, 410, 440].forEach(function (z, k) { HB.block(c, 60, z, 140, 7, 'x', rnd, { tiers: 7, p20: 1, full: true, brand: k }); });
};

/* ----- 堆场地面标线：箱区外框 + 贝位分隔线（白）、车道边线（黄）----- */
HB.groundMarks = function (c) {
  var b = new G.GB(4), y = 0.004;
  c.blocks.forEach(function (k) {
    var ox = k[0], oz = k[1], len = k[2], w = k[3] * 2.8, along = k[4] === 'z';
    var seg = function (a0, r0, a1, r1, col) {
      var cx = along ? (r0 + r1) / 2 : (a0 + a1) / 2, cz = along ? (a0 + a1) / 2 : (r0 + r1) / 2;
      var sx = along ? Math.abs(r1 - r0) + 0.12 : Math.abs(a1 - a0) + 0.12, sz = along ? Math.abs(a1 - a0) + 0.12 : Math.abs(r1 - r0) + 0.12;
      if (c.T.dist(cx, cz) < c.wallIn + 1 && Math.max(sx, sz) < 30) return;
      b.c(col).box(sx, 0.01, sz, cx, y, cz);
    };
    var r0 = (along ? ox : oz) - 1.6, r1 = (along ? ox : oz) + w - 1.2, a0 = (along ? oz : ox) - 0.3, a1 = (along ? oz : ox) + len;
    for (var a = a0; a <= a1; a += 12.75) seg(a, r0, a, r1, 0xd8d6cf);
    seg(a0, r0, a1, r0, 0xd8d6cf); seg(a0, r1, a1, r1, 0xd8d6cf);
    seg(a0, r1 + 4.2, a1, r1 + 4.2, 0xd9a521);
  });
  var m = b.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), false, true);
  c.scene.add(m);
};

/* ----- 集卡（拖车头 + 底盘 + 箱） ----- */
HB.trucks = function (c, M) {
  var b = new G.GB(2), rnd = G.rng(31);
  var list = [[-38.5, 120, 0], [-12.5, -60, 0], [13.5, 150, 3.14], [181, -60, 0], [245, 120, 3.14], [313, -200, 0], [-110, -60, 0], [-112, 40, 3.14], [-109, -140, 0]];
  list.forEach(function (q) {
    if (c.T.dist(q[0], q[1]) < c.wallIn + 3) return;
    var cs = Math.cos(q[2]), sn = Math.sin(q[2]);
    var P = function (lx, lz) { return [q[0] + lx * cs + lz * sn, q[1] - lx * sn + lz * cs]; };
    var p1 = P(0, 7.2), p2 = P(0, 0);
    b.c([0xb3261e, 0x22405f, 0xe9e7e0][(rnd() * 3) | 0]).box(2.5, 2.9, 2.6, p1[0], 1.75, p1[1], 0, q[2], 0);
    b.c(0x101418).box(2.52, 0.9, 0.1, P(0, 8.52)[0], 2.4, P(0, 8.52)[1], 0, q[2], 0);
    b.c(DARK).box(2.4, 0.45, 12.6, p2[0], 1.15, p2[1], 0, q[2], 0);
    [-5.2, -4.0, 6.0, 7.6].forEach(function (lz) { [-1, 1].forEach(function (sd) { var pw = P(sd * 1.05, lz); b.c(0x111213).cyl(0.52, 0.52, 0.4, 10, pw[0], 0.52, pw[1], 0, q[2], Math.PI / 2); }); });
    if (rnd() < 0.8) HB.addCtr(c, p2[0], 1.38, p2[1], q[2], 12.19, HB.pickBrand(rnd), new THREE.Color(0xffffff));
  });
  c.scene.add(b.mesh(M.paint));
};

/* ----- 高杆灯（35m，顶部 8 盏泛光灯）----- */
HB.masts = function (c, M) {
  var pts = [], i, rnd = G.rng(55);
  for (var d = 40; d < c.len; d += 135) {
    var f = HB.frame(c, HB.idxAtD(c, d)), sd = c.K[f.i] > 0 ? -1 : 1, lat = sd * (c.wallIn + 7);
    var x = f.p.x + f.r.x * lat, z = f.p.z + f.r.z * lat;
    if (x < -96 || c.T.dist(x, z) < c.wallIn + 5) continue;
    pts.push([x, z]);
  }
  for (var gx = 160; gx < 360; gx += 96) for (var gz = -380; gz < 440; gz += 120) if (c.T.dist(gx, gz) > 20) pts.push([gx + 7.5, gz]);
  var b = new G.GB(4), lb = new G.GB(1);
  pts.forEach(function (p) {
    b.c(0x8f969b).cyl(0.22, 0.42, 35, 10, p[0], 17.5, p[1]);
    b.c(0x6a7075).cyl(2.2, 2.2, 0.35, 16, p[0], 35.2, p[1]);
    for (i = 0; i < 8; i++) {
      var a = i / 8 * TAU, hx = p[0] + Math.cos(a) * 1.6, hz = p[1] + Math.sin(a) * 1.6;
      b.c(0x3a3f44).box(0.9, 0.55, 0.6, hx, 35.8, hz, -0.5, -a + Math.PI / 2, 0);
      lb.box(0.8, 0.06, 0.5, hx, 35.5, hz, 0, -a + Math.PI / 2, 0);
    }
  });
  c.scene.add(b.mesh(M.steel));
  c.scene.add(lb.mesh(M.lampWarm, false, false));
};

/* ----- 建筑：码头办公楼、拆装箱仓库、闸口 ----- */
HB.buildings = function (c, M) {
  var b = new G.GB(4), cl = new G.GB(4), z;
  // 办公楼（玻璃幕墙）
  var off = new THREE.BoxGeometry(56, 27, 24); G.boxUV(off, 56, 27, 24, 12); off.translate(-30, 13.5, 420);
  var om = new THREE.Mesh(off, M.windows); om.castShadow = om.receiveShadow = true; c.scene.add(om);
  b.c(0xcfcac0).box(57, 1.2, 25, -30, 27.6, 420);
  b.c(0x8d9297).box(8, 3, 6, -42, 29.6, 416).box(6, 2.4, 5, -20, 29.4, 424);
  b.c(0xcfcac0).box(57, 4.5, 25, -30, 2.25, 420);
  // 仓库（彩钢板）×3
  for (var k = 0; k < 3; k++) {
    var zc = -330 + k * 150, xc = 420;
    cl.c(0xb9c2c8).box(42, 14, 120, xc, 7, zc);
    cl.c(0x8c969e).box(22.5, 0.4, 122, xc - 10.2, 15.2, zc, 0, 0, 0.16).box(22.5, 0.4, 122, xc + 10.2, 15.2, zc, 0, 0, -0.16);
    for (z = zc - 50; z <= zc + 50; z += 20) b.c(0x2b3036).box(0.2, 5.5, 6, xc - 21.1, 2.75, z);
    b.c(0xd9a521).box(0.25, 0.4, 120, xc - 21.1, 0.2, zc);
  }
  // 闸口雨棚 + 岗亭
  b.c(0x8f969b);
  for (var x = 250; x <= 330; x += 16) { b.box(0.5, 7, 0.5, x, 3.5, 528).box(0.5, 7, 0.5, x, 3.5, 552); }
  b.c(0xe9e7e0).box(86, 1.0, 30, 290, 7.4, 540);
  b.c(0xc8261d).box(86.2, 0.5, 30.2, 290, 7.0, 540);
  for (x = 258; x <= 322; x += 16) b.c(0xe0ddd5).box(2.2, 2.8, 3, x, 1.4, 540);
  c.scene.add(b.mesh(M.paint));
  c.scene.add(cl.mesh(M.cladding));
};

/* ---------- W6. 远景 ---------- */
HB.far = function (c, M) {
  // 斜拉桥（横跨北侧海湾）：桥面 58m、塔高 200m、主跨 850m
  var b = new G.GB(20), Zb = 1500, Yd = 58, cab = [], x;
  b.c(0x9ea3a6).box(5600, 3.2, 34, 0, Yd, Zb);
  b.c(0x6d7377).box(5600, 1.4, 0.6, 0, Yd + 2.3, Zb - 16.5).box(5600, 1.4, 0.6, 0, Yd + 2.3, Zb + 16.5);
  for (x = -2700; x <= 2700; x += 110) if (Math.abs(x + 450) > 60 && Math.abs(x - 400) > 60) b.c(0xa9aca8).box(10, Yd - G.WATER_Y, 22, x, (Yd + G.WATER_Y) / 2, Zb);
  [-450, 400].forEach(function (px) {
    b.c(0xb8bab4);
    b.beam(px, G.WATER_Y, Zb - 26, px, 200, Zb - 5, 9).beam(px, G.WATER_Y, Zb + 26, px, 200, Zb + 5, 9);
    b.box(9, 7, 50, px, Yd - 6, Zb).box(9, 9, 14, px, 150, Zb).box(10, 14, 12, px, 206, Zb);
    for (var k = 1; k <= 16; k++) {
      [-1, 1].forEach(function (dir) {
        var dx = dir * k * 26, ty = 112 + k * 5.4;
        [-1, 1].forEach(function (sz) { cab.push(px, ty, Zb + sz * 6, px + dx, Yd + 1.5, Zb + sz * 16); });
      });
    }
  });
  var bm = b.mesh(M.plain, false, false); c.scene.add(bm);
  var cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cab, 3));
  c.scene.add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xd8dad6 })));
  // 桥面路灯点
  var lamps = [];
  for (x = -2700; x <= 2700; x += 45) { lamps.push([x, Yd + 9, Zb - 17]); lamps.push([x + 22, Yd + 9, Zb + 17]); }
  c.scene.add(G.instanced(new THREE.SphereGeometry(0.9, 6, 4), M.lampWarm, lamps, false));

  // 北岸城市天际线（实例化塔楼，窗格自发光）
  var rnd = G.rng(808), towers = [], win = G.PBR.windows(0.42);
  for (var i = 0; i < 170; i++) {
    var tx = (rnd() - 0.5) * 6000, tz = 2350 + rnd() * 1100, cluster = Math.exp(-Math.pow((tx - 300) / 1300, 2));
    var h = 30 + rnd() * 70 + cluster * rnd() * 260, w = 24 + rnd() * 36;
    towers.push([tx, h / 2, tz, rnd() * TAU, w, h, w * (0.7 + rnd() * 0.6), new THREE.Color().setScalar(0.55 + rnd() * 0.4)]);
  }
  var tg = new THREE.BoxGeometry(1, 1, 1); G.scaleUV(tg, 4, 10);
  var tm = new THREE.MeshStandardMaterial({ map: win.map, emissiveMap: win.emissiveMap, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.2, metalness: 0.5 });
  c.scene.add(G.instanced(tg, tm, towers, false));
  var shore = new THREE.Mesh(new THREE.PlaneGeometry(12000, 3000), new THREE.MeshStandardMaterial({ color: 0x4a4c4a, roughness: 1 }));
  shore.rotation.x = -Math.PI / 2; shore.position.set(0, -0.5, 2250 + 1500);
  c.scene.add(shore);
  // 远山（西、南方向环带）
  var ring = [], idx = [], SEG = 220, R0 = 3600;
  for (i = 0; i <= SEG; i++) {
    var a = Math.PI * 0.45 + i / SEG * Math.PI * 1.25, n1 = G.fbm(i * 0.05, 3.3, 4), ht = 60 + Math.pow(n1, 1.6) * 520;
    var rr = R0 + (G.fbm(i * 0.08, 9.1, 2) - 0.5) * 900;
    ring.push(Math.cos(a) * rr, G.WATER_Y - 2, Math.sin(a) * rr, Math.cos(a) * (rr + 300), ht, Math.sin(a) * (rr + 300));
  }
  for (i = 0; i < SEG; i++) { var q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
  var hgm = new THREE.BufferGeometry(); hgm.setAttribute('position', new THREE.Float32BufferAttribute(ring, 3)); hgm.setIndex(idx); hgm.computeVertexNormals();
  c.scene.add(new THREE.Mesh(hgm, new THREE.MeshStandardMaterial({ color: 0x3f4a3f, roughness: 1, side: THREE.DoubleSide })));
  // 锚地船只（简化箱体）
  [[-900, -500, 0.35, 260], [-1500, 200, -0.2, 300], [-2100, -1200, 0.6, 220], [-1200, 1000, 1.2, 240]].forEach(function (q, k) {
    HB.ship(c, M, { x: q[0], z: q[1], yaw: q[2], L: q[3], B: 40, H: 12, draft: 12, simple: true, seed: 50 + k, light: k % 2 === 1 });
  });
};

/* ---------- 主入口 ---------- */
G.buildHarborCircuit = function (scene, def, T) {
  var P = T.P, TAN = T.TAN, N = T.N, i, k;
  var half = def.roadHalf, wallIn = half + 1.8;
  T.railOff = wallIn; T.clouds = [];
  T.terrainHeight = function () { return 0; };
  scene.fog = new THREE.FogExp2(def.fog[0], def.fog[1]);
  var D = new Float32Array(N + 1);
  for (i = 0; i < N; i++) D[i + 1] = D[i] + P[(i + 1) % N].distanceTo(P[i]);
  var K = new Float32Array(N), Ks = new Float32Array(N);
  for (i = 0; i < N; i++) { var a = TAN[i], b = TAN[(i + 1) % N]; K[i] = (a.z * b.x - a.x * b.z) / Math.max(0.05, D[i + 1] - D[i]); }
  for (i = 0; i < N; i++) { var s = 0; for (k = -6; k <= 6; k++) s += K[(i + k + N) % N]; Ks[i] = s / 13; }
  T.D = D; T.K = Ks;
  T.dist = function (x, z) {
    var bd = 1e18;
    for (var q = 0; q < N; q += 2) { var dx = x - P[q].x, dz = z - P[q].z, d = dx * dx + dz * dz; if (d < bd) bd = d; }
    return Math.sqrt(bd);
  };
  var c = { scene: scene, def: def, T: T, P: P, TAN: TAN, RIGHT: T.RIGHT, N: N, D: D, K: Ks, len: D[N],
    half: half, wallIn: wallIn, QX: -136, NZ: 640, ctr: {}, red: [], warm: [], blocks: [],
    keep: [[5, 350, 52], [35, -350, 56], [-62, -95, 64]] };            // 看台区域不堆箱
  T.innerL = new Float32Array(N).fill(wallIn); T.innerR = new Float32Array(N).fill(wallIn);
  T.wallInner = function (idx, side) { return (side > 0 ? T.innerR : T.innerL)[idx]; };
  var M = HB.mats();
  HB.road(c); HB.kerbs(c); HB.lines(c); HB.walls(c, M); HB.gantry(c, M);
  var crowd = [], heads = [];
  HB.grandstand(c, M, T.nearest(new THREE.Vector3(-85, 0, -95)), 1, 110, crowd, heads);
  HB.grandstand(c, M, T.nearest(new THREE.Vector3(5, 0, 320)), -1, 70, crowd, heads);
  HB.grandstand(c, M, T.nearest(new THREE.Vector3(35, 0, -324)), -1, 80, crowd, heads);
  scene.add(G.instanced(new THREE.BoxGeometry(0.44, 0.62, 0.3), new THREE.MeshStandardMaterial({ roughness: 0.85 }), crowd, false));
  scene.add(G.instanced(new THREE.BoxGeometry(0.2, 0.24, 0.22), new THREE.MeshStandardMaterial({ roughness: 0.7 }), heads, false));
  HB.trackside(c, M);
  HB.ground(c, M); HB.quay(c, M); HB.cranes(c, M);
  HB.ship(c, M, { x: -163.5, z: -232, yaw: 0, L: 300, B: 44, H: 14, draft: 13, name: 'SALTLINE PACIFIC', seed: 3 });
  HB.ship(c, M, { x: -152, z: 330, yaw: 0, L: 175, B: 26, H: 10, draft: 9, name: 'HANSA KIEL', hull: 0x2a3a2e, stripe: 0x2f5a40, seed: 8, light: true });
  HB.yard(c); HB.groundMarks(c); HB.trucks(c, M); HB.masts(c, M); HB.buildings(c, M); HB.far(c, M);
  HB.flushContainers(c);
  scene.add(G.instanced(new THREE.SphereGeometry(0.45, 8, 6), M.lampRed, c.red, false));
  scene.add(G.instanced(new THREE.BoxGeometry(1.4, 0.2, 0.9), M.lampWarm, c.warm, false));
  var minR = 1e9; for (i = 0; i < N; i++) minR = Math.min(minR, 1 / Math.max(1e-6, Math.abs(Ks[i])));
  T.minRadius = minR;
  return T;
};
})();

/* ============================================================
 * game.mountain.js —— 山地拉力赛道（山脊起点 · 悬崖 · 峡谷大桥 · 沙地高原 · 河谷涉水 · 森林发卡）
 * 地形由“路面高程 + 相对起伏 + 河谷/悬崖修正”程序化生成，路面再按挖填方嵌入地形；
 * 山体阴影烘焙进顶点（低角度夕阳在山谷里投下长影），路面/地形/树木共用同一套高度场。
 * ============================================================ */
(function () {
'use strict';
var WIN = GameGlobal;
var TAU = Math.PI * 2, SS = G.SS, CL = G.CLAMP, LP = G.LERP;
var MT = G.MT = {};
var L0 = 3040;                                    // 名义圈长（所有里程关键帧以它为基准按比例缩放）

// 路面类型权重顺序：[沥青, 碎石土路, 泥地, 沙地]
MT.SURF = {
  names: ['沥青', '碎石土路', '泥地', '沙地'],
  mu:    [1.00, 0.70, 0.56, 0.50],                // 抓地系数
  rr:    [0.015, 0.05, 0.09, 0.12],               // 滚动阻力系数
  visc:  [0, 0.004, 0.02, 0.04],                  // 随速度增长的阻力（泥/沙/水）
  rough: [0.004, 0.024, 0.036, 0.020],            // 路面起伏幅度 (m)
  dust:  [0, 0.65, 0.05, 1.0]                     // 扬尘强度
};
// 里程(m) -> 海拔(m)：起点山脊 -> 峡谷大桥 -> 沙地高原 -> 下行发卡 -> 河谷涉水 -> 森林爬坡回山脊
MT.KEYS = [[0, 105], [150, 108], [300, 106], [390, 100], [480, 100], [560, 97], [700, 90], [880, 84], [1050, 78], [1200, 70],
  [1330, 60], [1500, 42], [1619, 29.92], [1700, 31.2], [1800, 34], [1950, 42], [2300, 62], [2700, 88], [2900, 100]];
// [里程, 沥青, 碎石土路, 泥地, 沙地]
MT.SKEYS = [[0, 1, 0, 0, 0], [330, 1, 0, 0, 0], [420, 1, 0, 0, 0], [500, .85, .15, 0, 0], [585, 0.1, .9, 0, 0], [700, 0, 1, 0, 0],
  [860, 0, .85, 0, .15], [940, 0, .08, 0, .92], [1230, 0, 0, 0, 1], [1320, 0, .65, 0, .35], [1400, 0, 1, 0, 0], [1510, 0, .45, .55, 0],
  [1570, 0, 0, 1, 0], [1700, 0, 0, 1, 0], [1770, 0, .5, .5, 0], [1900, 0, .85, .15, 0], [2300, 0, .7, .3, 0], [2700, 0, .88, .12, 0],
  [2900, .15, .85, 0, 0], [2960, 1, 0, 0, 0], [3040, 1, 0, 0, 0]];
MT.BRIDGE = [396, 468];                           // 大桥里程范围（名义）
MT.FORD = [1585, 1655];                           // 涉水段
MT.JUMP = 905;                                    // 跳台起点

function ridged(x, z, oct) {
  var a = 0.5, f = 1, s = 0, n = 0;
  for (var i = 0; i < oct; i++) { var v = 1 - Math.abs(G.vnoise(x * f + i * 17.3, z * f + i * 9.1) * 2 - 1); s += a * v * v; n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
// 周期 Hermite 插值（首尾衔接，路面高程在起终点连续）
function hermite(keys, L, s) {
  s = ((s % L) + L) % L;
  var n = keys.length, i = n - 1, k;
  for (k = 0; k < n; k++) if (keys[k][0] > s) { i = k - 1; break; }
  if (i < 0) i = n - 1;
  var S = function (j) { return keys[((j % n) + n) % n][0] + Math.floor(j / n) * L; };
  var Y = function (j) { return keys[((j % n) + n) % n][1]; };
  var s0 = S(i), h = S(i + 1) - s0, t = (s - s0) / h;
  var m0 = (Y(i + 1) - Y(i - 1)) / (S(i + 1) - S(i - 1)) * h, m1 = (Y(i + 2) - Y(i)) / (S(i + 2) - S(i)) * h;
  var t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * Y(i) + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * Y(i + 1) + (t3 - t2) * m1;
}
function lerpKeys(keys, L, s, out) {
  s = ((s % L) + L) % L;
  var n = keys.length, i = 0, k;
  for (k = 0; k < n - 1; k++) if (keys[k + 1][0] <= s) i = k + 1;
  var a = keys[i], b = i + 1 < n ? keys[i + 1] : [L + keys[0][0]].concat(keys[0].slice(1));
  var t = b[0] > a[0] ? (s - a[0]) / (b[0] - a[0]) : 0; t = t * t * (3 - 2 * t);
  for (k = 1; k < a.length; k++) out[k - 1] = LP(a[k], b[k], t);
}
function bilin(arr, nx, ix, iz, fx, fz) {
  var a = arr[iz * nx + ix], b = arr[iz * nx + ix + 1], c = arr[(iz + 1) * nx + ix], d = arr[(iz + 1) * nx + ix + 1];
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

G.buildMountainRally = function (scene, def, T, renderer) {
  var P = T.P, TAN = T.TAN, RIGHT = T.RIGHT, N = T.N, i, k, j;
  var half = def.roadHalf, SW = 1.5, Wc = half + SW;
  scene.fog = new THREE.FogExp2(def.fog[0], def.fog[1]);
  scene.traverse(function (o) {                   // 山谷里大面积处于山影：加强天空漫射，避免阴影死黑
    if (o.isHemisphereLight) { o.intensity = 1.5; o.color.setHex(0xc4d2e4); o.groundColor.setHex(0x7a6a50); }
    if (o.isDirectionalLight) { o.intensity = 3.4; o.color.setHex(0xffd6a6); o.shadow.normalBias = 0.18; o.shadow.bias = -0.0005; o.shadow.camera.layers.enable(1); }
  });
  T.clouds = [];

  /* ---------- 里程 / 曲率 ---------- */
  var D = new Float32Array(N + 1);
  for (i = 0; i < N; i++) D[i + 1] = D[i] + P[(i + 1) % N].distanceTo(P[i]);
  var LEN = D[N], sc = L0 / LEN;
  var K = new Float32Array(N), Ks = new Float32Array(N);
  for (i = 0; i < N; i++) { var ta = TAN[i], tb = TAN[(i + 1) % N]; K[i] = (ta.z * tb.x - ta.x * tb.z) / Math.max(0.05, D[i + 1] - D[i]); }
  for (i = 0; i < N; i++) { var ssum = 0; for (k = -6; k <= 6; k++) ssum += K[(i + k + N) % N]; Ks[i] = ssum / 13; }
  T.D = D; T.K = Ks; T.len = LEN;
  var sn = function (idx) { return D[idx] * sc; };                 // 名义里程
  var idxAtN = function (s) { var lo = 0, hi = N; s = ((s % L0) + L0) % L0 / sc; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (D[m] <= s) lo = m; else hi = m; } return lo; };
  T.idxAtN = idxAtN; T.sn = sn;

  /* ---------- 路面高程：关键帧 + 缓起伏 + 跳台 + 涉水凹陷 ---------- */
  var roadY = new Float32Array(N), isBridge = new Uint8Array(N);
  var jp = MT.JUMP;
  for (i = 0; i < N; i++) {
    var s = sn(i), br = s > MT.BRIDGE[0] && s < MT.BRIDGE[1];
    var y = hermite(MT.KEYS, L0, s);
    if (!br) y += 0.8 * (G.vnoise(s * 0.016, 3.3) - 0.5) + 0.4 * (G.vnoise(s * 0.05, 9.1) - 0.5);
    var fd = Math.abs(s - (MT.FORD[0] + MT.FORD[1]) / 2);
    y -= 0.42 * (1 - SS(14, 36, fd));                               // 涉水段路面略低于水面
    var jd = s - jp;
    if (jd > 0 && jd < 12) y += 1.25 * (jd / 12);                   // 跳台斜坡
    else if (jd >= 12 && jd < 13.5) y += 1.25 * (1 - (jd - 12) / 1.5); // 台唇陡落
    y += 0.7 * Math.exp(-Math.pow((s - 2050) / 9, 2)) + 0.6 * Math.exp(-Math.pow((s - 1130) / 8, 2)) + 0.8 * Math.exp(-Math.pow((s - 2640) / 10, 2)); // 山包（小跳）
    roadY[i] = y; isBridge[i] = br ? 1 : 0; P[i].y = y;
  }
  T.roadY = roadY;

  /* ---------- 路面类型 ---------- */
  var surf = new Float32Array(N * 4), tmpS = [0, 0, 0, 0];
  for (i = 0; i < N; i++) {
    var s2 = sn(i); lerpKeys(MT.SKEYS, L0, s2, tmpS);
    var nz = G.vnoise(s2 * 0.045, 4.4);                              // 土路/泥地斑块
    if (tmpS[1] > 0.2 && s2 > 1650) { var mm = SS(0.5, 0.75, nz) * 0.7; tmpS[2] += tmpS[1] * mm; tmpS[1] *= 1 - mm; }
    var tot = tmpS[0] + tmpS[1] + tmpS[2] + tmpS[3] || 1;
    for (k = 0; k < 4; k++) surf[i * 4 + k] = tmpS[k] / tot;
  }
  var sp = { mu: 1, rr: 0.015, visc: 0, rough: 0.004, dust: 0, water: 0, name: '沥青', w0: 1, w1: 0, w2: 0, w3: 0, idx: 0 };
  var SF = MT.SURF;
  T.surfaceAt = function (idx, lat) {
    var w0 = surf[idx * 4], w1 = surf[idx * 4 + 1], w2 = surf[idx * 4 + 2], w3 = surf[idx * 4 + 3];
    var e = SS(half - 0.7, half + 0.5, Math.abs(lat)) * 0.65;       // 路肩碎石
    if (e > 0) { w1 += (w0 + w2 + w3) * e; w0 *= 1 - e; w2 *= 1 - e; w3 *= 1 - e; }
    sp.w0 = w0; sp.w1 = w1; sp.w2 = w2; sp.w3 = w3;
    sp.mu = w0 * SF.mu[0] + w1 * SF.mu[1] + w2 * SF.mu[2] + w3 * SF.mu[3];
    sp.rr = w0 * SF.rr[0] + w1 * SF.rr[1] + w2 * SF.rr[2] + w3 * SF.rr[3];
    sp.visc = w0 * SF.visc[0] + w1 * SF.visc[1] + w2 * SF.visc[2] + w3 * SF.visc[3];
    sp.rough = w0 * SF.rough[0] + w1 * SF.rough[1] + w2 * SF.rough[2] + w3 * SF.rough[3];
    sp.dust = w0 * SF.dust[0] + w1 * SF.dust[1] + w2 * SF.dust[2] + w3 * SF.dust[3];
    var sNow = sn(idx); sp.water = 1 - SS(8, 34, Math.abs(sNow - (MT.FORD[0] + MT.FORD[1]) / 2));
    if (sp.water > 0) { sp.visc += 0.11 * sp.water; sp.mu *= 1 - 0.25 * sp.water; }
    var best = 0, bw = w0; if (w1 > bw) { best = 1; bw = w1; } if (w2 > bw) { best = 2; bw = w2; } if (w3 > bw) { best = 3; }
    sp.name = sp.water > 0.5 ? '涉水' : SF.names[best]; sp.idx = best;
    return sp;
  };

  /* ---------- 路网空间索引 ---------- */
  var CG = 24, buckets = {};
  var bk = function (cx, cz) { return (cx + 2048) * 4096 + (cz + 2048); };
  for (i = 0; i < N; i += 2) { var kk = bk(Math.floor(P[i].x / CG), Math.floor(P[i].z / CG)); (buckets[kk] || (buckets[kk] = [])).push(i); }
  var NR = { i: 0, d: 1e9, lat: 0, y: 0, along: 0 };
  function nearest(x, z) {
    var cx = Math.floor(x / CG), cz = Math.floor(z / CG), bi = -1, bd = 1e18, a, b, q;
    for (a = -2; a <= 2; a++) for (b = -2; b <= 2; b++) {
      var l = buckets[bk(cx + a, cz + b)]; if (!l) continue;
      for (q = 0; q < l.length; q++) { var p = P[l[q]], dx = x - p.x, dz = z - p.z, dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; bi = l[q]; } }
    }
    if (bi < 0) return null;
    var best = bi;
    for (var o = -1; o <= 1; o += 2) { var jj = (bi + o + N) % N, pj = P[jj], d2 = (x - pj.x) * (x - pj.x) + (z - pj.z) * (z - pj.z); if (d2 < bd) { bd = d2; best = jj; } }
    var r = RIGHT[best], t = TAN[best], p0 = P[best];
    NR.i = best; NR.lat = (x - p0.x) * r.x + (z - p0.z) * r.z;
    NR.along = (x - p0.x) * t.x + (z - p0.z) * t.z;
    NR.d = Math.abs(NR.along) < 1.4 ? Math.abs(NR.lat) : Math.sqrt(bd);
    var sl = (roadY[(best + 1) % N] - roadY[(best - 1 + N) % N]) / (D[Math.min(N, best + 1)] - D[Math.max(0, best - 1)] + 1e-6);
    NR.y = roadY[best] + NR.along * sl;
    return NR;
  }
  T.nearestSL = nearest;

  /* ---------- 地貌：河流、悬崖修正、沙丘 ---------- */
  var riverX = function (z) { var u = (z + 60) / 381 * Math.PI; return 35 + 26 * Math.sin(2 * u) + 7 * Math.sin(5 * u); };
  var riverDX = function (z) { var u = (z + 60) / 381 * Math.PI, c = Math.PI / 381; return 26 * 2 * c * Math.cos(2 * u) + 7 * 5 * c * Math.cos(5 * u); };
  var waterLevel = function (z) { return z > -45 ? 29.78 + (z + 45) * 0.063 : z < -125 ? 29.78 + (z + 125) * 0.045 : 29.78; };   // 涉水点上下游是一段平缓水面
  T.riverX = riverX; T.waterLevel = waterLevel;
  var riverDist = function (x, z) { var dd = riverDX(z); return Math.abs(x - riverX(z)) / Math.sqrt(1 + dd * dd); };
  var sandMask = function (x, z) { return 1 - SS(150, 290, Math.hypot(x - 345, z - 105)); };

  // 悬崖/岩壁修正：每个里程段给左右两侧的高度偏移（左 = 行进方向左侧）
  var mL = new Float32Array(N), mR = new Float32Array(N);
  var segs = [[150, 392, -62, 24], [560, 700, 14, -42], [2960, 3040, -16, -16], [0, 150, -16, -16]];
  for (i = 0; i < N; i++) {
    var sm = sn(i);
    segs.forEach(function (g) { var f = SS(g[0] - 40, g[0] + 20, sm) * (1 - SS(g[1] - 20, g[1] + 40, sm)); if (g[0] === 0) f = 1 - SS(g[1] - 30, g[1] + 40, sm); if (g[1] === 3040) f = SS(g[0] - 20, g[0] + 40, sm); mL[i] += g[2] * f; mR[i] += g[3] * f; });
  }
  var MG = 60, mbuck = {};
  for (i = 0; i < N; i += 7) { if (Math.abs(mL[i]) + Math.abs(mR[i]) < 0.5) continue; var mk2 = bk(Math.floor(P[i].x / MG), Math.floor(P[i].z / MG)); (mbuck[mk2] || (mbuck[mk2] = [])).push(i); }
  function modAt(x, z) {
    var cx = Math.floor(x / MG), cz = Math.floor(z / MG), bi = -1, bd = 1e18, a, b, q;
    for (a = -2; a <= 2; a++) for (b = -2; b <= 2; b++) {
      var l = mbuck[bk(cx + a, cz + b)]; if (!l) continue;
      for (q = 0; q < l.length; q++) { var p = P[l[q]], dx = x - p.x, dz = z - p.z, dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; bi = l[q]; } }
    }
    if (bi < 0) return 0;
    var r = RIGHT[bi], lat = (x - P[bi].x) * r.x + (z - P[bi].z) * r.z, d = Math.sqrt(bd);
    return (lat < 0 ? mL[bi] : mR[bi]) * SS(Wc, Wc + 38, d) * (1 - SS(75, 150, d));
  }

  /* ---------- 粗场：到路距离 + 平滑路高 ---------- */
  var bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9, ymean = 0;
  for (i = 0; i < N; i++) { bx0 = Math.min(bx0, P[i].x); bx1 = Math.max(bx1, P[i].x); bz0 = Math.min(bz0, P[i].z); bz1 = Math.max(bz1, P[i].z); ymean += roadY[i] / N; }
  var FC = 48, fx0 = Math.floor((bx0 - 2900) / FC) * FC, fz0 = Math.floor((bz0 - 2900) / FC) * FC;
  var fnx = Math.ceil((bx1 + 2900 - fx0) / FC) + 2, fnz = Math.ceil((bz1 + 2900 - fz0) / FC) + 2;
  var DF = new Float32Array(fnx * fnz), RF = new Float32Array(fnx * fnz);
  var sub = []; for (i = 0; i < N; i += 6) sub.push(i);
  var SIG = 105, SIG2 = SIG * SIG;
  for (j = 0; j < fnz; j++) for (i = 0; i < fnx; i++) {
    var gx = fx0 + i * FC, gz = fz0 + j * FC, dmin = 1e18, sw = 0, sy = 0;
    for (k = 0; k < sub.length; k++) {
      var pp = P[sub[k]], ddx = gx - pp.x, ddz = gz - pp.z, d2 = ddx * ddx + ddz * ddz;
      if (d2 < dmin) dmin = d2;
      if (d2 < 9 * SIG2) { var w = Math.exp(-d2 / SIG2); sw += w; sy += w * roadY[sub[k]]; }
    }
    DF[j * fnx + i] = Math.sqrt(dmin);
    RF[j * fnx + i] = (sy + 0.0005 * ymean) / (sw + 0.0005);
  }
  var fieldAt = function (arr, x, z) {
    var u = (x - fx0) / FC, v = (z - fz0) / FC, ix = Math.max(0, Math.min(fnx - 2, Math.floor(u))), iz = Math.max(0, Math.min(fnz - 2, Math.floor(v)));
    return bilin(arr, fnx, ix, iz, CL(u - ix, 0, 1), CL(v - iz, 0, 1));
  };

  /* ---------- 地形高度函数 ---------- */
  var lastRd = 99, lastWet = 0;
  // 侵蚀分形（Inigo Quilez 导数阻尼 fbm）：坡度大处高频细节被抑制，形成水流切割的沟壑与平滑山脊
  function noised(x, z, o) {
    var ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
    var ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    var dux = 30 * fx * fx * (fx * (fx - 2) + 1), duz = 30 * fz * fz * (fz * (fz - 2) + 1);
    var a = G.hash2(ix, iz), b = G.hash2(ix + 1, iz), c = G.hash2(ix, iz + 1), d = G.hash2(ix + 1, iz + 1), k1 = b - a, k2 = c - a, k4 = a - b - c + d;
    o[0] = a + k1 * ux + k2 * uz + k4 * ux * uz; o[1] = dux * (k1 + k4 * uz); o[2] = duz * (k2 + k4 * ux);
  }
  var NO = [0, 0, 0];
  function eroded(x, z, oct) {
    var s = 0, b = 0.5, dx = 0, dz = 0, px = x, pz = z;
    for (var i = 0; i < oct; i++) {
      noised(px, pz, NO); dx += NO[1]; dz += NO[2];
      s += b * NO[0] / (1 + dx * dx + dz * dz); b *= 0.5;
      var nx = 1.6 * px - 1.2 * pz, nz = 1.2 * px + 1.6 * pz; px = nx + 3.1; pz = nz - 1.7;
    }
    return s;
  }
  function relief(x, z, d, sm) {
    var a = 4 + 520 * Math.pow(SS(110, 2400, d), 1.15);
    var m = a * (ridged(x * 0.0012, z * 0.0012, 5) - 0.42 * (1 - SS(0, 700, d)));
    var mid = (3 + 16 * SS(15, 320, d)) * (1 - 0.6 * sm) * (eroded(x * 0.011 + 11, z * 0.011 + 5, 6) * 2.6 - 0.9);
    var big = 46 * SS(150, 700, d) * (1 - SS(1400, 2400, d)) * (eroded(x * 0.0035 - 4, z * 0.0035 + 9, 5) * 2.4 - 0.8);
    var det = 0.9 * (G.fbm(x * 0.11, z * 0.11 + 7, 3) * 2 - 1);
    return m + mid + big + det;
  }
  function terrainH(x, z) {
    var d = fieldAt(DF, x, z), R = fieldAt(RF, x, z), sm = sandMask(x, z);
    var h = R + relief(x, z, d, sm);
    if (sm > 0) h += sm * (3.6 * Math.pow(1 - Math.abs(2 * G.vnoise(x * 0.016 + z * 0.006, z * 0.02 - x * 0.004) - 1), 1.6) + 1.1 * (G.vnoise(x * 0.07, z * 0.07) - 0.5));
    h += modAt(x, z);
    var dr = riverDist(x, z), W = waterLevel(z), e = Math.max(0, dr - 7);
    var hv = W + (dr < 7 ? -1.4 * (1 - SS(0, 7, dr)) : e * (1.12 + 0.55 * (ridged(x * 0.03, z * 0.03, 3) - 0.4)) + 0.012 * e * e);
    if (hv < h) h = hv;
    lastRd = 99; lastWet = 0;
    var nr = d < 80 ? nearest(x, z) : null;
    if (nr) {
      lastRd = nr.d;
      if (!isBridge[nr.i]) {
        var bw = 9, wc = 1 - SS(Wc + 0.8, Wc + 0.8 + bw, nr.d);
        if (wc > 0) {
          var berm = 0.3 * Math.exp(-Math.pow((nr.d - (half + 1.6)) / 1.2, 2)) * SS(half + 0.2, half + 0.9, nr.d) + 0.22 * (G.vnoise(x * 0.6, z * 0.6) - 0.35) * SS(half - 0.2, half + 0.8, nr.d) * (1 - SS(half + 3, half + 6, nr.d));
          h = LP(h, nr.y + berm, wc);
        }
      }
    }
    return h;
  }

  /* ---------- 网格：内圈（高精度）+ 外圈（粗，远山） ---------- */
  var IC = 3.2, OC = 96;
  var ix0 = -864, ix1 = 768, iz0 = -480, iz1 = 672;
  var inx = Math.round((ix1 - ix0) / IC) + 1, inz = Math.round((iz1 - iz0) / IC) + 1;
  var ox0 = -4800, oz0 = -4800, onx = 101, onz = 101;
  var OG = new Float32Array(onx * onz);
  for (j = 0; j < onz; j++) for (i = 0; i < onx; i++) OG[j * onx + i] = terrainH(ox0 + i * OC, oz0 + j * OC);
  var coarseH = function (x, z) {
    var u = (x - ox0) / OC, v = (z - oz0) / OC, a = Math.max(0, Math.min(onx - 2, Math.floor(u))), b = Math.max(0, Math.min(onz - 2, Math.floor(v)));
    return bilin(OG, onx, a, b, CL(u - a, 0, 1), CL(v - b, 0, 1));
  };
  var HG = new Float32Array(inx * inz), RD = new Float32Array(inx * inz);
  for (j = 0; j < inz; j++) for (i = 0; i < inx; i++) {
    var wx = ix0 + i * IC, wz = iz0 + j * IC, hh = terrainH(wx, wz);
    RD[j * inx + i] = lastRd;
    var edge = Math.min(wx - ix0, ix1 - wx, wz - iz0, iz1 - wz), we = 1 - SS(0, 240, edge);
    if (we > 0) hh = LP(hh, coarseH(wx, wz), we);
    HG[j * inx + i] = hh;
  }
  // 岩石破碎：陡坡与路远处叠加高频脊状位移（避开路面走廊）
  var HG2 = new Float32Array(HG);
  for (j = 1; j < inz - 1; j++) for (i = 1; i < inx - 1; i++) {
    var gxs = (HG[j * inx + i + 1] - HG[j * inx + i - 1]) / (2 * IC), gzs = (HG[(j + 1) * inx + i] - HG[(j - 1) * inx + i]) / (2 * IC), slope = Math.sqrt(gxs * gxs + gzs * gzs);
    var rdn = RD[j * inx + i], keep = SS(Wc + 2.5, Wc + 9, rdn);
    var amp = (3.4 * SS(0.6, 1.3, slope) + 0.4 * SS(0.2, 0.6, slope)) * keep;
    if (amp > 0.02) { var wxr = ix0 + i * IC, wzr = iz0 + j * IC; HG2[j * inx + i] += amp * ((ridged(wxr * 0.085, wzr * 0.085, 3) - 0.45) * 1.4 + (ridged(wxr * 0.19 + 7, wzr * 0.19, 2) - 0.45) * 0.7); }
  }
  HG = HG2;
  var hInner = function (x, z) {
    var u = (x - ix0) / IC, v = (z - iz0) / IC;
    if (u < 0 || v < 0 || u > inx - 1.001 || v > inz - 1.001) return coarseH(x, z);
    var a = Math.floor(u), b = Math.floor(v);
    return bilin(HG, inx, a, b, u - a, v - b);
  };
  T.terrainHeight = hInner;

  /* ---------- 山体阴影烘焙（低角度夕阳 -> 山谷长影） ---------- */
  var SUN = G.SUN_DIR, sH = Math.hypot(SUN.x, SUN.z), sdx = SUN.x / sH, sdz = SUN.z / sH, tanEl = SUN.y / sH;
  function sunAt(x, z, h0) {
    var t = 5, occ = 0;
    for (var n = 0; n < 130 && t < 1500; n++) {
      var hp = hInner(x + sdx * t, z + sdz * t), o = (hp - (h0 + t * tanEl)) / (4 + 0.05 * t);
      if (o > occ) { occ = o; if (occ >= 1) break; }
      t += 3 + t * 0.045;
    }
    return 1 - CL(occ, 0, 1);
  }
  T.sunAt = sunAt;

  /* ---------- 地表材质权重 [草, 岩, 土/碎石, 沙] + 色调（乘在贴图上，≈1） ---------- */
  var tGreen = new THREE.Color(0.92, 0.97, 0.8), tDry = new THREE.Color(1.1, 1.02, 0.84), tForest = new THREE.Color(0.78, 0.84, 0.74),
      tRockW = new THREE.Color(0.86, 0.8, 0.74), tRockC = new THREE.Color(0.7, 0.72, 0.74), tRiver = new THREE.Color(0.9, 0.92, 0.95);
  var colTmp = new THREE.Color(), cA = new THREE.Color(), wM = [1, 0, 0, 0], cSnow = new THREE.Color(2.1, 2.15, 2.3);
  function colorAt(x, z, h, slope, rd) {
    var f = G.fbm(x * 0.006 + 3, z * 0.006 - 9, 4), f2 = G.fbm(x * 0.05, z * 0.05, 3);
    var forest = SS(0.46, 0.6, G.fbm(x * 0.0045 + 21, z * 0.0045 + 7, 4)) * (1 - SS(125, 165, h));
    var sm = sandMask(x, z), dr = riverDist(x, z), W = waterLevel(z), river = dr < 24 && h < W + 6 ? SS(24, 9, dr) : 0;
    var rock = SS(0.62, 1.1, slope + (f2 - 0.5) * 0.4) + 0.5 * SS(140, 230, h) * SS(0.62, 0.8, f2);
    rock = CL(rock, 0, 1);
    var sand = sm > 0 ? SS(0.08, 0.55, sm + (f2 - 0.5) * 0.25) * (1 - rock) : 0;
    var road = rd < Wc + 5 ? 1 - SS(Wc - 0.5, Wc + 5, rd + (f2 - 0.5) * 3) : 0;
    var dirt = Math.max(forest * 0.45, road * 0.85, river * 0.95, SS(0.66, 0.8, f2) * 0.3) * (1 - rock) * (1 - sand);
    var grass = Math.max(0, 1 - rock - sand - dirt);
    wM[0] = grass; wM[1] = rock; wM[2] = dirt; wM[3] = sand;
    cA.copy(tGreen).lerp(tDry, SS(0.35, 0.72, f) * (1 - forest));
    cA.lerp(tForest, forest);
    var kg = grass + dirt * (1 - river), rk = f2 > 0.5 ? tRockW : tRockC, kr = dirt * river;
    colTmp.setRGB(cA.r * kg + rk.r * rock + tRiver.r * kr + sand * 0.82, cA.g * kg + rk.g * rock + tRiver.g * kr + sand * 0.8, cA.b * kg + rk.b * rock + tRiver.b * kr + sand * 0.78);
    var v = 0.9 + (f2 - 0.5) * 0.25; colTmp.multiplyScalar(v);
    var snow = SS(300, 380, h + (f - 0.5) * 70) * (1 - SS(0.9, 1.4, slope));   // 远处天山雪线
    if (snow > 0) { colTmp.lerp(cSnow, snow); wM[1] = Math.max(wM[1], snow); wM[0] *= 1 - snow; wM[3] *= 1 - snow; }
    return colTmp;
  }
  colorAt.w = wM;

  function buildTerrain(nx, nz, x0, z0, cell, H, RDa, skipHole) {
    var cnt = nx * nz, pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3), sun = new Float32Array(cnt), mw = new Float32Array(cnt * 4);
    var hs = function (a, b) { return H[Math.max(0, Math.min(nz - 1, b)) * nx + Math.max(0, Math.min(nx - 1, a))]; };
    for (var b = 0; b < nz; b++) for (var a = 0; a < nx; a++) {
      var o = b * nx + a, x = x0 + a * cell, z = z0 + b * cell, h = H[o];
      var gx2 = (hs(a + 1, b) - hs(a - 1, b)) / (2 * cell), gz2 = (hs(a, b + 1) - hs(a, b - 1)) / (2 * cell);
      var nl = 1 / Math.sqrt(gx2 * gx2 + 1 + gz2 * gz2);
      pos[o * 3] = x; pos[o * 3 + 1] = h; pos[o * 3 + 2] = z;
      nor[o * 3] = -gx2 * nl; nor[o * 3 + 1] = nl; nor[o * 3 + 2] = -gz2 * nl;
      var c = colorAt(x, z, h, Math.sqrt(gx2 * gx2 + gz2 * gz2), RDa ? RDa[o] : 99);
      col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b;
      mw[o * 4] = wM[0]; mw[o * 4 + 1] = wM[1]; mw[o * 4 + 2] = wM[2]; mw[o * 4 + 3] = wM[3];
      sun[o] = sunAt(x, z, h + 0.5);
    }
    var idx = [];
    for (b = 0; b < nz - 1; b++) for (a = 0; a < nx - 1; a++) {
      if (skipHole) { var cx = x0 + a * cell, cz = z0 + b * cell; if (cx >= ix0 - 1e-3 && cx + cell <= ix1 + 1e-3 && cz >= iz0 - 1e-3 && cz + cell <= iz1 + 1e-3) continue; }
      var i0 = b * nx + a, i1 = i0 + 1, i2 = i0 + nx, i3 = i2 + 1;
      idx.push(i0, i2, i1, i1, i2, i3);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('aSun', new THREE.BufferAttribute(sun, 1));
    g.setAttribute('aMat', new THREE.BufferAttribute(mw, 4));
    g.setIndex(new THREE.BufferAttribute(cnt > 65000 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    g.computeBoundingSphere();
    return g;
  }
  var terrMat = MT.terrainMaterial();
  var tInner = new THREE.Mesh(buildTerrain(inx, inz, ix0, iz0, IC, HG, RD, false), terrMat);
  tInner.receiveShadow = true; scene.add(tInner);
  var tOuter = new THREE.Mesh(buildTerrain(onx, onz, ox0, oz0, OC, OG, null, true), terrMat);
  tOuter.receiveShadow = true; tOuter.frustumCulled = false; scene.add(tOuter);

  return MT.buildRest(scene, def, T, renderer, {
    P: P, TAN: TAN, RIGHT: RIGHT, N: N, D: D, K: Ks, LEN: LEN, sc: sc, L0: L0, roadY: roadY, isBridge: isBridge, surf: surf, half: half, SW: SW, Wc: Wc,
    hInner: hInner, sunAt: sunAt, riverX: riverX, waterLevel: waterLevel, riverDist: riverDist, sandMask: sandMask, mL: mL, mR: mR, idxAtN: idxAtN, sn: sn,
    bounds: [ix0, ix1, iz0, iz1], nearest: nearest, colorAt: colorAt,
    terrain: { geometry: tInner.geometry, x0: ix0, z0: iz0, cell: IC, nx: inx, nz: inz }
  });
};

/* ---------- 材质：地形（三平面细节 + 烘焙山影）、路面（四种路况混合）、河水 ---------- */
/* ---------- 地表贴图：高原草甸 / 层状岩石 / 碎石土（程序化 PBR，可平铺） ---------- */
MT.groundTex = function () {
  if (MT._gt) return MT._gt;
  var P = G.PBR;
  var grass = P.make('mtGrass', 512, 512, 2.2, function (u, v, o, x, y) {
    var big = G.pFbm(u, v, 3, 4, 31), clump = G.pFbm(u, v, 18, 3, 33), fine = G.pNoise(u * 140, v * 140, 140, 140, 35), px = G.pHash(x, y, 37);
    var blade = G.pNoise(u * 260, v * 60, 260, 60, 39) * 0.5 + G.pNoise(u * 70, v * 240, 70, 240, 41) * 0.5;
    var dry = G.SS(0.42, 0.68, big + (clump - 0.5) * 0.4), gap = G.SS(0.42, 0.3, clump * 0.7 + fine * 0.3) * 0.5;
    var k = (0.8 + 0.35 * blade + 0.1 * (px - 0.5)) * (1 - 0.35 * gap);
    o.r = LP(0.31, 0.55, dry) * k; o.g = LP(0.34, 0.49, dry) * k; o.b = LP(0.19, 0.3, dry) * k;
    if (gap > 0.5) { o.r = LP(o.r, 0.24, 0.5); o.g = LP(o.g, 0.19, 0.5); o.b = LP(o.b, 0.13, 0.5); }
    o.h = clump * 0.5 + blade * 0.4 - gap * 0.3; o.ro = 0.93;
  });
  var rock = P.make('mtRock2', 512, 512, 3.0, function (u, v, o, x, y) {
    var w = G.pFbm(u, v, 4, 3, 51), str = Math.sin((v * 9 + w * 0.6) * TAU) * 0.5 + 0.5, str2 = Math.sin((v * 31 + w * 1.2) * TAU) * 0.5 + 0.5;
    var n = G.pFbm(u, v, 8, 5, 53), streak = G.pNoise(u * 48, v * 5, 48, 5, 63), grain = G.pNoise(u * 180, v * 180, 180, 180, 65);
    var cr = 1 - Math.abs(G.pNoise(u * 20, v * 3, 20, 3, 55) * 2 - 1), crack = G.SS(0.96, 0.995, cr) * G.SS(0.4, 0.6, streak);
    var lich = G.SS(0.7, 0.78, G.pFbm(u, v, 10, 3, 59)) * G.SS(0.5, 0.7, n);
    var k = (0.66 + 0.4 * n + 0.1 * str2 - 0.08 * str + 0.16 * (streak - 0.5) + 0.1 * (grain - 0.5)) * (1 - 0.45 * crack) * (0.95 + 0.1 * G.pHash(x, y, 61));
    o.r = 0.44 * k; o.g = 0.41 * k; o.b = 0.375 * k;
    o.r = LP(o.r, 0.46, lich * 0.45); o.g = LP(o.g, 0.45, lich * 0.45); o.b = LP(o.b, 0.3, lich * 0.45);
    o.h = n * 0.6 + str * 0.2 + grain * 0.15 - crack * 0.5; o.ro = 0.86 - 0.12 * n;
  });
  var dirt = P.make('mtDirt', 512, 512, 2.6, function (u, v, o, x, y) {
    var n = G.pFbm(u, v, 6, 5, 71), st = G.pNoise(u * 48, v * 48, 48, 48, 73), st2 = G.pNoise(u * 110, v * 110, 110, 110, 75), px = G.pHash(x, y, 77);
    var peb = G.SS(0.6, 0.75, st * 0.6 + st2 * 0.4), peb2 = G.SS(0.7, 0.8, st2), tone = G.pFbm(u, v, 3, 3, 79);
    var k = (0.82 + 0.3 * (n - 0.5) * 2 * 0.5) * (0.95 + 0.1 * px);
    o.r = LP(0.42 + 0.08 * tone, 0.55, peb) * k; o.g = LP(0.35 + 0.06 * tone, 0.5, peb) * k; o.b = LP(0.27 + 0.04 * tone, 0.44, peb) * k;
    if (peb2 > 0.5) { o.r *= 0.85; o.g *= 0.85; o.b *= 0.85; }
    o.h = n * 0.4 + peb * 0.5 + peb2 * 0.2; o.ro = 0.92;
  });
  return (MT._gt = { grass: grass, rock: rock, dirt: dirt, sand: MT.surfTex().s });
};

/* ---------- 材质：地形（四层贴图按权重+高度混合，岩石三平面投影，烘焙山影） ---------- */
MT.terrainMaterial = function () {
  var T4 = MT.groundTex();
  var m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  m.onBeforeCompile = function (sh) {
    var U = sh.uniforms;
    U.tG = { value: T4.grass.map }; U.tR = { value: T4.rock.map }; U.tD = { value: T4.dirt.map }; U.tS = { value: T4.sand.map };
    U.nG = { value: T4.grass.normalMap }; U.nR = { value: T4.rock.normalMap }; U.nD = { value: T4.dirt.normalMap }; U.nS = { value: T4.sand.normalMap };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSun; attribute vec4 aMat; varying float vSun; varying vec4 vMat; varying vec3 vWPos; varying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSun = aSun; vMat = aMat; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', [
      '#include <common>',
      'uniform sampler2D tG, tR, tD, tS, nG, nR, nD, nS; varying float vSun; varying vec4 vMat; varying vec3 vWPos; varying vec3 vWN;',
      'vec3 dec(vec3 c){', '#if __VERSION__ >= 300', '  return c;', '#else', '  return pow(c, vec3(2.2));', '#endif', '}'].join('\n'))
      .replace('#include <map_fragment>', [
        'vec3 nw = normalize(vWN); vec2 pY = vWPos.xz;',
        'vec3 bw = pow(abs(nw), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);',
        'vec2 uG = pY * 0.22, uD = pY * 0.5, uS = pY * 0.17, uX = vWPos.zy * 0.07, uY = pY * 0.07, uZ = vWPos.xy * 0.07;',
        'float abm = smoothstep(0.3, 0.7, texture2D(tD, pY * 0.013 + 0.71).r * 4.0);',
        'vec3 cG = mix(texture2D(tG, uG).rgb, texture2D(tG, vec2(uG.y, -uG.x) * 0.31 + 0.5).rgb, 0.2 + 0.6 * abm), cD = mix(texture2D(tD, uD).rgb, texture2D(tD, vec2(-uD.y, uD.x) * 0.37 + 0.2).rgb, 0.8 - 0.6 * abm), cS = vec3(0.3);',
        'if (vMat.w > 0.001) cS = texture2D(tS, uS).rgb;',
        'float fdist = smoothstep(50.0, 420.0, length(vViewPosition));',
        'cG = mix(cG, texture2D(tG, uG, 8.0).rgb, fdist * 0.85); cD = mix(cD, texture2D(tD, uD, 8.0).rgb, fdist * 0.7);',
        'vec3 cR = vec3(0.12);',
        'if (vMat.y > 0.001) cR = texture2D(tR, uX).rgb * bw.x + texture2D(tR, uY).rgb * bw.y + texture2D(tR, uZ).rgb * bw.z;',
        // 高度混合：石块从草里露出、草从土缝里长出，而不是糊开的渐变
        'vec4 hg = sqrt(vec4(dot(cG, vec3(0.36)), dot(cR, vec3(0.25)), dot(cD, vec3(0.2)), dot(cS, vec3(0.16)))) + vec4(0.0, 0.08, 0.0, 0.0);',
        'float bn = texture2D(tG, pY * 0.043 + 0.31).g * 2.0 - 0.25;',
        'vec4 Wh = vMat + hg * 0.35 + vec4(0.0, 0.0, bn * 0.3, -bn * 0.15); float mx = max(max(Wh.x, Wh.y), max(Wh.z, Wh.w));',
        'vec4 W = max(Wh - mx + 0.42, 0.0) * step(0.002, vMat); W /= (W.x + W.y + W.z + W.w + 1e-4);',
        'vec3 col = dec(cG) * W.x + dec(cR) * W.y + dec(cD) * W.z + dec(cS) * W.w;',
        // 大尺度明暗变化，打破贴图重复
        'float mac = texture2D(tD, pY * 0.0071).r * 0.6 + texture2D(tG, pY * 0.0023 + 0.37).g * 0.4;',
        'col *= 0.8 + 0.5 * smoothstep(0.02, 0.22, mac);',
        'diffuseColor.rgb *= col;'].join('\n'))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = 0.95 - 0.1 * W.y;')
      .replace('#include <normal_fragment_maps>', [
        'vec3 tn = (texture2D(nG, uG).xyz * 2.0 - 1.0) * W.x + (texture2D(nD, uD).xyz * 2.0 - 1.0) * W.z;',
        'if (W.w > 0.0) tn += (texture2D(nS, uS).xyz * 2.0 - 1.0) * W.w;',
        'tn *= vec3(1.0 - 0.8 * fdist, 1.0 - 0.8 * fdist, 1.0);',
        'vec3 wP = vec3(tn.x + nw.x * (1.0 - W.y), abs(tn.z) * nw.y, tn.y + nw.z * (1.0 - W.y)), wR = vec3(0.0);',
        'if (W.y > 0.0) {',
        'vec3 rX = texture2D(nR, uX).xyz * 2.0 - 1.0; rX = vec3(rX.xy + nw.zy, abs(rX.z) * nw.x);',
        'vec3 rY = texture2D(nR, uY).xyz * 2.0 - 1.0; rY = vec3(rY.xy + nw.xz, abs(rY.z) * nw.y);',
        'vec3 rZ = texture2D(nR, uZ).xyz * 2.0 - 1.0; rZ = vec3(rZ.xy + nw.xy, abs(rZ.z) * nw.z);',
        'wR = rX.zyx * bw.x + rY.xzy * bw.y + rZ.xyz * bw.z; }',
        'normal = normalize(mat3(viewMatrix) * normalize(wP + wR * W.y));'].join('\n'))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nfloat sunK = mix(0.1, 1.0, vSun); reflectedLight.directDiffuse *= sunK; reflectedLight.directSpecular *= sunK;');
  };
  m.customProgramCacheKey = function () { return 'mt-terrain2'; };
  return m;
};

MT.surfTex = function () {
  if (MT._st) return MT._st;
  var P = G.PBR, a = P.asphalt();
  var gravel = P.make('mtGravel', 512, 512, 2.4, function (u, v, o, x, y) {
    var st = G.pNoise(u * 70, v * 70, 70, 70, 3), st2 = G.pNoise(u * 160, v * 160, 160, 160, 5), px = G.pHash(x, y, 9);
    var big = G.pFbm(u, v, 5, 3, 7), tone = G.pNoise(u * 30, v * 30, 30, 30, 13), stone = G.SS(0.5, 0.8, st * 0.45 + st2 * 0.6) * 0.6;
    var k = 0.92 + 0.14 * px;
    o.r = LP(0.36 + 0.1 * (big - 0.5), 0.47 + 0.14 * (tone - 0.5), stone) * k;
    o.g = LP(0.29 + 0.08 * (big - 0.5), 0.41 + 0.12 * (tone - 0.5), stone) * k;
    o.b = LP(0.22 + 0.06 * (big - 0.5), 0.34 + 0.1 * (tone - 0.5), stone) * k;
    o.h = stone * 0.8 + px * 0.2; o.ro = 0.9;
  });
  var mud = P.make('mtMud2', 512, 512, 2.6, function (u, v, o, x, y) {
    var n = G.pFbm(u, v, 5, 4, 21), px = G.pHash(x, y, 23), wet = G.SS(0.52, 0.4, G.pFbm(u, v, 4, 3, 27));
    var st = G.pNoise(u * 60, v * 60, 60, 60, 25), st2 = G.pNoise(u * 140, v * 140, 140, 140, 29), peb = G.SS(0.66, 0.8, st * 0.55 + st2 * 0.5);
    var clod = G.SS(0.55, 0.75, G.pFbm(u, v, 16, 3, 31)), k = (0.78 + 0.42 * n) * (1 - 0.25 * wet) * (0.9 + 0.2 * px) * (1 - 0.2 * clod);
    o.r = LP(0.27 * k, 0.4, peb * 0.7); o.g = LP(0.23 * k, 0.37, peb * 0.7); o.b = LP(0.18 * k, 0.32, peb * 0.7);
    o.h = 0.5 * n + 0.15 * px - 0.15 * wet + 0.5 * peb + 0.25 * clod; o.ro = LP(LP(0.92, 0.35, wet), 0.8, peb);
  });
  var sand = P.make('mtSand', 256, 256, 1.4, function (u, v, o, x, y) {
    var rp = Math.sin((u * 14 + 0.9 * G.pFbm(u, v, 3, 3, 5)) * TAU) * 0.5 + 0.5, gr = G.pHash(x, y, 4), n = G.pFbm(u, v, 6, 3, 9);
    var k = 0.93 + 0.12 * (n - 0.5) - 0.03 * rp + 0.06 * (gr - 0.5);
    o.r = 0.72 * k; o.g = 0.6 * k; o.b = 0.43 * k; o.h = rp * 0.25 + gr * 0.15 + n * 0.3; o.ro = 0.95;
  });
  return (MT._st = { a: a, l: gravel, m: mud, s: sand });
};

MT.roadMaterial = function (half) {
  var T4 = MT.surfTex();
  var m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  m.onBeforeCompile = function (sh) {
    var U = sh.uniforms;
    U.tA = { value: T4.a.map }; U.tL = { value: T4.l.map }; U.tM = { value: T4.m.map }; U.tS = { value: T4.s.map };
    U.nA = { value: T4.a.normalMap }; U.nL = { value: T4.l.normalMap }; U.nM = { value: T4.m.normalMap }; U.nS = { value: T4.s.normalMap };
    U.rM = { value: T4.m.roughnessMap }; U.uHalf = { value: half }; U.tK = { value: MT.crackTex() };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aSurf; attribute float aSun; varying vec4 vSurf; varying float vSun; varying vec2 vRUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf; vSun = aSun; vRUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', [
      '#include <common>',
      'uniform sampler2D tA, tL, tM, tS, nA, nL, nM, nS, rM, tK; uniform float uHalf; varying vec4 vSurf; varying float vSun; varying vec2 vRUv;',
      'vec3 dec(vec3 c){', '#if __VERSION__ >= 300', '  return c;', '#else', '  return pow(c, vec3(2.2));', '#endif', '}',
      'vec3 perturbN(vec3 eye, vec3 sn, vec3 mapN, vec2 uv, float fd){ vec3 q0 = dFdx(eye), q1 = dFdy(eye); vec2 s0 = dFdx(uv), s1 = dFdy(uv);',
      '  vec3 q1p = cross(q1, sn), q0p = cross(sn, q0); vec3 T = q1p * s0.x + q0p * s1.x, B = q1p * s0.y + q0p * s1.y;',
      '  float det = max(dot(T, T), dot(B, B)); float sc = (det == 0.0) ? 0.0 : fd * inversesqrt(det);',
      '  return normalize(T * (mapN.x * sc) + B * (mapN.y * sc) + sn * mapN.z); }'].join('\n'))
      .replace('#include <map_fragment>', [
        'vec4 W = vSurf; float nl = texture2D(tL, vRUv * 0.21).r;',
        'W *= vec4(1.0, 0.85 + 0.3 * nl, 0.6 + 0.8 * nl, 1.0); W /= (W.x + W.y + W.z + W.w + 1e-4);',
        'vec2 uvA = vRUv * 1.8, uvL = vRUv * 2.4, uvM = vRUv * 1.9, uvS = vRUv * 0.9;',
        'float lat = vRUv.x * 6.0, sPos = vRUv.y * 6.0, al = abs(lat);',
        // 路面结构：压实的轮迹带 / 中央与路边的松散碎石埂（windrow）/ 路缘堆积的浮尘
        'float trk = exp(-pow((al - 0.85) / 0.34, 2.0)), ridge = exp(-pow(al / 0.32, 2.0)) + exp(-pow((al - (uHalf - 0.45)) / 0.5, 2.0)), edge = smoothstep(uHalf - 1.3, uHalf + 0.3, al);',
        'vec4 K = texture2D(tK, vRUv * vec2(1.3, 0.55) + 0.1), K2 = texture2D(tK, vRUv * 0.09 + 0.6);',
        // 沙石混凝土：修补块、网状裂缝、轮迹磨光变暗、路边积尘
        'vec3 cA = dec(texture2D(tA, uvA).rgb) * 0.48 * (0.88 + 0.24 * K2.r);',
        'float patchM = smoothstep(0.6, 0.63, K2.b); cA *= mix(1.0, 0.86, patchM);',
        'float crk = smoothstep(0.978, 0.993, K.g) * (0.35 + 0.5 * edge + 0.4 * patchM); cA *= 1.0 - 0.4 * crk;',
        'cA *= mix(1.0, 0.82, trk * (1.0 - edge));',
        'cA = mix(cA, dec(texture2D(tS, uvS * 1.7).rgb) * vec3(0.72, 0.66, 0.58), edge * (0.45 + 0.3 * K.r));',
        // 碎石土路：轮迹压实发亮、碎石埂更粗更杂、轮迹里的搓板波
        'vec3 cL0 = dec(texture2D(tL, uvL).rgb) * vec3(0.84, 0.81, 0.76), cL1 = dec(texture2D(tL, uvL * 2.7 + 0.3).rgb) * vec3(0.86, 0.83, 0.78);',
        'cL0 = mix(cL0, vec3(dot(cL0, vec3(0.333))), 0.3);',
        'vec3 cBase = dec(texture2D(tS, uvS * 2.2 + 0.2).rgb) * vec3(0.66, 0.62, 0.56) * (0.9 + 0.2 * K.r);',
        'cL0 = mix(cBase, cL0, (0.3 + 0.55 * ridge) * (1.0 - 0.7 * trk));',
        'vec3 cL = mix(cL0, vec3(dot(cL0, vec3(0.333))) * vec3(1.12, 1.04, 0.92), trk * 0.75);',
        'cL = mix(cL, cL1 * 1.1, ridge * 0.75);',
        'float wash = 0.5 + 0.5 * sin(sPos * 7.0 + 2.5 * nl);',
        'cL *= 1.0 - 0.0 * wash * trk;',
        // 沙地：轮迹里沙纹被压平、色深，两侧挤出松沙埂
        'float tread = smoothstep(0.3, 0.12, abs(al - 0.82));',
        'vec3 cS = mix(dec(texture2D(tS, uvS).rgb), dec(texture2D(tS, uvS * 3.1 + 0.5).rgb) * 0.82, trk) * (1.0 - 0.22 * tread);',
        'cS *= 1.0 + 0.12 * exp(-pow((al - 1.35) / 0.25, 2.0));',
        'vec3 col = cA * W.x + cL * W.y + dec(texture2D(tM, uvM).rgb) * W.z + cS * W.w;',
        // 沥青段：虚线中线 + 两侧白线（带磨损）
        'float asp = smoothstep(0.55, 0.92, vSurf.x); float wear = 0.45 + 0.55 * texture2D(tL, vRUv * 0.5 + 0.3).r;',
        'float dash = step(fract(sPos / 10.0), 0.3);',
        'float cl = smoothstep(0.1, 0.06, abs(lat)) * dash; float el = smoothstep(0.11, 0.07, abs(abs(lat) - (uHalf - 0.3)));',
        'col = mix(col, vec3(0.62, 0.47, 0.12), cl * asp * wear); col = mix(col, vec3(0.62, 0.62, 0.58), el * asp * wear);',
        // 土路/泥地：两道车辙略深
        'float rut = exp(-pow((abs(lat) - 0.85) / 0.3, 2.0)); col *= 1.0 - rut * (W.z * 0.32 + W.w * 0.2);',
        'diffuseColor.rgb *= col;',
        // 积水坑：泥地/碎石路车辙里的浅水，反射天空
        'float pud = smoothstep(0.5, 0.41, texture2D(rM, vRUv * 0.19 + 0.3).r) * smoothstep(0.35, 0.6, texture2D(rM, vRUv * 0.83 + 0.11).r + 0.15) * clamp(W.z * 1.3 + W.y * 0.25, 0.0, 1.0) * smoothstep(0.25, 0.75, rut) * (1.0 - smoothstep(0.55, 0.9, abs(lat) / uHalf));',
        'float wetR = rut * W.z * 0.6;',
        'diffuseColor.rgb *= (1.0 - 0.45 * pud) * (1.0 - 0.25 * wetR);'].join('\n'))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(mix(W.x * 0.93 + W.y * 0.95 + W.z * texture2D(rM, uvM).r + W.w * 0.96, 0.25, wetR), 0.1, pud);')
      .replace('#include <normal_fragment_maps>', [
        'vec3 nA2 = texture2D(nA, uvA).xyz * 2.0 - 1.0, nL2 = texture2D(nL, uvL).xyz * 2.0 - 1.0, nM2 = texture2D(nM, uvM).xyz * 2.0 - 1.0, nS2 = texture2D(nS, uvS).xyz * 2.0 - 1.0;',
        'vec3 mapN = nA2 * W.x * (0.45 + 0.6 * crk) + nL2 * W.y * (0.25 + 0.6 * ridge - 0.15 * trk) + nM2 * W.z * 0.8 + nS2 * W.w * (0.35 - 0.28 * trk);',
        'mapN.y += W.y * trk * 0.03 * cos(sPos * 7.0 + 2.5 * nl);',
        'normal = normalize(mix(perturbN(-vViewPosition, normal, mapN, vRUv, faceDirection), normal, pud));'].join('\n'))
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nfloat sunK = mix(0.1, 1.0, vSun); reflectedLight.directDiffuse *= sunK; reflectedLight.directSpecular *= sunK;');
  };
  m.customProgramCacheKey = function () { return 'mt-road'; };
  return m;
};

// 路面噪声图：r = fbm，g = 脊状噪声（细线=裂缝），b = 大块斑块（修补块）
MT.crackTex = function () {
  if (MT._ck) return MT._ck;
  var S = 512, d = new Uint8Array(S * S * 4);
  for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) {
    var u = x / S, v = y / S, j = (y * S + x) * 4;
    var wu = u + 0.03 * G.pFbm(u, v, 6, 3, 201), wv = v + 0.03 * G.pFbm(u, v, 6, 3, 203);
    d[j] = G.pFbm(u, v, 5, 5, 205) * 255; d[j + 1] = (1 - Math.abs(G.pFbm(wu, wv, 7, 4, 207) * 2 - 1)) * 255; d[j + 2] = G.pFbm(u, v, 3, 3, 209) * 255; d[j + 3] = 255;
  }
  var t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return (MT._ck = t);
};
// 河水：沿河道流动的三层法线 + 流动噪声驱动的白水泡沫；中心深、岸边浅（可见河床），菲涅耳反射天空与太阳高光
MT.waterMaterial = function () {
  var nrm = G.PBR.waterNormal(), holder = { uniforms: { time: { value: 0 } } };
  var flow = G.PBR.make('mtFlow', 256, 256, 0, function (u, v, o) { var n = G.pFbm(u, v, 4, 5, 141), r = 1 - Math.abs(G.pFbm(u, v, 8, 3, 143) * 2 - 1); o.r = o.g = o.b = 0.5; o.h = 0; o.ro = CL(n * 0.7 + r * r * 0.5 - 0.1, 0, 1); });
  var m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, envMapIntensity: 1.25, depthWrite: false });
  m.onBeforeCompile = function (sh) {
    sh.uniforms.time = holder.uniforms.time; sh.uniforms.tN = { value: nrm }; sh.uniforms.tF = { value: flow.roughnessMap };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aRiv; varying vec3 vRiv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRiv = aRiv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float time; uniform sampler2D tN, tF; varying vec3 vRiv;')
      .replace('#include <map_fragment>', [
        'float ax = abs(vRiv.x), dep = 1.0 - smoothstep(0.4, 1.0, ax), rap = vRiv.z, fl = time * (0.8 + 0.9 * rap);',
        'vec2 q = vec2(vRiv.x * 3.2, vRiv.y * 0.16);',
        'float f1 = texture2D(tF, q + vec2(0.0, -fl * 0.12)).r, f2 = texture2D(tF, q * vec2(2.6, 2.1) + vec2(0.37, -fl * 0.31)).r;',
        'float fn = f1 * 0.55 + f2 * 0.45;',
        'float bank = smoothstep(0.88, 0.99, ax + (f2 - 0.5) * 0.2);',
        'float foam = clamp(smoothstep(0.7 - rap * 0.1, 0.84 - rap * 0.08, fn) * (0.08 + 0.6 * rap) + bank * smoothstep(0.45, 0.7, f1) * 0.8, 0.0, 1.0);',
        'foam *= smoothstep(0.0, 0.25, fn);',
        'vec3 wc = mix(vec3(0.075, 0.07, 0.05), vec3(0.012, 0.035, 0.034), dep);',
        'diffuseColor.rgb = mix(wc, vec3(0.62, 0.66, 0.66), foam);',
        'diffuseColor.a = mix(mix(0.3, 0.88, dep), 0.92, foam);'].join('\n'))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.035, 0.6, foam);')
      .replace('#include <normal_fragment_maps>', [
        'vec2 nuv = vec2(vRiv.x * 1.3, vRiv.y * 0.12);',
        'vec2 n1 = texture2D(tN, nuv + vec2(0.0, -fl * 0.2)).xy * 2.0 - 1.0;',
        'vec2 n2 = texture2D(tN, nuv * 2.7 + vec2(0.21, -fl * 0.45)).xy * 2.0 - 1.0;',
        'vec2 n3 = texture2D(tN, nuv * 0.4 + vec2(0.5, -fl * 0.08)).xy * 2.0 - 1.0;',
        'float amp = (0.16 + 0.55 * rap + 0.4 * foam) * (1.0 - 0.6 * smoothstep(40.0, 500.0, length(vViewPosition)));',
        'vec2 dn = (n1 * 0.6 + n2 * 0.45 + n3 * 0.8) * amp;',
        'normal = normalize(mat3(viewMatrix) * normalize(vec3(dn.x, 1.0, dn.y)));'].join('\n'));
  };
  m.customProgramCacheKey = function () { return 'mt-river2'; };
  return { mat: m, holder: holder };
};

/* ---------- 工具：实例化分块（每块独立包围球，便于视锥/阴影剔除） ---------- */
MT.chunks = function (scene, geo, mat, list, cell, cast, maxR) {
  var groups = {}, i;
  for (i = 0; i < list.length; i++) { var L = list[i], key = Math.floor(L[0] / cell) + '_' + Math.floor(L[2] / cell); (groups[key] || (groups[key] = [])).push(L); }
  var meshes = [];
  Object.keys(groups).forEach(function (key) {
    var g = groups[key], gg = geo.clone(), cx = 0, cz = 0, cy = 0, n;
    for (n = 0; n < g.length; n++) { cx += g[n][0]; cy += g[n][1]; cz += g[n][2]; } cx /= g.length; cy /= g.length; cz /= g.length;
    var rr = 0; for (n = 0; n < g.length; n++) rr = Math.max(rr, Math.hypot(g[n][0] - cx, g[n][1] - cy, g[n][2] - cz));
    var im = G.instanced(gg, mat, g, cast);
    gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), rr + (maxR || 20));
    im.frustumCulled = true; im.castShadow = !!cast;
    scene.add(im); meshes.push(im);
  });
  return meshes;
};

// 碎裂岩体：球体先做分形起伏，再被若干随机平面“切削”出平整断口（节理面），顶部略压扁、底部平切便于半埋
MT.rockVariant = function (seed, cuts, detail, squash, thin) {
  var g = new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position, v = new THREE.Vector3(), r = G.rng(seed), planes = [], k, i;
  for (k = 0; k < cuts; k++) {
    var th = r() * TAU, el = (r() - 0.35) * 1.6, n = new THREE.Vector3(Math.cos(th) * Math.cos(el), Math.sin(el), Math.sin(th) * Math.cos(el)).normalize();
    planes.push([n, 0.5 + r() * 0.35]);
  }
  planes.push([new THREE.Vector3(0, -1, 0), 0.45]);
  for (i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    var s = 0.85 + 0.35 * G.fbm(v.x * 1.3 + seed, v.y * 1.3 + v.z * 0.9, 4) + 0.06 * (G.vnoise(v.x * 6 + seed, v.y * 6 - v.z * 5) - 0.5);
    v.multiplyScalar(s);
    for (k = 0; k < planes.length; k++) { var t = v.dot(planes[k][0]) - planes[k][1]; if (t > 0) v.addScaledVector(planes[k][0], -t * 0.97); }
    p.setXYZ(i, v.x, v.y * (squash || 0.85), v.z * (thin || 1));
  }
  g.computeVertexNormals();
  return g;
};
MT.chunksVar = function (scene, geos, mat, list, cell, cast, maxR) {
  var parts = geos.map(function () { return []; });
  list.forEach(function (L, i) { parts[i % geos.length].push(L); });
  geos.forEach(function (g, k) { if (parts[k].length) MT.chunks(scene, g, mat, parts[k], cell, cast, maxR); });
};
// 岩石实例材质：世界空间三平面贴图，避免球面 UV 拉伸
MT.rockMaterial = function (rt) {
  var m = new THREE.MeshStandardMaterial({ roughness: 0.88 });
  m.onBeforeCompile = function (sh) {
    sh.uniforms.tR = { value: rt.map }; sh.uniforms.nR = { value: rt.normalMap };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vRW; varying vec3 vRN;')
      .replace('#include <begin_vertex>', ['#include <begin_vertex>',
        '#ifdef USE_INSTANCING', 'mat4 rM = modelMatrix * instanceMatrix;', '#else', 'mat4 rM = modelMatrix;', '#endif',
        'vRW = (rM * vec4(transformed, 1.0)).xyz; vRN = normalize(mat3(rM) * objectNormal);'].join('\n'));
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tR, nR; varying vec3 vRW; varying vec3 vRN;')
      .replace('#include <map_fragment>', [
        'vec3 rn = normalize(vRN); vec3 rb = abs(rn) * abs(rn); rb /= (rb.x + rb.y + rb.z);',
        'vec2 qX = vRW.zy * 0.4, qY = vRW.xz * 0.4, qZ = vRW.xy * 0.4;',
        'diffuseColor.rgb *= (texture2D(tR, qX).rgb * rb.x + texture2D(tR, qY).rgb * rb.y + texture2D(tR, qZ).rgb * rb.z) * 1.3;',
        'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.27, 0.22, 0.16) * (0.8 + 0.4 * texture2D(tR, qY * 3.0).g), smoothstep(0.45, 0.9, rn.y) * 0.3);'].join('\n'))
      .replace('#include <normal_fragment_maps>', [
        'vec3 aX = texture2D(nR, qX).xyz * 2.0 - 1.0; aX = vec3(aX.xy + rn.zy, abs(aX.z) * rn.x);',
        'vec3 aY = texture2D(nR, qY).xyz * 2.0 - 1.0; aY = vec3(aY.xy + rn.xz, abs(aY.z) * rn.y);',
        'vec3 aZ = texture2D(nR, qZ).xyz * 2.0 - 1.0; aZ = vec3(aZ.xy + rn.xy, abs(aZ.z) * rn.z);',
        'normal = normalize(mat3(viewMatrix) * normalize(aX.zyx * rb.x + aY.xzy * rb.y + aZ.xyz * rb.z));'].join('\n'));
  };
  m.customProgramCacheKey = function () { return 'mt-rock'; };
  return m;
};
// 双面植被卡片：背面不翻转法线，正反两面光照一致（否则背光面法线朝下变成黑斑）
MT.noFlip = function (m, key) {
  m.onBeforeCompile = function (sh) {
    sh.fragmentShader = '#define ATMO_NORAYS\n' + sh.fragmentShader;   // 植被层叠不做光柱步进（背后地面已提供）
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal = normal * faceDirection;', ''));
    if (key !== 'grass') sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', [   // 逆光透射：朝太阳看时未被遮挡的针叶边缘发亮
      '#include <lights_fragment_end>',
      '#if NUM_DIR_LIGHTS > 0',
      '{ float shf = 1.0;',
      '#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0',
      '  { vec4 dsc = vDirectionalShadowCoord[ 0 ]; dsc.xyz /= dsc.w; if ( dsc.x > 0.0 && dsc.x < 1.0 && dsc.y > 0.0 && dsc.y < 1.0 && dsc.z < 1.0 ) shf = step( dsc.z - 0.003, unpackRGBAToDepth( texture2D( directionalShadowMap[ 0 ], dsc.xy ) ) ); }',
      '#endif',
      '  float bk = pow( max( dot( normalize( - vViewPosition ), directionalLights[ 0 ].direction ), 0.0 ), 3.0 );',
      '  reflectedLight.directDiffuse += diffuseColor.rgb * directionalLights[ 0 ].color * ( 0.08 + bk * 0.9 ) * shf * step( vUv.x, 0.91 ); }',
      '#endif'].join('\n'));
  };
  m.customProgramCacheKey = function () { return 'mt-nf-' + key; };
  return m;
};
// 云杉枝杪贴图：u 沿枝条（根→梢），v 横跨枝条；右下角 12px 为不透明树皮色（树干 UV 指向这里）
// 云杉图集（512×256）：u 0~0.9 为俯视的羽状枝叶（主轴 + 二级小枝 + 密集短针，枝梢新叶偏黄绿），u 0.92~1 为带纵向裂纹的树皮
MT.frondTex = function () {
  if (MT._ft) return MT._ft;
  var W = 512, H = 256, FW = W * 0.9, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var g = cv.getContext('2d'), r = G.rng(31), i, k;
  g.lineCap = 'round';
  var needles = function (x0, y0, x1, y1, n, len, tipT) {
    var ang0 = Math.atan2(y1 - y0, x1 - x0);
    for (k = 0; k < n; k++) {
      var t = k / n, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t, L = len * (1 - 0.55 * t) * (0.75 + 0.45 * r()), tip = t > tipT ? (t - tipT) / (1 - tipT) : 0;
      for (var s = -1; s <= 1; s += 2) {
        var ang = ang0 + s * (0.75 + 0.5 * r()) + (r() - 0.5) * 0.3, lit = s < 0 ? 1 : 0.65;
        var hue = 104 - 22 * tip + r() * 18, sat = 28 + 14 * r() + 14 * tip, lum = 7 + 13 * lit * r() + 9 * tip;
        g.strokeStyle = 'hsl(' + (hue | 0) + ',' + (sat | 0) + '%,' + lum.toFixed(1) + '%)'; g.lineWidth = 1.2 + r() * 1.1;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(ang) * L, py + Math.sin(ang) * L); g.stroke();
      }
    }
  };
  var stem = function (x0, y0, x1, y1, lw) { g.strokeStyle = '#3a2e22'; g.lineWidth = lw; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + 3, x1, y1); g.stroke(); };
  var cy = H / 2;
  stem(6, cy, FW - 14, cy + 8, 4);
  for (i = 0; i < 14; i++) {                                                     // 二级小枝：交替斜伸，越向梢部越短
    var t = i / 14, bx = 26 + t * (FW - 70), sd = i % 2 ? 1 : -1, L = (95 - 70 * t) * (0.8 + 0.4 * r()), a = sd * (0.75 + 0.25 * r());
    var ex = bx + Math.cos(a) * L, ey = cy + 2 + Math.sin(a) * L * 0.95;
    stem(bx, cy + 2, ex, ey, 1.8);
    needles(bx, cy + 2, ex, ey, 30, 19 * (1 - 0.35 * t), 0.7);
  }
  needles(6, cy, FW - 14, cy + 8, 130, 27, 0.8);
  for (var y = 0; y < H; y++) for (var x = Math.floor(W * 0.92); x < W; x++) {   // 树皮
    var fis = Math.abs(Math.sin((x * 0.9 + 6 * G.vnoise(x * 0.05, y * 0.03)) * 0.9)), n = G.vnoise(x * 0.4, y * 0.08);
    var l = 11 + 9 * n - 8 * G.SS(0.25, 0.05, fis);
    g.fillStyle = 'hsl(30,' + (8 + 5 * n | 0) + '%,' + l.toFixed(1) + '%)'; g.fillRect(x, y, 1, 1);
  }
  var tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 8;
  return (MT._ft = tex);
};
// 云杉几何（单位高 1）：带根踵的锥形树干；冠基以下是光秃树干与枯枝；上部轮生枝是三段弯曲的下垂枝杪
// （下垂曲线 y = -drop·s^1.6 + 梢部上翘），绕枝轴随机扭转；顶点色做枝杪内暗外亮 + 冠层下暗上亮的自遮蔽
MT.spruceGeo = function (seed) {
  var pos = [], nor = [], uv = [], col = [], idx = [], r = G.rng(seed || 5), i, j, n = 0;
  var cb = 0.08 + 0.14 * r(), Lv = 12, K = 6, FU = 0.9;
  function v(x, y, z, nx, ny, nz, u, w, c, cy) { pos.push(x, y, z); var l = Math.hypot(nx, ny, nz) || 1; nor.push(nx / l, ny / l, nz / l); uv.push(u, w); col.push(c, c * (cy || 1), c * (cy ? cy * 0.85 : 1)); return n++; }
  var seg = 8, rings = [0, 0.03, 0.12, 0.5, 0.97];
  for (i = 0; i < rings.length - 1; i++) for (j = 0; j < seg; j++) {             // 树干（根踵外展）
    var y0 = rings[i], y1 = rings[i + 1], rad = function (y) { return 0.0035 + 0.018 * Math.pow(1 - y, 1.1) + 0.02 * Math.max(0, 1 - y / 0.04); };
    var a0 = j / seg * TAU, a1 = (j + 1) / seg * TAU, u0 = 0.92 + 0.08 * j / seg, u1 = 0.92 + 0.08 * (j + 1) / seg;
    var p0 = v(Math.cos(a0) * rad(y0), y0, Math.sin(a0) * rad(y0), Math.cos(a0), 0, Math.sin(a0), u0, y0, 0.75), p1 = v(Math.cos(a1) * rad(y0), y0, Math.sin(a1) * rad(y0), Math.cos(a1), 0, Math.sin(a1), u1, y0, 0.75);
    var p2 = v(Math.cos(a0) * rad(y1), y1, Math.sin(a0) * rad(y1), Math.cos(a0), 0, Math.sin(a0), u0, y1, 0.95), p3 = v(Math.cos(a1) * rad(y1), y1, Math.sin(a1) * rad(y1), Math.cos(a1), 0, Math.sin(a1), u1, y1, 0.95);
    idx.push(p0, p2, p1, p1, p2, p3);
  }
  for (i = 0; i < 9; i++) {                                                     // 冠基以下的枯枝
    var yb = 0.05 + (cb - 0.05) * r(), ab = r() * TAU, lb = 0.04 + 0.08 * r(), dxb = Math.cos(ab), dzb = Math.sin(ab), wb = 0.004;
    var s0 = v(-dzb * wb, yb, dxb * wb, dxb, 0.3, dzb, 0.93, yb, 0.5), s1 = v(dzb * wb, yb, -dxb * wb, dxb, 0.3, dzb, 0.95, yb, 0.5);
    var s2 = v(dxb * lb - dzb * wb * 0.3, yb - lb * 0.35, dzb * lb + dxb * wb * 0.3, dxb, 0.3, dzb, 0.93, yb + 0.05, 0.5), s3 = v(dxb * lb + dzb * wb * 0.3, yb - lb * 0.35, dzb * lb - dxb * wb * 0.3, dxb, 0.3, dzb, 0.95, yb + 0.05, 0.5);
    idx.push(s0, s2, s1, s1, s2, s3);
  }
  for (i = 0; i < Lv; i++) {
    var y = cb + (0.97 - cb) * Math.pow(i / (Lv - 1), 0.9), t = 1 - (y - cb) / (1 - cb), R = (0.36 * Math.pow(t, 0.85) + 0.03) * (0.9 + 0.2 * r()), kk = i >= Lv - 2 ? 4 : K;
    for (j = 0; j < kk; j++) {
      var a = j / kk * TAU + i * 2.4 + (r() - 0.5) * 0.7, len = R * (0.8 + 0.4 * r()), drop = len * (0.35 + 0.35 * r()) * (0.6 + 0.6 * t), w = len * 0.95;
      var dx = Math.cos(a), dz = Math.sin(a), roll = (r() - 0.5) * 0.9, sx = -dz * Math.cos(roll), sy = Math.sin(roll), sz = dx * Math.cos(roll);
      var shade = 0.55 + 0.45 * Math.pow(1 - t, 0.7), by = y + (r() - 0.5) * 0.015, prev = null;
      var S = [0, 0.4, 0.75, 1], Wd = [0.12, 0.42, 0.5, 0.3];
      for (var q = 0; q < S.length; q++) {
        var s = S[q], px = dx * len * s, pz = dz * len * s, py = by - drop * Math.pow(s, 1.6) + drop * 0.25 * Math.pow(s, 5), hw = w * Wd[q];
        var cc = shade * (0.38 + 0.62 * s), nyq = 1 - 0.35 * s;
        var lft = v(px + sx * hw, py + sy * hw, pz + sz * hw, dx * s, nyq, dz * s, s * FU, 1, cc, 1 + 0.06 * s), rgt = v(px - sx * hw, py - sy * hw, pz - sz * hw, dx * s, nyq, dz * s, s * FU, 0, cc, 1 + 0.06 * s);
        if (prev) idx.push(prev[0], lft, prev[1], prev[1], lft, rgt);
        prev = [lft, rgt];
      }
    }
  }
  var gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); gg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); gg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); gg.setIndex(idx);
  return gg;
};
// 程序化针叶树（单位高 1）：树干锥台 + 8 层不规则枝盘 + 缘部针叶簇
// 半径 R_k、下垂量 d_k 由公式给出，单段半径乘 (0.72+0.56·hash) 噪声；
// 每个顶点再做法线扰动和颜色抖动，避免大片平面三角的“纸锥”感
MT.coniferGeo = function (seed) {
  var pos = [], nor = [], col = [], r = G.rng(seed || 7);
  var seg = 8, i, s, k;
  var tiers = [[0.14, 0.335, 0.26], [0.24, 0.292, 0.25], [0.34, 0.252, 0.24], [0.44, 0.212, 0.23],
               [0.54, 0.172, 0.22], [0.63, 0.132, 0.21], [0.71, 0.095, 0.20], [0.79, 0.060, 0.19]];
  // 顶点写入时对法线做随机扰动（凸起感），并对颜色做 ±18% 抖动
  function vtx(p, n, c) {
    var jn = 0.22;
    var nx = n[0] + (r() - 0.5) * jn, ny = n[1] + (r() - 0.5) * jn * 0.6, nz = n[2] + (r() - 0.5) * jn;
    var il = 1 / (Math.hypot(nx, ny, nz) || 1);
    var jc = 0.82 + 0.36 * r();
    pos.push(p[0], p[1], p[2]);
    nor.push(nx * il, ny * il, nz * il);
    col.push(c[0] * jc, c[1] * jc, c[2] * jc);
  }
  function tri(p0, p1, p2, c0, c1, c2) {
    var ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    var bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    var nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    var il = 1 / (Math.hypot(nx, ny, nz) || 1); nx *= il; ny *= il; nz *= il;
    var N = [nx, ny, nz];
    vtx(p0, N, c0); vtx(p1, N, c1); vtx(p2, N, c2);
  }
  // 线性空间针叶绿：与远景树卡的贴图基色对齐，避免近树偏亮偏黄
  function gc(sh) { var j = 0.92 + 0.16 * r(); return [0.0125 * sh * j, 0.0345 * sh * j, 0.0098 * sh * j]; }
  // 树干：0 → 0.56 的锥台，8 边
  var tb = 0.030, tt = 0.009, segT = 8;
  for (s = 0; s < segT; s++) {
    var a0 = s / segT * TAU, a1 = (s + 1) / segT * TAU;
    var b0 = [Math.cos(a0) * tb, 0, Math.sin(a0) * tb], b1 = [Math.cos(a1) * tb, 0, Math.sin(a1) * tb];
    var u0 = [Math.cos(a0) * tt, 0.56, Math.sin(a0) * tt], u1 = [Math.cos(a1) * tt, 0.56, Math.sin(a1) * tt];
    var cb = [0.05, 0.035, 0.021], ct = [0.075, 0.053, 0.032];
    tri(b0, u0, b1, cb, ct, cb); tri(b1, u0, u1, cb, ct, ct);
  }
  // 枝盘：外圈下垂、内圈抬升，缘部再加一圈向下的针叶锯齿
  for (k = 0; k < tiers.length; k++) {
    var yb = tiers[k][0], rad = tiers[k][1], ht = tiers[k][2];
    var rot = k * 0.37;
    var ax = (r() - 0.5) * 0.02, az = (r() - 0.5) * 0.02, ay = yb + ht;
    for (s = 0; s < seg; s++) {
      var t0 = s / seg * TAU + rot, t1 = (s + 1) / seg * TAU + rot;
      var r0 = rad * (0.70 + 0.60 * r()), r1 = rad * (0.70 + 0.60 * r());
      var droop0 = 0.015 + 0.045 * r(), droop1 = 0.015 + 0.045 * r();
      var q0 = [Math.cos(t0) * r0, yb - droop0, Math.sin(t0) * r0];
      var q1 = [Math.cos(t1) * r1, yb - droop1, Math.sin(t1) * r1];
      var inner0 = [Math.cos(t0) * r0 * 0.24, yb + ht * 0.52, Math.sin(t0) * r0 * 0.24];
      var inner1 = [Math.cos(t1) * r1 * 0.24, yb + ht * 0.52, Math.sin(t1) * r1 * 0.24];
      var apex = [ax, ay, az];
      var dark = gc(0.5 + 0.08 * k), mid = gc(0.72 + 0.08 * k), lit = gc(1.05);
      tri(q0, inner0, q1, dark, mid, dark);
      tri(q1, inner0, inner1, dark, mid, mid);
      tri(inner0, apex, inner1, mid, lit, mid);
      // 缘部锯齿：向外下方垂一片小三角，打碎圆滑的锥形边缘
      var tm = (t0 + t1) * 0.5, rm = (r0 + r1) * 0.5 * (1.0 + 0.12 * r());
      var qm = [Math.cos(tm) * rm, yb - droop0 - 0.035 - 0.05 * r(), Math.sin(tm) * rm];
      tri(q0, qm, q1, gc(0.42 + 0.06 * k), gc(0.34 + 0.06 * k), gc(0.42 + 0.06 * k));
      // 针叶簇：枝梢再挂两片下垂的小三角，把外轮廓打毛
      for (var u = 0; u < 2; u++) {
        var da = (u ? 0.26 : -0.20) + (r() - 0.5) * 0.12;
        var ta = t0 + da, rr2 = r0 * (1.06 + 0.14 * r());
        var tip = [Math.cos(ta) * rr2, yb - droop0 - 0.055 - 0.06 * r(), Math.sin(ta) * rr2];
        var bs = [q0[0] * 1.07, q0[1] - 0.05, q0[2] * 1.07];
        tri(q0, tip, bs, gc(0.40 + 0.05 * k), gc(0.30 + 0.04 * k), gc(0.36 + 0.04 * k));
      }
    }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
};
// 交叉面片（树卡/草卡）：n 片绕 Y 轴均分；upN=1 法线全部朝上（与地面同光照），否则为圆柱向外法线
MT.cardGeo = function (n, w, h, upN) {
  var pos = [], nor = [], uv = [], idx = [], k;
  for (k = 0; k < n; k++) {
    var a = k * Math.PI / n, cx = Math.cos(a) * w / 2, cz = Math.sin(a) * w / 2, b = k * 4;
    pos.push(-cx, 0, -cz, cx, 0, cz, -cx, h, -cz, cx, h, cz);
    uv.push(0, 0, 1, 0, 0, 1, 1, 1);
    if (upN) nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    else { var nx = Math.cos(a) * 0.8, nz = Math.sin(a) * 0.8; nor.push(-nx, 0.35, -nz, nx, 0.35, nz, -nx * 0.6, 0.8, -nz * 0.6, nx * 0.6, 0.8, nz * 0.6); }
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
};
// 纯数学生成的 RGBA 贴图（不经过 Canvas，规避微信 CanvasTexture 上传为空/变白的问题）
MT.dataTex = function (d, w, h, srgb) {
  var t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  // DataTexture 默认 flipY=false：数据第 0 行对应 UV v=0（贴图底部），与生成函数的 v 方向一致
  if (srgb) t.encoding = THREE.sRGBEncoding;
  t.needsUpdate = true;
  return t;
};
var hashpx = function (x, y) { var s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
// 针叶树卡：树冠外轮廓由 hw(t)=A·(1-t)^p 决定，叠加锯齿/枝层调制；像素颜色按受光侧 + 针叶噪声上色
MT.conferTex = function () {
  if (MT._ct) return MT._ct;
  var W = 128, H = 256, d = new Uint8Array(W * H * 4), x, y;
  for (y = 0; y < H; y++) {
    var v = y / (H - 1);                                  // 0 = 底部（树干）, 1 = 树梢
    var t = G.CLAMP((v - 0.06) / 0.94, 0, 1);
    for (x = 0; x < W; x++) {
      var u = x / (W - 1) * 2 - 1, i = (y * W + x) * 4;
      var r = 0, g = 0, b = 0, a = 0;
      // 树干
      if (v < 0.34 && Math.abs(u) < 0.05 + 0.03 * (1 - v / 0.34)) {
        var tk = 0.7 + 0.3 * hashpx(x, y);
        r = 54 * tk; g = 38 * tk; b = 24 * tk; a = 255;
      }
      // 树冠：锥形轮廓 + 枝层波浪 + 边缘噪声
      if (t > 0 && t < 1) {
        var jag = 0.83 + 0.17 * Math.sin(t * 52 + 0.9 * Math.sin(t * 13));
        var hw = 0.96 * Math.pow(1 - t, 0.62) * jag + 0.015;
        var edge = hw + (hashpx(x * 1.7, y * 0.9) - 0.5) * 0.06;
        if (Math.abs(u) < edge) {
          var side = 0.5 - 0.5 * (u / Math.max(0.03, edge));      // 左受光 → 1
          var n = hashpx(x * 3.3, y * 1.9);
          var layer = 0.74 + 0.26 * Math.sin(t * 120 + Math.sin(u * 18) * 1.5);
          var lum = (0.62 + 0.5 * side) * (0.55 + 0.45 * n) * layer * (0.85 + 0.3 * (1 - t));
          r = 62 * lum; g = 104 * lum; b = 50 * lum; a = 255;
          // 细枝缝隙：稀疏打洞，让轮廓更像针叶而不是实心锥
          if (n < 0.055 && Math.abs(u) > edge * 0.35) a = 0;
        }
      }
      d[i] = G.CLAMP(r, 0, 255); d[i + 1] = G.CLAMP(g, 0, 255); d[i + 2] = G.CLAMP(b, 0, 255); d[i + 3] = a;
    }
  }
  return (MT._ct = MT.dataTex(d, W, H, true));
};
// 草丛卡：多根弯曲草叶，x_c(v)=x0+lean·(v/h)^2，叶片宽度随高度收窄
MT.grassTex = function () {
  if (MT._gr) return MT._gr;
  var S = 64, d = new Uint8Array(S * S * 4);
  var blades = [], k;
  for (k = 0; k < 11; k++) {
    blades.push({
      x0: (hashpx(k * 3.1, 7.7) - 0.5) * 1.55,
      h: 0.42 + 0.55 * hashpx(k * 5.3, 2.9),
      lean: (hashpx(k * 7.9, 4.1) - 0.5) * 0.85,
      w: 0.055 + 0.045 * hashpx(k * 9.7, 6.3)
    });
  }
  for (var y = 0; y < S; y++) {
    var v = y / (S - 1);
    for (var x = 0; x < S; x++) {
      var u = x / (S - 1) * 2 - 1, i = (y * S + x) * 4, alpha = 0, r = 0, g = 0, b = 0;
      for (k = 0; k < blades.length; k++) {
        var B = blades[k];
        if (v > B.h) continue;
        var tv = v / B.h;
        var cx = B.x0 + B.lean * tv * tv;
        var wd = B.w * (1 - 0.72 * tv) * 0.5;
        if (Math.abs(u - cx) < wd) {
          var shade = 0.55 + 0.5 * (1 - tv) + 0.2 * hashpx(x, y);
          r = 88 * shade; g = 112 * shade; b = 46 * shade;
          alpha = 255;
        }
      }
      d[i] = G.CLAMP(r, 0, 255); d[i + 1] = G.CLAMP(g, 0, 255); d[i + 2] = G.CLAMP(b, 0, 255); d[i + 3] = alpha;
    }
  }
  return (MT._gr = MT.dataTex(d, S, S, true));
};
// 弯道警示牌：黄底 + 三道黑色折线（同样纯数学生成）
MT.chevTex = function () {
  if (MT._cv) return MT._cv;
  var S = 64, d = new Uint8Array(S * S * 4);
  for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) {
    var i = (y * S + x) * 4, black = false;
    for (var k = 0; k < 3; k++) {
      var cx = 12 + k * 18;
      var dy = Math.abs(y - 32) / 22;
      var lx = cx + dy * 9;
      if (y > 10 && y < 54 && Math.abs(x - lx) < 2.6) black = true;
    }
    d[i] = black ? 26 : 238; d[i + 1] = black ? 24 : 190; d[i + 2] = black ? 20 : 44; d[i + 3] = 255;
  }
  return (MT._cv = MT.dataTex(d, S, S, true));
};

/* ---------- 其余部分：路面、桥、河、护栏、植被、岩石、营地、起点、物理接口 ---------- */
MT.buildRest = function (scene, def, T, renderer, c) {
  var NOI = !!WIN.__noInst;                       // 真机兼容：实例化不可用时降低植被/碎石密度
  var P = c.P, N = c.N, D = c.D, RIGHT = c.RIGHT, TAN = c.TAN, half = c.half, roadY = c.roadY, i, k, j;
  var hAt = c.hInner, rng = G.rng(20260), cc = { P: P, RIGHT: RIGHT, TAN: TAN, N: N, D: D }, HB = G.HB, idxAtN = c.idxAtN, sunAt = c.sunAt;
  var yawOf = function (q) { return Math.atan2(TAN[q].x, TAN[q].z); };
  var treeColor = new THREE.Color();

  /* ===== 路面网格（四路况权重 + 烘焙山影） ===== */
  (function () {
    var cols = 13, W = half + 0.9, nv = (N + 1) * cols;
    var pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3), asf = new Float32Array(nv * 4), asn = new Float32Array(nv), idx = [];
    for (i = 0; i <= N; i++) {
      var q = i % N, p = P[q], r = RIGHT[q];
      for (j = 0; j < cols; j++) {
        var lat = -W + 2 * W * j / (cols - 1), vi = i * cols + j, px = p.x + r.x * lat, pz = p.z + r.z * lat, py = roadY[q] + 0.03 - 0.16 * SS(half - 0.3, W, Math.abs(lat));
        pos[vi * 3] = px; pos[vi * 3 + 1] = py; pos[vi * 3 + 2] = pz;
        uv[vi * 2] = lat / 6; uv[vi * 2 + 1] = D[i] / 6;
        var e = SS(half - 0.7, half + 0.4, Math.abs(lat)) * 0.65, s0 = c.surf[q * 4], s1 = c.surf[q * 4 + 1], s2 = c.surf[q * 4 + 2], s3 = c.surf[q * 4 + 3];
        asf[vi * 4] = s0 * (1 - e); asf[vi * 4 + 1] = s1 + (s0 + s2 + s3) * e; asf[vi * 4 + 2] = s2 * (1 - e); asf[vi * 4 + 3] = s3 * (1 - e);
        var tint = 0.9 + 0.2 * G.vnoise(D[i] * 0.07, lat * 0.4 + 3);
        col[vi * 3] = tint; col[vi * 3 + 1] = tint * 0.995; col[vi * 3 + 2] = tint * 0.98;
        asn[vi] = sunAt(px, pz, py + 0.4);
      }
    }
    for (i = 0; i < N; i++) for (j = 0; j < cols - 1; j++) { var a = i * cols + j, b = a + 1, cq = a + cols, d = cq + 1; idx.push(a, cq, b, b, cq, d); }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('aSurf', new THREE.BufferAttribute(asf, 4)); g.setAttribute('aSun', new THREE.BufferAttribute(asn, 1));
    g.setIndex(idx); g.computeVertexNormals();
    var road = new THREE.Mesh(g, MT.roadMaterial(half));
    road.receiveShadow = true; scene.add(road);
  })();

  /* ===== 起终点：棋盘格线 + 起跑灯架 ===== */
  (function () {
    var f = HB.frame({ P: P, RIGHT: RIGHT, TAN: TAN, N: N }, 0), pg = new THREE.PlaneGeometry(half * 2, 2.4);
    pg.rotateX(-Math.PI / 2); pg.rotateY(f.yaw); pg.translate(f.p.x, f.p.y + 0.06, f.p.z);
    var lm = new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ map: G.Tex.checker(), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    lm.receiveShadow = true; scene.add(lm);
    var M = { steel: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.6 }), rubber: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.92 }),
      sponsorBoard: new THREE.MeshStandardMaterial({ map: G.PBR.sponsors(), roughness: 0.5, side: THREE.DoubleSide }), sponsor: null };
    M.sponsor = M.sponsorBoard;
    HB.gantry({ scene: scene, T: T, P: P, RIGHT: RIGHT, TAN: TAN, N: N, wallIn: half + 2.0 }, M);
  })();

  /* ===== 护栏（悬崖侧）===== */
  var steelMat = new THREE.MeshStandardMaterial({ color: 0xa9aaa6, roughness: 0.5, metalness: 0.55, side: THREE.DoubleSide });
  function guardrail(sA, sB, side) {
    var i0 = idxAtN(sA), i1 = idxAtN(sB), lat = side * (half + 0.95), parts = [], posts = [];
    parts.push(HB.sweep(cc, i0, i1, [[lat, 0.48], [lat, 0.9]], 1, 1)); parts.push(HB.sweep(cc, i0, i1, [[lat + side * 0.05, 0.5], [lat + side * 0.05, 0.86]], 1, 1));
    for (var q = i0; q <= i1; q += 2) { var r = RIGHT[q], p = P[q]; posts.push([p.x + r.x * (lat + side * 0.14), roadY[q] + 0.5, p.z + r.z * (lat + side * 0.14), yawOf(q)]); }
    var m = new THREE.Mesh(G.mergeGeos(parts), steelMat); m.castShadow = true; scene.add(m);
    scene.add(G.instanced(new THREE.BoxGeometry(0.12, 1.0, 0.12), steelMat, posts, true));
  }
  guardrail(160, 390, -1); guardrail(578, 698, 1);

  /* ===== 峡谷大桥 ===== */
  (function () {
    var i0 = idxAtN(MT.BRIDGE[0] - 6), i1 = idxAtN(MT.BRIDGE[1] + 6), w = half + 1.0, parts = [];
    var co = G.PBR.concrete();
    var cm = new THREE.MeshStandardMaterial({ color: 0xb9b5ac, map: co.map, normalMap: co.normalMap, roughnessMap: co.roughnessMap, roughness: 1, side: THREE.DoubleSide });
    var cmv = new THREE.MeshStandardMaterial({ vertexColors: true, map: co.map, normalMap: co.normalMap, roughnessMap: co.roughnessMap, roughness: 1 });
    parts.push(HB.sweep(cc, i0, i1, [[-w, -0.02], [-w, -1.3], [w, -1.3], [w, -0.02]], 4, 4));
    [-1, 1].forEach(function (s) { parts.push(HB.sweep(cc, i0, i1, [[s * w, -0.02], [s * w, 1.0], [s * (w - 0.38), 1.0], [s * (w - 0.38), -0.02]], 2, 2)); });
    var bm = new THREE.Mesh(G.mergeGeos(parts), cm); bm.castShadow = true; bm.receiveShadow = true; scene.add(bm);
    // 桥墩 + 桥台
    var b = new G.GB(3), mid = idxAtN((MT.BRIDGE[0] + MT.BRIDGE[1]) / 2);
    [0.3, 0.7].forEach(function (f) {
      var q = idxAtN(MT.BRIDGE[0] + (MT.BRIDGE[1] - MT.BRIDGE[0]) * f), p = P[q], yb = hAt(p.x, p.z) - 1.5, h = roadY[q] - 1.3 - yb;
      if (h > 1) { b.c(0xaaa69c).box(w * 2 - 0.8, h, 2.6, p.x, yb + h / 2, p.z, 0, yawOf(q), 0); b.c(0x9b978d).box(w * 2 + 1.6, 1.0, 4.4, p.x, yb + 0.5, p.z, 0, yawOf(q), 0); }
    });
    [MT.BRIDGE[0] - 3, MT.BRIDGE[1] + 3].forEach(function (s) { var q = idxAtN(s), p = P[q]; b.c(0xa7a399).box(w * 2 + 1.2, 2.6, 5, p.x, roadY[q] - 2.0, p.z, 0, yawOf(q), 0); });
    scene.add(b.mesh(cmv));
    // 栏杆
    var posts = [], rails = [];
    for (i = i0; i <= i1; i += 3) [-1, 1].forEach(function (s) { var r = RIGHT[i], p = P[i]; posts.push([p.x + r.x * s * (w - 0.19), roadY[i] + 1.3, p.z + r.z * s * (w - 0.19), yawOf(i)]); });
    scene.add(G.instanced(new THREE.BoxGeometry(0.08, 0.6, 0.08), steelMat, posts, true));
    [-1, 1].forEach(function (s) { rails.push(HB.sweep(cc, i0, i1, [[s * (w - 0.19), 1.55], [s * (w - 0.19), 1.62]], 1, 1)); });
    scene.add(new THREE.Mesh(G.mergeGeos(rails), steelMat));
  })();

  /* ===== 河流（透明水面 + 岸边泡沫，涉水段与路面重叠）===== */
  (function () {
    var z0 = -440, z1 = 640, step = 4, n = Math.round((z1 - z0) / step) + 1, cols = 11, pos = [], riv = [], idx = [], a, u;
    for (a = 0; a < n; a++) {
      var z = z1 - a * step, x = c.riverX(z), xn = c.riverX(z - 1), dx = xn - x, dl = Math.hypot(dx, 1), lx = 1 / dl, lz = -dx / dl, hw = 8.6 + 2.2 * (1 - SS(30, 90, Math.abs(z + 60)));
      var rap = CL(0.1 + 0.8 * SS(0.5, 0.7, G.fbm(z * 0.012, 3.3, 3)) + (z > -45 ? 0.1 : 0), 0, 1) * SS(25, 60, Math.abs(z + 85));
      for (u = 0; u < cols; u++) {
        var t = u / (cols - 1) * 2 - 1;
        pos.push(x + lx * t * hw, c.waterLevel(z) + 0.03 * rap * (G.vnoise(z * 0.3, t * 3) - 0.5), z + lz * t * hw); riv.push(t, a * step, rap);
      }
    }
    for (a = 0; a < n - 1; a++) for (u = 0; u < cols - 1; u++) { var p0 = a * cols + u, p1 = p0 + 1, p2 = p0 + cols, p3 = p2 + 1; idx.push(p0, p2, p1, p1, p2, p3); }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aRiv', new THREE.Float32BufferAttribute(riv, 3));
    g.setIndex(idx); g.computeVertexNormals();
    var wm = MT.waterMaterial(), mesh = new THREE.Mesh(g, wm.mat); mesh.renderOrder = 3; mesh.receiveShadow = true; scene.add(mesh);
    mesh.material.side = THREE.DoubleSide; G.waterMats.push(wm.holder);
  })();

  /* ===== 树木：近景 3D 云杉（分层枝杪 + 针叶贴图），远景交叉树卡；树冠半径内不压路 ===== */
  // 树卡法线统一朝上，与地面同光照；材质用最朴素的 Lambert（不挂自定义着色器，真机最稳）
  var treeGeo = MT.cardGeo(3, 0.8, 1.0, 1);
  var treeMat = new THREE.MeshLambertMaterial({ map: MT.conferTex(), alphaTest: 0.42, side: THREE.DoubleSide });
  var bx = c.bounds, trees = [], near = [], tries = 0;
  while (trees.length + near.length < 11000 && tries++ < 260000) {
    var x = bx[0] + 40 + rng() * (bx[1] - bx[0] - 80), z = bx[2] + 40 + rng() * (bx[3] - bx[2] - 80);
    var nr = c.nearest(x, z), rd = nr ? nr.d : 99;
    if (rd < c.Wc + 2) continue;
    var h = hAt(x, z), sl = Math.hypot(hAt(x + 3, z) - hAt(x - 3, z), hAt(x, z + 3) - hAt(x, z - 3)) / 6;
    if (sl > 0.75 || c.sandMask(x, z) > 0.25) continue;
    var dr = c.riverDist(x, z); if (dr < 11 && h < c.waterLevel(z) + 3) continue;
    var fd = SS(0.42, 0.6, G.fbm(x * 0.0045 + 21, z * 0.0045 + 7, 4)) * (1 - SS(130, 175, h));
    var pr = fd * 0.97 + (rd < 26 ? 0.06 : 0.015); if (rng() > pr) continue;
    var sz = (11 + rng() * 17) * (0.75 + 0.35 * fd), wd = sz * (0.36 + rng() * 0.12);
    if (rd < c.Wc + wd * 0.42 + 0.6) continue;                                     // 树冠不伸进路面
    var sun = sunAt(x, z, h + sz * 0.6);
    treeColor.setRGB(0.9 + rng() * 0.2, 0.92 + rng() * 0.16, 0.86 + rng() * 0.2).multiplyScalar(0.42 + 0.58 * sun);
    (rd < 20 ? near : trees).push([x, h - 0.4, z, rng() * TAU, wd, sz, wd, treeColor.clone()]);   // 20m 内用实体树，其余用树卡
  }
  if (NOI) {
    // 无实例化兼容：远处仍是树卡；近景换成真正的低模锥形树（有体积，不再是“贴纸”）
    MT.chunks(scene, treeGeo, treeMat, trees, 130, true, 14);
    var nearMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    near.forEach(function (t) { var w2 = t[5] * 0.9; t[4] = w2; t[6] = w2; });
    MT.chunksVar(scene, [MT.coniferGeo(5), MT.coniferGeo(17), MT.coniferGeo(29)], nearMat, near, 90, true, 14);
  } else {
    MT.chunks(scene, treeGeo, treeMat, trees, 130, true, 14);
    var spMat = MT.noFlip(new THREE.MeshLambertMaterial({ map: MT.frondTex(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide }), 'spruce');
    var shadowCards = near.map(function (t) { return t.slice(); });
    near.forEach(function (t) { t[4] = t[5]; t[6] = t[5]; });                       // 云杉几何自带宽高比，等比缩放
    MT.chunksVar(scene, [MT.spruceGeo(5), MT.spruceGeo(17), MT.spruceGeo(29)], spMat, near, 90, false, 14);
    // 云杉的阴影由廉价的交叉树卡代理（只在阴影相机的图层 1 里可见）
    MT.chunks(scene, treeGeo, treeMat, shadowCards, 90, true, 14).forEach(function (m) { m.layers.set(1); });
  }
  // 林下遮蔽：树冠下的地面压暗（实时阴影只覆盖车辆周围，远处靠这层烘焙）
  if (c.terrain) {
    var tg = c.terrain, tcol = tg.geometry.attributes.color, occ = new Float32Array(tcol.count).fill(1);
    trees.concat(near).forEach(function (t) {
      var R = t[5] * 0.22, a0 = Math.max(0, Math.floor((t[0] - R - tg.x0) / tg.cell)), a1 = Math.min(tg.nx - 1, Math.ceil((t[0] + R - tg.x0) / tg.cell));
      var b0 = Math.max(0, Math.floor((t[2] - R - tg.z0) / tg.cell)), b1 = Math.min(tg.nz - 1, Math.ceil((t[2] + R - tg.z0) / tg.cell));
      for (var bb = b0; bb <= b1; bb++) for (var aa = a0; aa <= a1; aa++) {
        var dd = Math.hypot(tg.x0 + aa * tg.cell - t[0], tg.z0 + bb * tg.cell - t[2]) / R; if (dd >= 1) continue;
        var o2 = bb * tg.nx + aa; occ[o2] *= 0.55 + 0.45 * dd * dd;
      }
    });
    for (i = 0; i < tcol.count; i++) { var ok2 = Math.max(0.35, occ[i]); tcol.setXYZ(i, tcol.getX(i) * ok2, tcol.getY(i) * ok2, tcol.getZ(i) * ok2); }
    tcol.needsUpdate = true;
  }

  /* ===== 岩石：悬崖脚、河床、路边（分形位移 + 岩石贴图，半埋入地面）===== */
  var rockGeo = [MT.rockVariant(11, 5, NOI ? 1 : 3, 0.85), MT.rockVariant(23, 6, NOI ? 1 : 3, 0.75), MT.rockVariant(37, 4, NOI ? 1 : 3, 0.95), MT.rockVariant(41, 7, NOI ? 1 : 3, 0.7)];
  var rTex = MT.groundTex().rock;
  var rocks = [], rc = new THREE.Color();
  var clear = function (x, z, r) { var n = c.nearest(x, z); return !n || n.d > c.Wc + r; };   // 物体外接半径 r 不压任何一段路
  function addRock(x, z, s, frag) { if (!clear(x, z, s * 1.4 + 0.3)) return; var h = hAt(x, z), sun = sunAt(x, z, h + 1), k = 0.36 + rng() * 0.18; rc.setRGB(k * 1.05, k, k * 0.94).multiplyScalar(0.5 + 0.5 * sun); rocks.push([x, h - s * 0.2, z, rng() * TAU, s * (0.8 + rng() * 0.6), s * (0.75 + rng() * 0.5), s * (0.8 + rng() * 0.6), rc.clone()]);
    if (!NOI && !frag && s > 0.9) for (var f = 0, nf = 2 + (rng() * 4 | 0); f < nf; f++) { var fa = rng() * TAU, fr = s * (0.9 + rng() * 0.8); addRock(x + Math.cos(fa) * fr, z + Math.sin(fa) * fr, s * (0.18 + rng() * 0.3), true); }   // 崩落的碎块
  }
  tries = 0;
  while (rocks.length < (NOI ? 260 : 520) && tries++ < 80000) {                    // 陡坡/崖脚
    var x2 = bx[0] + 30 + rng() * (bx[1] - bx[0] - 60), z2 = bx[2] + 30 + rng() * (bx[3] - bx[2] - 60), n2 = c.nearest(x2, z2);
    if (!n2 || n2.d < c.Wc + 2.5 || n2.d > 60) continue;
    var sl2 = Math.hypot(hAt(x2 + 3, z2) - hAt(x2 - 3, z2), hAt(x2, z2 + 3) - hAt(x2, z2 - 3)) / 6;
    if (sl2 > 0.5 || rng() < 0.12) addRock(x2, z2, 0.8 + rng() * 2.6);
  }
  for (i = 0; i < (NOI ? 90 : 260); i++) { var zr = -420 + rng() * 1040, xr = c.riverX(zr) + (rng() - 0.5) * 24; addRock(xr, zr, 0.5 + rng() * 1.9); }       // 河床卵石
  var slabs = [];
  for (var cx2 = bx[0] + 20; cx2 < bx[1] - 20; cx2 += 5) for (var cz2 = bx[2] + 20; cz2 < bx[3] - 20; cz2 += 5) {      // 崖壁岩板：嵌入坡面，打破高度场的垂直平面
    var ox = cx2 + (rng() - 0.5) * 4, oz = cz2 + (rng() - 0.5) * 4, gsx = (hAt(ox + 2.5, oz) - hAt(ox - 2.5, oz)) / 5, gsz = (hAt(ox, oz + 2.5) - hAt(ox, oz - 2.5)) / 5, slp = Math.hypot(gsx, gsz);
    if (slp < 0.9 || rng() > 0.6) continue;
    var nc = c.nearest(ox, oz); if (nc && nc.d < c.Wc + 2.5) continue;
    var bs = 2.5 + rng() * 4.5, ux = gsx / slp, uz = gsz / slp, px3 = ox + ux * bs * 0.35, pz3 = oz + uz * bs * 0.35, hh2 = hAt(ox, oz), sun3 = sunAt(ox, oz, hh2 + 2), kk3 = 0.3 + rng() * 0.14;
    if (!clear(px3, pz3, bs * 1.25)) continue;
    rc.setRGB(kk3 * 1.04, kk3, kk3 * 0.95).multiplyScalar(0.45 + 0.55 * sun3);
    slabs.push([px3, hh2 - bs * 0.3, pz3, Math.atan2(ux, uz) + (rng() - 0.5) * 0.5, bs * (0.66 + rng() * 0.44), bs * (0.55 + rng() * 0.66), bs * (0.4 + rng() * 0.2), rc.clone()]);
  }
  var slabGeo = NOI ? [MT.rockVariant(53, 9, 1, 0.9, 0.7), MT.rockVariant(67, 8, 1, 0.8, 0.65), MT.rockVariant(71, 10, 1, 1.0, 0.75)] : [MT.rockVariant(53, 9, 2, 0.9, 0.7), MT.rockVariant(67, 8, 2, 0.8, 0.65), MT.rockVariant(71, 10, 2, 1.0, 0.75)];
  MT.chunksVar(scene, slabGeo, MT.rockMaterial(rTex), slabs, 170, true, 10);
  for (i = 0; i < (NOI ? 180 : 520); i++) { var q2 = Math.floor(rng() * N), s2 = rng() < 0.5 ? -1 : 1, off = c.Wc + 1.2 + rng() * 9; addRock(P[q2].x + RIGHT[q2].x * s2 * off, P[q2].z + RIGHT[q2].z * s2 * off, 0.3 + rng() * 0.9); }  // 路边碎石
  MT.chunksVar(scene, rockGeo, MT.rockMaterial(rTex), rocks, 170, true, 8);
  // 岩石与地面相接处压暗（接触遮蔽，烘焙进地形顶点色）
  if (c.terrain) {
    var tg2 = c.terrain, tc2 = tg2.geometry.attributes.color;
    rocks.concat(slabs).forEach(function (t) {
      var R2 = Math.max(t[4], t[6]) * 1.6, a0 = Math.max(0, Math.floor((t[0] - R2 - tg2.x0) / tg2.cell)), a1 = Math.min(tg2.nx - 1, Math.ceil((t[0] + R2 - tg2.x0) / tg2.cell));
      var b0 = Math.max(0, Math.floor((t[2] - R2 - tg2.z0) / tg2.cell)), b1 = Math.min(tg2.nz - 1, Math.ceil((t[2] + R2 - tg2.z0) / tg2.cell));
      for (var bb = b0; bb <= b1; bb++) for (var aa = a0; aa <= a1; aa++) {
        var dd = Math.hypot(tg2.x0 + aa * tg2.cell - t[0], tg2.z0 + bb * tg2.cell - t[2]) / R2; if (dd >= 1) continue;
        var o2 = bb * tg2.nx + aa, kq = 0.6 + 0.4 * dd * dd; tc2.setXYZ(o2, tc2.getX(o2) * kq, tc2.getY(o2) * kq, tc2.getZ(o2) * kq);
      }
    });
    tc2.needsUpdate = true;
  }
  // 路肩与松软路面上的碎石（参考图里满地的碎岩）
  (function () {
    var pg = [MT.rockVariant(81, 4, 1, 0.6), MT.rockVariant(83, 5, 1, 0.55)];
    var peb = [], pc = new THREE.Color(), gq = G.Quality.level, cnt = NOI ? 900 : (gq === 'low' ? 1500 : gq === 'ultra' ? 8000 : 4000);
    for (var n3 = 0, t3 = 0; n3 < cnt && t3 < cnt * 4; t3++) {
      var q = Math.floor(rng() * N); if (c.surf[q * 4] > 0.5 || c.isBridge[q]) continue;
      var sd = rng() < 0.5 ? -1 : 1, lat = sd * (half - 0.6 + Math.pow(rng(), 1.6) * 5), along = (rng() - 0.5) * 2;
      var x = P[q].x + RIGHT[q].x * lat + TAN[q].x * along, z = P[q].z + RIGHT[q].z * lat + TAN[q].z * along;
      var nn = c.nearest(x, z); if (nn && nn.i !== q && Math.abs(nn.i - q) > 6 && nn.d < c.Wc) continue;
      var y = Math.abs(lat) < half + 0.3 ? roadY[q] + 0.03 : hAt(x, z), s = 0.05 + Math.pow(rng(), 2.5) * 0.3, k = 0.38 + rng() * 0.25;
      pc.setRGB(k * 1.05, k, k * 0.92).multiplyScalar(0.5 + 0.5 * sunAt(x, z, y + 0.5));
      peb.push([x, y, z, rng() * TAU, s * (0.8 + rng() * 0.5), s, s * (0.8 + rng() * 0.5), pc.clone()]); n3++;
    }
    MT.chunksVar(scene, pg, MT.rockMaterial(rTex), peb, 80, false, 1);
  })();

  /* ===== 地被：草丛（交叉草卡，法线朝上与地面同光照，颜色取地表色调）===== */
  (function () {
    var gq = G.Quality.level, cnt = NOI ? 6000 : (gq === 'low' ? 9000 : gq === 'mid' ? 22000 : gq === 'high' ? 34000 : 50000);
    var geo = MT.cardGeo(2, 1.0, 0.55, 1), tufts = [], gc = new THREE.Color(), t2 = 0;
    while (tufts.length < cnt && t2++ < cnt * 5) {
      var q = Math.floor(rng() * N), sd = rng() < 0.5 ? -1 : 1, off = c.Wc + 0.2 + Math.pow(rng(), 1.8) * 34;
      var gx = P[q].x + RIGHT[q].x * sd * off + (rng() - 0.5) * 3, gz = P[q].z + RIGHT[q].z * sd * off + (rng() - 0.5) * 3;
      var nn = c.nearest(gx, gz); if (nn && nn.d < c.Wc + 0.1) continue;
      var gh = hAt(gx, gz), gsl = Math.hypot(hAt(gx + 1.5, gz) - hAt(gx - 1.5, gz), hAt(gx, gz + 1.5) - hAt(gx, gz - 1.5)) / 3;
      var tc = c.colorAt(gx, gz, gh, gsl, nn ? nn.d : 99), w = c.colorAt.w;
      if (rng() > (w[0] * 1.1 + w[2] * 0.25) * (1 - SS(0.4, 0.55, G.fbm(gx * 0.0045 + 21, gz * 0.0045 + 7, 4)))) continue;   // 林下不长草丛
      var sun = sunAt(gx, gz, gh + 0.3), s = 0.55 + rng() * 0.9;
      gc.copy(tc).multiplyScalar((0.3 + 0.7 * sun) * (0.6 + rng() * 0.25));
      tufts.push([gx, gh - 0.04, gz, rng() * TAU, s * (0.8 + rng() * 0.5), s, s, gc.clone()]);
    }
    var mat = new THREE.MeshLambertMaterial({ map: MT.grassTex(), alphaTest: 0.45, side: THREE.DoubleSide });
    MT.chunks(scene, geo, mat, tufts, 60, false, 2);
  })();

  /* ===== 路旁设施：干草垛、警示牌、观众 ===== */
  var bales = [], chev = [], cones = [];
  var hay = new THREE.Color(0xc4a55a);
  for (i = 0; i < N; i += 3) {
    var kk = c.K[i];
    if (Math.abs(kk) > 1 / 44 && Math.abs(c.K[(i + 12) % N]) > 1 / 44) {                    // 发卡弯外侧
      var sd = kk > 0 ? -1 : 1, r3 = RIGHT[i], p3 = P[i], lat3 = sd * (half + 1.7 + 0.0);
      if (c.isBridge[i] || !clear(p3.x + r3.x * lat3, p3.z + r3.z * lat3, -0.4)) continue;
      if (i % 6 === 0) bales.push([p3.x + r3.x * lat3, roadY[i] + 0.3, p3.z + r3.z * lat3, yawOf(i), 1, 1, 1, hay]);
      if (i % 24 === 0) chev.push([p3.x + r3.x * (lat3 + sd * 1.2), roadY[i] + 1.5, p3.z + r3.z * (lat3 + sd * 1.2), yawOf(i) + Math.PI, -sd * 1.0, 1, 1]);
    }
  }
  scene.add(G.instanced(new THREE.BoxGeometry(0.9, 0.55, 0.5), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), bales, true));
  var ctex = MT.chevTex();
  scene.add(G.instanced(new THREE.PlaneGeometry(1.3, 1.3), new THREE.MeshStandardMaterial({ map: ctex, roughness: 0.55, side: THREE.DoubleSide }), chev, true));
  var chevPosts = []; chev.forEach(function (q) { chevPosts.push([q[0], q[1] - 0.8, q[2], 0]); });
  scene.add(G.instanced(new THREE.BoxGeometry(0.08, 1.6, 0.08), steelMat, chevPosts, true));
  // 铺装段路边轮廓标（白柱 + 黑带 + 反光片），山区公路的典型细节
  (function () {
    var b = new G.GB(1); b.c(0xd9d8d2).box(0.11, 0.95, 0.09, 0, 0.475, 0).c(0x151515).box(0.115, 0.2, 0.095, 0, 0.82, 0).c(0xff8a1a).box(0.06, 0.1, 0.1, 0, 0.82, 0);
    var geo = G.mergeGeos(b.geos), posts = [];
    for (i = 0; i < N; i += 13) {
      if (c.surf[i * 4] < 0.6 || c.isBridge[i]) continue;
      for (var sdp = -1; sdp <= 1; sdp += 2) { var lp = sdp * (half + 1.15), xp = P[i].x + RIGHT[i].x * lp, zp = P[i].z + RIGHT[i].z * lp; if (clear(xp, zp, -0.5)) posts.push([xp, hAt(xp, zp) - 0.05, zp, yawOf(i), 1, 1, 1]); }
    }
    scene.add(G.instanced(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), posts, true));
  })();
  // 起点锥桶 + 轮胎墙
  var f0 = HB.frame({ P: P, RIGHT: RIGHT, TAN: TAN, N: N }, 0), tyres = new G.GB(1);
  for (i = 0; i < 14; i++) { var sdd = i % 2 ? 1 : -1, back = 6 + i * 3.2, q3 = idxAtN(3040 - back), r4 = RIGHT[q3], p4 = P[q3]; cones.push([p4.x + r4.x * sdd * (half + 0.3), roadY[q3] + 0.3, p4.z + r4.z * sdd * (half + 0.3), 0, 1, 1, 1]); }
  scene.add(G.instanced(new THREE.ConeGeometry(0.17, 0.6, 8), new THREE.MeshStandardMaterial({ color: 0xe8561a, roughness: 0.6 }), cones, true));
  for (i = 0; i < 0; i++) { var sd5 = i % 2 ? 1 : -1, q5 = idxAtN(8 + (i >> 1) * 5), r5 = RIGHT[q5], p5 = P[q5]; for (k = 0; k < 3; k++) tyres.c(0x16171a).cyl(0.34, 0.34, 0.24, 14, p5.x + r5.x * sd5 * (half + 1.3), roadY[q5] + 0.14 + k * 0.25, p5.z + r5.z * sd5 * (half + 1.3)); }
  if (tyres.geos.length) scene.add(tyres.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })));


  /* ===== 补给营地 + 瞭望塔（沙地高原）===== */
  (function () {
    var q = idxAtN(770), p = P[q], r = RIGHT[q], t = TAN[q], best = null, bd = 1e9, sd, d;
    for (sd = -1; sd <= 1; sd += 2) for (d = 20; d <= 34; d += 7) { var x = p.x + r.x * sd * d, z = p.z + r.z * sd * d, dh = Math.abs(hAt(x, z) - roadY[q]) + (clear(x, z, 14) ? 0 : 1e4); if (dh < bd) { bd = dh; best = [x, z, sd]; } }
    var ox = best[0], oz = best[1], yaw = yawOf(q), b = new G.GB(2), side = best[2];
    // lx 始终朝赛道外侧，lz 沿赛道方向
    var wp = function (lx, lz) { return [ox + r.x * side * lx + t.x * lz, oz + r.z * side * lx + t.z * lz]; };
    var okAt = function (w, rad) { return clear(w[0], w[1], rad); };
    var tents = [[0xd9782e, 0, 0], [0xe8e2d2, 9, 4], [0x6e7a4a, 4, -10], [0xd9782e, 14, -6], [0xd2c8b0, 12, 9]];
    tents.forEach(function (tn) { var w = wp(tn[1], tn[2]); if (!okAt(w, 4)) return; var h = hAt(w[0], w[1]); b.c(tn[0]).cyl(0, 3.4, 2.6, 4, w[0], h + 1.3 + 0.9, w[1], 0, yaw + Math.PI / 4, 0); b.c(tn[0]).box(4.2, 1.8, 4.2, w[0], h + 0.9, w[1], 0, yaw, 0); });
    for (i = 0; i < 9; i++) { var w2 = wp(5 + (i % 3) * 1.4, 2 + ((i / 3) | 0) * 1.5); if (!okAt(w2, 1)) continue; var h2 = hAt(w2[0], w2[1]); b.c(i % 2 ? 0x2a5da8 : 0xb8322a).cyl(0.4, 0.4, 0.9, 10, w2[0], h2 + 0.45, w2[1]); }
    for (i = 0; i < 3; i++) { var w3 = wp(8, -3 + i * 3); if (!okAt(w3, 1.5)) continue; var h3 = hAt(w3[0], w3[1]); b.c(0x7a5a3a).box(2.4, 0.9, 1.1, w3[0], h3 + 0.45, w3[1], 0, yaw, 0); }
    var tw = wp(22, 2), th = hAt(tw[0], tw[1]);                                // 木制瞭望塔
    if (okAt(tw, 3)) {
    [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]].forEach(function (o2) { var wx = tw[0] + o2[0], wz = tw[1] + o2[1]; b.c(0x6b4f33).box(0.3, 9, 0.3, wx, th + 4.5, wz); });
    b.c(0x7a5a3a).box(3.2, 0.25, 3.2, tw[0], th + 9, tw[1]).box(3.4, 1.0, 0.12, tw[0], th + 9.6, tw[1] + 1.55).box(3.4, 1.0, 0.12, tw[0], th + 9.6, tw[1] - 1.55).box(0.12, 1.0, 3.4, tw[0] + 1.55, th + 9.6, tw[1]).box(0.12, 1.0, 3.4, tw[0] - 1.55, th + 9.6, tw[1]);
    b.c(0x58412a).cyl(0, 2.9, 1.6, 4, tw[0], th + 11.2, tw[1], 0, Math.PI / 4, 0);
    for (i = 0; i < 6; i++) b.c(0x6b4f33).beam(tw[0] - 1.2, th + i * 1.5, tw[1] - 1.2, tw[0] + 1.2, th + i * 1.5 + 1.5, tw[1] - 1.2, 0.1);
    }
    var me = b.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })); scene.add(me);
  })();

  /* ===== 物理/玩法接口 ===== */
  T.railOff = half + 0.9;
  T.wallInner = function () { return half + 0.9; };
  T.innerL = T.innerR = null;
  T.groundY = function (x, z, idx) {
    var p = P[idx], t = TAN[idx], along = (x - p.x) * t.x + (z - p.z) * t.z, a = (idx + 1) % N, b = (idx - 1 + N) % N;
    return roadY[idx] + along * (roadY[a] - roadY[b]) / (D[Math.min(N, idx + 1)] - D[Math.max(0, idx - 1)] + 1e-6);
  };
  T.sAt = function (x, z, idx) { var p = P[idx], t = TAN[idx]; return D[idx] + (x - p.x) * t.x + (z - p.z) * t.z; };
  // 路面不平：低频起伏 + 高频颗粒 + 搓板波纹 + 随机坑洼；sp = surfaceAt 结果，k = 用户“颠簸强度”
  T.bumpH = function (s, lat, sp, k) {
    var a = G.vnoise(s * 0.9 + lat * 0.35, lat * 0.5 + 7.7) - 0.5, b = G.vnoise(s * 2.6 + 3.1, lat * 1.4 + 1.3) - 0.5, c2 = G.vnoise(s * 0.25 + 9.0, lat * 0.2) - 0.5;
    var h = (a * 1.0 + b * 0.55 + c2 * 1.3) * sp.rough * 2.0;
    var loose = sp.w1 + sp.w3 * 0.8; if (loose > 0.05) h += loose * 0.03 * Math.sin(s * 3.5 + 2.2 * G.vnoise(s * 0.2, 1.5)) * (0.5 + G.vnoise(s * 0.1, lat * 0.3));
    var cell = Math.floor(s / 10), hs = G.hash2(cell, 3.7), pp = sp.w0 * 0.1 + sp.w1 * 0.3 + sp.w2 * 0.28;
    if (hs < pp) { var cs = (cell + 0.25 + 0.5 * G.hash2(cell, 9.1)) * 10, cl = (G.hash2(cell, 5.3) - 0.5) * 6, dd = Math.hypot((s - cs) * 0.9, lat - cl); if (dd < 0.75) h -= (0.05 + 0.08 * G.hash2(cell, 1.1)) * (1 - dd / 0.75) * (1 - dd / 0.75); }
    return h * k;
  };
  T.jump = { s0: MT.JUMP / c.sc };
  T.landmarks = {};
  return T;
};

})();
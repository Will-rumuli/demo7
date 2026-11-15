var WIN = GameGlobal;
var THREE = WIN.THREE;
var G = WIN.G;
var MeshoptDecoder = WIN.MeshoptDecoder;

/* ============================================================
 * 巴音布鲁克的干 —— game.play.js
 * 分层：车辆资源 / 车辆物理 / 追逐相机 / 比赛控制 / 展厅 / UI 状态机 / 主循环
 * ============================================================ */
'use strict';

/* ---------- 10. 车辆清单：从 config/cars.json 读取 ----------
 * 新增车辆只需改 config/cars.json：
 *   id       唯一标识（英文，用于存档/模型缓存）
 *   visible  false = 不在展厅展示，同时不加载它的模型分包
 *   avail    false = 显示为未解锁剪影
 *   model    { pkg: 已注册的分包名, file: 包内路径 }，null 表示暂无车模
 *   physics  极速/加速/刹车/转向/抓地/漂移等手感参数
 */
G.CARS_CONFIG = 'config/cars.json';

// 同步读取包内 JSON（小游戏与开发环境都支持 readFileSync）
G.loadCarsConfig = function () {
  try {
    var raw = wx.getFileSystemManager().readFileSync(G.CARS_CONFIG, 'utf8');
    if (raw && typeof raw !== 'string') raw = String(raw);
    var cfg = JSON.parse(raw);
    return (cfg && cfg.cars) || [];
  } catch (e) {
    try { if (WIN.__diag) WIN.__diag.carsCfgErr = String((e && e.message) || e); } catch (x) {}
    return [];
  }
};

// 归一化：补默认值，把 physics 展开成物理层直接可用的字段
G.normalizeCar = function (c, i) {
  var m = c.physics || {};
  var num = function (v, d) { return (v == null || !isFinite(v)) ? d : v; };
  return {
    id: c.id || ('car' + i),
    name: c.name || c.id || ('车辆' + (i + 1)),
    cn: c.cn || '',
    sub: c.sub || '',
    avail: c.avail !== false,
    visible: c.visible !== false,
    yawFix: num(c.yawFix, 0),
    paint: (c.paint == null) ? null : c.paint,
    model: c.model || null,
    tags: c.tags || [],
    desc: c.desc || '',
    spec: c.spec || [],
    stats: c.stats || [],
    vmax: num(m.vmax, 62),
    accel: num(m.accel, 15),
    brakeForce: num(m.brakeForce, 34),
    steerMax: num(m.steerMax, 0.44),
    grip: num(m.grip, 9.0),
    aLat: num(m.aLat, 28),
    aDrift: num(m.aDrift, 60),
    wheelbase: num(m.wheelbase, 2.7)
  };
};

var carCfg = G.loadCarsConfig();
// 配置缺失/损坏时的兜底：保证至少能进游戏
if (!carCfg.length) {
  carCfg = [{ id: 'su7', name: 'SU7', cn: '闪电原型', sub: 'WILL MOTORS · EVAL-01',
    yawFix: -Math.PI / 2, model: { pkg: 'res', file: 'res/su7_mini.glb' },
    tags: ['纯电超跑'], desc: '', spec: [], stats: [],
    physics: { vmax: 62, accel: 15, brakeForce: 34, steerMax: 0.44, grip: 9, aLat: 28, aDrift: 62, wheelbase: 2.7 } }];
}
G.CARS_ALL = carCfg.map(G.normalizeCar);
// 展厅只展示 visible 的车辆；隐藏的车不会进入列表，也就不会加载模型
G.CARS = G.CARS_ALL.filter(function (c) { return c.visible; });
if (!G.CARS.length) G.CARS = G.CARS_ALL.slice(0);

// 按 id 取车辆 / 槽位（避免硬编码下标）
G.carById = function (id) {
  for (var ci = 0; ci < G.CARS.length; ci++) if (G.CARS[ci].id === id) return G.CARS[ci];
  return null;
};
G.carSlot = function (id) {
  for (var si = 0; si < G.CARS.length; si++) if (G.CARS[si].id === id) return si;
  return -1;
};

/* ---------- 10.5 车辆模型分包：由清单的 model 字段自动生成 ---------- */
G.CAR_FILES = {};
G.CARS_ALL.forEach(function (c) {
  if (c.model && c.model.pkg && c.model.file) G.CAR_FILES[c.id] = { pkg: c.model.pkg, file: c.model.file };
});

/* ---------- 11. 车辆工厂：GLB 加载 / 归一化 / 车轮检测 / 方块车兜底 ---------- */
G.CarFactory = {
  models: {}, failed: {}, _waiting: {},

  // 异步加载指定车辆（分包 + 解码）；同一辆车并发请求会排队回调
  load: function (id, onProgress, onDone) {
    var self = this;
    onDone = onDone || function () {};
    if (this.models[id]) { onDone(true); return; }
    if (this._waiting[id]) { this._waiting[id].push(onDone); return; }
    this._waiting[id] = [onDone];
    var cfg = G.CAR_FILES[id];
    if (!cfg) { this._finish(id, false); return; }

    var fail = function (where, e) {
      self.failed[id] = true;
      var msg = e && (e.message || e.reason || e) || where;
      try { WIN.__diag.modelErr = (id + ' ' + where + ': ' + String(msg)).slice(0, 190); } catch (x) {}
      self._finish(id, false);
    };
    var read = function () {
      try {
        var buf = wx.getFileSystemManager().readFileSync(cfg.file);
        if (onProgress) onProgress(1);
        var loader = new THREE.GLTFLoader();
        if (MeshoptDecoder && MeshoptDecoder.supported) loader.setMeshoptDecoder(MeshoptDecoder);
        loader.parse(buf, '', function (gltf) {
          self.models[id] = gltf.scene;
          self._finish(id, true);
        }, function (e) { fail('gltf', e); });
      } catch (e) { fail('read', e); }
    };
    try {
      if (wx.loadSubpackage) {
        var task = wx.loadSubpackage({ name: cfg.pkg, success: read, fail: function (e) { fail('subpackage', e); } });
        if (task && task.onProgressUpdate && onProgress) {
          task.onProgressUpdate(function (r) {
            onProgress(Math.min(0.95, (r.progress || 0) / 100));
          });
        }
      } else { read(); }
    } catch (e) { read(); }
  },
  _finish: function (id, ok) {
    var list = this._waiting[id] || [];
    delete this._waiting[id];
    for (var i = 0; i < list.length; i++) { try { list[i](ok); } catch (e) {} }
  },

  // 构建可驾驶车辆容器（真实模型或兜底方块车），返回值携带 meta 供物理层使用
  build: function (carMeta) {
    var scene = this.models[carMeta.id];
    if (scene) {
      var c = this._prepare(scene.clone(true), carMeta.yawFix);
      if (c) {
        c.meta = carMeta;
        if (carMeta.paint != null) this._paint(c.root, carMeta.paint);
        G.Compat.convert(c.root);
        return c;
      }
    }
    var fb = this.buildBoxCar(carMeta.paint != null ? carMeta.paint : (carMeta.id === 'su7' ? 0xd2622a : 0x2de2ff), false);
    fb.meta = carMeta;
    G.Compat.convert(fb.root);
    return fb;
  },

  // 车漆染色：只改车身材质，跳过接触阴影等无光照材质
  _paint: function (root, hex) {
    root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i++) {
        if (mats[i].isMeshBasicMaterial || mats[i].isSpriteMaterial || !mats[i].color) continue;
        mats[i].color.setHex(hex);
      }
    });
  },

  // 构建未上架剪影车（深色玻璃 + 问号全息）
  buildGhost: function () {
    var car = this.buildBoxCar(0x0c0e10, true);
    car.meta = G.carById('gt1') || G.CARS[G.CARS.length - 1];
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: G.Tex.question(), transparent: true, depthWrite: false
    }));
    spr.scale.set(1.4, 1.4, 1);
    spr.position.set(0, 2.1, 0);
    car.root.add(spr);
    car.question = spr;
    G.Compat.convert(car.root);
    return car;
  },

  // 归一化：缩放到目标长度、贴地、收集/重建车轮枢轴
  _prepare: function (model, yawFix) {
    try {
      model.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(model);
      var size = box.getSize(new THREE.Vector3());
      var len = Math.max(size.x, size.z);
      if (!isFinite(len) || len <= 0) return null;
      var s = 4.55 / len;
      var wrap = new THREE.Group();
      wrap.add(model);
      // 模型前向修正打在内层（wrap.rotation.y 每帧被航向覆写，不能放外层）
      model.rotation.y = (yawFix == null ? G.MODEL_YAW_FIX : yawFix);
      model.scale.setScalar(s);
      model.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(model);
      // 贴地 + 水平居中
      var c = box.getCenter(new THREE.Vector3());
      model.position.x -= c.x; model.position.z -= c.z;
      model.position.y -= box.min.y;
      wrap.updateMatrixWorld(true);

      // 开启阴影 / PBR 反射强度（轮胎材质是双面的，不能强制单面；仅透明玻璃单面避免排序伪影）
      model.traverse(function (o) {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = false;
          if (o.material) {
            var mats = Array.isArray(o.material) ? o.material : [o.material];
            for (var i = 0; i < mats.length; i++) {
              if ('envMapIntensity' in mats[i]) mats[i].envMapIntensity = 1.15;
              if (mats[i].transparent) mats[i].side = THREE.FrontSide;
              // WebGL1 无 isinf，transmission 玻璃着色器会编译失败（整块发黑），降级为半透明
              var gl2 = G.renderer && G.renderer.renderer && G.renderer.renderer.capabilities.isWebGL2;
              if (!gl2 && mats[i].isMeshPhysicalMaterial && mats[i].transmission > 0) {
                mats[i].transmission = 0;
                mats[i].transparent = true;
                mats[i].opacity = Math.min(mats[i].opacity, 0.42);
                mats[i].depthWrite = false;
                mats[i].needsUpdate = true;
              }
            }
          }
        }
      });

      var bsize = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
      var wheels = this._splitWheels(model, wrap);
      this._contact(wrap, bsize.x, bsize.z);
      return { root: wrap, wheels: wheels, source: 'glb', dims: { w: bsize.x, l: bsize.z, h: bsize.y } };
    } catch (e) { return null; }
  },
  // GLB 里四个轮子合并在一个网格里：按象限拆成四个独立网格，各自绑定到轮轴枢轴（可滚转/转向）
  _splitWheels: function (model, wrap) {
    var target = null;
    model.traverse(function (o) {
      if (target || !o.isMesh || !o.material || Array.isArray(o.material)) return;
      if (/wheel/i.test(o.material.name || '')) target = o;
    });
    if (!target) return [];
    var g = target.geometry, P = g.attributes.position, Nn = g.attributes.normal, UV = g.attributes.uv, ix = g.index;
    var M = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(wrap.matrixWorld).invert(), target.matrixWorld);
    var NM = new THREE.Matrix3().getNormalMatrix(M);
    var tris = ix ? ix.count / 3 : P.count / 3, bk = {}, v = new THREE.Vector3(), n = new THREE.Vector3(), id = [0, 0, 0], tp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], t, k;
    for (t = 0; t < tris; t++) {
      var cx = 0, cz = 0;
      for (k = 0; k < 3; k++) {
        id[k] = ix ? ix.getX(t * 3 + k) : t * 3 + k;
        tp[k].fromBufferAttribute(P, id[k]).applyMatrix4(M);
        cx += tp[k].x; cz += tp[k].z;
      }
      var key = (cz > 0 ? 'F' : 'R') + (cx > 0 ? 'L' : 'R'), b = bk[key];
      if (!b) b = bk[key] = { p: [], n: [], u: [], min: new THREE.Vector3(1e9, 1e9, 1e9), max: new THREE.Vector3(-1e9, -1e9, -1e9) };
      for (k = 0; k < 3; k++) {
        b.p.push(tp[k].x, tp[k].y, tp[k].z);
        n.fromBufferAttribute(Nn, id[k]).applyMatrix3(NM).normalize(); b.n.push(n.x, n.y, n.z);
        if (UV) b.u.push(UV.getX(id[k]), UV.getY(id[k]));
        b.min.min(tp[k]); b.max.max(tp[k]);
      }
    }
    var wheels = [];
    Object.keys(bk).forEach(function (key) {
      var b = bk[key], c = b.min.clone().add(b.max).multiplyScalar(0.5), gg = new THREE.BufferGeometry(), i;
      for (i = 0; i < b.p.length; i += 3) { b.p[i] -= c.x; b.p[i + 1] -= c.y; b.p[i + 2] -= c.z; }
      gg.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      gg.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
      if (b.u.length) gg.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
      var mesh = new THREE.Mesh(gg, target.material);
      mesh.castShadow = true;
      var pivot = new THREE.Group();
      pivot.position.copy(c); pivot.rotation.order = 'YXZ';
      pivot.add(mesh); wrap.add(pivot);
      wheels.push({ pivot: pivot, front: key.charAt(0) === 'F', r: Math.max(0.25, (b.max.y - b.min.y) / 2) });
    });
    target.parent.remove(target);
    return wheels;
  },
  // 车底接触阴影（软 AO）：补足阴影贴图分辨率不足时车辆“飘”在路面上的问题
  _contact: function (root, w, l) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.12, l * 1.06),
      new THREE.MeshBasicMaterial({ map: G.PBR.contact(), color: 0x000000, transparent: true, opacity: 0.82, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.02; m.renderOrder = 1;
    root.add(m);
  },

  // 兜底方块车：低多边形轿跑（车头略尖），带完整四轮枢轴
  buildBoxCar: function (color, ghost) {
    var g = new THREE.Group();
    var paint = new THREE.MeshStandardMaterial({
      color: color, roughness: ghost ? 0.25 : 0.32, metalness: ghost ? 0.9 : 0.7,
      envMapIntensity: 1.2
    });
    var glass = new THREE.MeshStandardMaterial({
      color: ghost ? 0x05070a : 0x11161c, roughness: 0.08, metalness: 0.95, envMapIntensity: 1.6
    });
    var dark = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.7, metalness: 0.3 });
    // 车身（下宽上收的三段）
    var body = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.5, 4.5), paint);
    body.position.y = 0.55; body.castShadow = true; g.add(body);
    var nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 0.9), paint);
    nose.position.set(0, 0.46, 2.55); nose.castShadow = true; g.add(nose);
    var cabin = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.44, 2.1), glass);
    cabin.position.set(0, 1.0, -0.25); cabin.castShadow = true; g.add(cabin);
    var tail = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.4, 0.5), paint);
    tail.position.set(0, 0.62, -2.3); tail.castShadow = true; g.add(tail);
    // 尾灯（琥珀发光条）
    var tl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff5a40, emissiveIntensity: 2.2 }));
    tl.position.set(0, 0.78, -2.56); g.add(tl);
    // 前灯
    var hl = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.07, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff2d0, emissiveIntensity: 2.6 }));
    hl.position.set(0, 0.6, 2.98); g.add(hl);
    // 四轮（圆柱 X 轴向）
    var wgeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14);
    wgeo.rotateZ(Math.PI / 2);
    var hubgeo = new THREE.CylinderGeometry(0.15, 0.15, 0.27, 8);
    hubgeo.rotateZ(Math.PI / 2);
    var wmat = new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.9 });
    var hmat = new THREE.MeshStandardMaterial({ color: 0x8d9aa3, roughness: 0.35, metalness: 0.8 });
    var wheels = [];
    var pos = [[0.86, 1.42], [-0.86, 1.42], [0.86, -1.45], [-0.86, -1.45]];
    for (var i = 0; i < 4; i++) {
      var pv = new THREE.Group();
      pv.position.set(pos[i][0], 0.34, pos[i][1]);
      pv.rotation.order = 'YXZ';
      var w = new THREE.Mesh(wgeo, wmat); w.castShadow = true;
      var hub = new THREE.Mesh(hubgeo, hmat);
      pv.add(w); pv.add(hub);
      g.add(pv);
      wheels.push({ pivot: pv, front: i < 2, r: 0.34 });
    }
    this._contact(g, 1.9, 4.6);
    return { root: g, wheels: wheels, source: 'fallback', dims: { w: 1.9, l: 4.6, h: 1.2 } };
  },

  // 每帧车轮动画：滚转 + 前轮转向
  spinWheels: function (car, distDt, steerAngle) {
    var i, w;
    for (i = 0; i < car.wheels.length; i++) {
      w = car.wheels[i];
      w.pivot.rotation.x += distDt / w.r;
      if (w.front) w.pivot.rotation.y = steerAngle * 0.9;
    }
    if (car.question) car.question.material.rotation = Math.sin(performance.now() * 0.0012) * 0.12;
  }
};

/* ---------- 12. 车辆物理：车身坐标系纵/侧速度 + 街机式漂移（控制滑移角、集气、出弯喷射） ---------- */
G.wrapAngle = function (a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
G.Vehicle = function (meta, dims) {
  this.meta = meta;
  this.dims = dims || { w: 1.9, l: 4.6 };
  this.pos = new THREE.Vector3();
  this.heading = 0;
  this.vLong = 0; this.vLat = 0;                  // 车身前后/左右速度 (m/s)
  this.steerAngle = 0;
  this.idx = 0; this.lat = 0; this.prevIdx = 0;
  this.pitch = 0; this.slope = 0;
  this.hitCooldown = 0; this.shake = 0;
  this.slip = 0; this.drifting = false;
  this.driftDir = 0; this.driftT = 0; this.charge = 0; this.boostT = 0; this.recoverT = 0;
  this.nitro = 0;                                 // 已储存的氮气次数（最多 1 次，需手动释放）
  this.dust = 0; this.wet = 0; this.sIdx = 0; this.sw0 = 1;   // 拉力路面：扬尘/涉水/路面类型/抓地
  this.skid = 0; this.event = null;               // event: 'nitroReady' | 'nitroFire' | 'hit' | 'land'
  // 拉力垂向：贴地高度 / 垂直速度 / 腾空状态 / 落地压缩
  this.gy = 0; this.vy = 0; this.air = false; this.airT = 0; this.yawLast = 0;
  this.rideZ = 0; this.slopeAlong = 0;
};
G.Vehicle.prototype = {
  reset: function (track) {
    var P = track.P, TAN = track.TAN;
    // 发车格位于起跑线后方（约 10m）；圈数判定有 8s 保护，起步越线不计圈
    var s = (track.N - Math.round(10 / (track.totalLen / track.N)) + track.N) % track.N;
    this.idx = this.prevIdx = s;
    this.pos.copy(P[s]);
    if (track.def && track.def.theme === 'harbor') this.pos.addScaledVector(track.RIGHT[s], -2.7);
    this.pos.y = P[s].y;
    this.heading = Math.atan2(TAN[s].x, TAN[s].z);
    this.vLong = 0; this.vLat = 0; this.steerAngle = 0;
    this.hitCooldown = 0; this.shake = 0; this.slip = 0; this.skid = 0;
    this.drifting = false; this.charge = 0; this.nitro = 0; this.boostT = 0; this.recoverT = 0; this.driftT = 0; this.event = null;
    this.dust = 0; this.wet = 0; this.sIdx = 0; this.sw0 = 1;
    this.gy = this.pos.y; this.vy = 0; this.air = false; this.airT = 0; this.yawLast = 0;
    this.rideZ = 0; this.slopeAlong = 0; this.pitch = 0;
  },
  _endDrift: function () {
    // 漂移结束不再自动喷射：集气进度保留，满格后转成一次手动氮气
    this.drifting = false; this.recoverT = 0.4;
  },
  // 手动释放氮气（QQ 飞车式）：无存量时返回 false
  useNitro: function () {
    if (this.nitro <= 0) return false;
    this.nitro = 0;
    this.boostT = Math.max(this.boostT, 1.7);
    this.vLong += 3.5;
    this.event = 'nitroFire';
    // 释放后，之前因上限卡在满格的集气立即转化为下一次机会
    if (this.charge >= 1) { this.charge = 0; this.nitro = 1; }
    return true;
  },
  step: function (dt, input, track) {
    var m = this.meta;
    var spd = Math.hypot(this.vLong, this.vLat);
    var speed01 = G.CLAMP(spd / m.vmax, 0, 1);
    var boosting = this.boostT > 0;
    if (boosting) this.boostT -= dt;
    if (this.recoverT > 0) this.recoverT -= dt;

    // --- 转向：高速时减小最大转角（稳定性） ---
    var maxSteer = m.steerMax / (1 + speed01 * 2.4);
    this.steerAngle = G.DAMP(this.steerAngle, input.steer * maxSteer, 13, dt);

    // --- 漂移状态机：行驶中按住漂移键并打方向 -> 进入；松键/太慢 -> 退出并喷射 ---
    if (!this.drifting) {
      if (!this.air && input.handbrake && this.vLong > 14 && Math.abs(input.steer) > 0.15) {
        // 进入漂移不清空已集的气：跨多次漂移累计，只有转化/复位才归零
        this.drifting = true; this.driftDir = input.steer > 0 ? 1 : -1; this.driftT = 0;
      }
    } else {
      this.driftT += dt;
      if (!input.handbrake || this.vLong < 9) this._endDrift();
    }

    var vmaxNow = m.vmax * (boosting ? 1.16 : 1);
    var heading = this.heading, yawRate = 0;
    if (this.air) {
      // 腾空：没有牵引力和转向，保持惯性飞行（轻微风阻）
      yawRate = this.yawLast * 0.992;
      this.vLong -= Math.sign(this.vLong) * Math.min(Math.abs(this.vLong), 0.0006 * this.vLong * this.vLong * dt);
      this.skid = G.DAMP(this.skid, 0, 8, dt);
    } else if (this.drifting) {
      var dir = this.driftDir, into = input.steer * dir;      // into：-1 反打 .. +1 进弯打满
      var k = G.CLAMP(this.driftT / 0.28, 0, 1); k = k * k * (3 - 2 * k);
      var S = spd;
      // 漂移横摆角速度：进弯打满时约 1.65 rad/s（95°/s），比之前更容易切进急弯
      var omega = dir * (0.95 + 0.62 * into) * G.CLAMP(S / 24, 0.55, 1.05);
      if (input.throttle > 0) S += m.accel * 0.55 * (1 - G.CLAMP(S / vmaxNow, 0, 1)) * (boosting ? 1.9 : 1) * dt;
      if (input.brake > 0) S -= m.brakeForce * 0.6 * dt;
      S -= (0.7 + 0.0005 * S * S) * dt;
      var cap = m.aDrift / Math.max(0.3, Math.abs(omega));     // 向心加速度上限 -> 弯越紧速度越低
      if (S > cap) S -= (S - cap) * 0.95 * dt;
      var beta = G.CLAMP(0.32 + 0.2 * into, 0.1, 0.54) * k;     // 目标滑移角
      this.vLat = G.DAMP(this.vLat, dir * S * Math.sin(beta), 8, dt);
      this.vLong = Math.sqrt(Math.max(0, S * S - this.vLat * this.vLat));
      yawRate = omega;
      this.charge = Math.min(1, this.charge + dt * (0.55 + 0.45 * Math.max(0, into)) / 1.6);
      // 集满一格转换为一次可用氮气（最多存 1 次）；已有存量时集气停在满格等待
      if (this.charge >= 1 && this.nitro < 1) {
        this.nitro = 1; this.charge = 0; this.event = 'nitroReady';
      }
      this.skid = G.CLAMP(0.45 + 0.55 * k * (0.6 + 0.4 * Math.abs(into)), 0, 1);
    } else {
      // --- 纵向动力 ---
      if (input.throttle > 0) {
        this.vLong += m.accel * (boosting ? 1.9 : 1) * (1 - G.CLAMP(this.vLong / vmaxNow, 0, 1)) * input.throttle * dt;
      }
      var braking = input.brake > 0;
      if (braking) {
        if (this.vLong > 0.5) this.vLong -= m.brakeForce * dt;
        else this.vLong = 0;                                      // 刹停，不再自动倒车
      }
      // 空气阻力 + 滚阻 + 松油门发动机制动
      var drag = 0.0006 * this.vLong * this.vLong + (input.throttle > 0 ? 0.5 : 2.4);
      this.vLong -= Math.sign(this.vLong) * Math.min(Math.abs(this.vLong), drag * dt);
      // 手刹（不打方向）= 强制动
      if (input.handbrake) this.vLong -= Math.sign(this.vLong) * Math.min(Math.abs(this.vLong), 16 * dt);

      // --- 横向：侧向抓地上限（超过即推头、掉速） ---
      var req = (this.vLong / m.wheelbase) * Math.tan(this.steerAngle);
      var capYaw = m.aLat / Math.max(6, Math.abs(this.vLong));
      yawRate = G.CLAMP(req, -capYaw, capYaw);
      var excess = Math.abs(req) - capYaw;
      if (excess > 0) this.vLong -= Math.sign(this.vLong) * Math.min(Math.abs(this.vLong), excess * Math.abs(this.vLong) * 0.18 * dt);
      this.vLat *= Math.exp(-(this.recoverT > 0 ? 6 : m.grip) * dt);
      // 重刹/推头时轮胎抱死留痕
      var skidT = 0;
      if (braking && this.vLong > 22) skidT = G.CLAMP((this.vLong - 22) / 24, 0, 0.7);
      if (excess > 0.12 && Math.abs(this.vLong) > 20) skidT = Math.max(skidT, G.CLAMP(excess * 1.5, 0, 0.6));
      this.skid = G.DAMP(this.skid, skidT, 12, dt);
    }
    heading -= yawRate * dt;                       // 屏幕右转 = 航向减小
    this.heading = heading; this.yawLast = yawRate;

    // --- 世界速度合成与位移 ---
    var fx = Math.sin(heading), fz = Math.cos(heading);
    var rx = Math.cos(heading), rz = -Math.sin(heading);
    var vx = fx * this.vLong + rx * this.vLat;
    var vz = fz * this.vLong + rz * this.vLat;
    this.pos.x += vx * dt; this.pos.z += vz * dt;

    // --- 赛道约束：按车身真实占位（宽/长/偏航角）与墙面碰撞，不再穿模 ---
    this.prevIdx = this.idx;
    this.idx = track.nearest(this.pos, this.idx);
    this.lat = track.lateral(this.pos, this.idx);
    var tn = track.TAN[this.idx], ty = Math.atan2(tn.x, tn.z), dpsi = G.wrapAngle(heading - ty);
    var ext = this.dims.w * 0.5 * Math.abs(Math.cos(dpsi)) + this.dims.l * 0.5 * Math.abs(Math.sin(dpsi));
    var side = this.lat >= 0 ? 1 : -1;
    var inner = track.wallInner ? track.wallInner(this.idx, side) : track.railOff;
    var limit = inner - ext - 0.03;
    if (Math.abs(this.lat) > limit) {
      var r = track.RIGHT[this.idx], over = Math.abs(this.lat) - limit;
      this.pos.x -= r.x * side * over; this.pos.z -= r.z * side * over;     // 只沿法向推回，不改变纵向位置
      var vRight = vx * r.x + vz * r.z, impact = Math.abs(vRight);
      if (vRight * side > 0) {
        vx -= r.x * vRight * 1.22; vz -= r.z * vRight * 1.22;
        this.vLong = vx * fx + vz * fz;
        this.vLat = vx * rx + vz * rz;
        // 贴墙摩擦：车头被墙“带”得与墙面平行（按当前朝向选方向，允许逆行/掉头）
        var fwdDot = G.wrapAngle(heading - ty);
        var goal = Math.abs(fwdDot) <= Math.PI / 2 ? ty : ty + Math.PI;
        this.heading += G.wrapAngle(goal - this.heading) * (1 - Math.exp(-7 * dt)) * G.CLAMP(0.35 + impact / 6, 0, 1);
        this.vLong *= 1 - G.CLAMP(0.5 + impact * 0.12, 0, 1.6) * dt;
        if (impact > 3.5 && this.hitCooldown <= 0) {
          this.vLong *= 0.78;
          this.hitCooldown = 0.7;
          this.shake = Math.min(1.2, impact / 8);
          this.event = 'hit';
          if (this.drifting && impact > 5) this._endDrift();
          if (G.audio) G.audio.thud(impact / 8);
        }
        if (Math.abs(this.vLong) < 4) {              // 低速搁浅辅助：向路中心轻推
          this.pos.x -= r.x * side * 1.4 * dt; this.pos.z -= r.z * side * 1.4 * dt;
        }
      }
      this.lat = limit * side;
    }
    if (this.hitCooldown > 0) this.hitCooldown -= dt;

    // --- 路面高度 / 坡度 ---
    var P = track.P, N = track.N;
    var i0 = this.idx, tn0 = track.TAN[i0];
    if ((this.pos.x - P[i0].x) * tn0.x + (this.pos.z - P[i0].z) * tn0.z < 0) i0 = (i0 - 1 + N) % N;   // 车在采样点之前：用前一段
    var nxt = (i0 + 1) % N;
    var segA = P[i0], segB = P[nxt];
    var segLen = Math.max(0.001, segA.distanceTo(segB));
    var t = G.CLAMP(((this.pos.x - segA.x) * (segB.x - segA.x) + (this.pos.z - segA.z) * (segB.z - segA.z)) / (segLen * segLen), 0, 1);
    var gyN = G.LERP(segA.y, segB.y, t);
    var slopeSeg = (segB.y - segA.y) / segLen;            // 单段坡度：跳台台唇的抛射速度靠它（平滑坡度会把台唇抹平）
    // 坡度取前后各 6 个采样点（≈22m）估算，避免跳台台唇等单段台阶让车身俯仰突然翻起
    var iA = (this.idx - 6 + N) % N, iB = (this.idx + 6) % N;
    var dxz = Math.hypot(P[iB].x - P[iA].x, P[iB].z - P[iA].z) || 1;
    this.slope = (P[iB].y - P[iA].y) / dxz;
    if (track.surfaceAt) this._vertical(dt, gyN, slopeSeg, vx, vz, tn);
    else { this.pos.y = gyN; this.air = false; this.vy = 0; }
    // 腾空时车头沿抛物线姿态，落地后回到地形俯仰
    var targetPitch = this.air
      ? G.CLAMP(Math.atan2(this.vy, Math.max(6, Math.abs(this.vLong))), -0.55, 0.55)
      : Math.atan(this.slope);
    this.pitch = G.DAMP(this.pitch, targetPitch, this.air ? 4 : 8, dt);

    this.slip = G.CLAMP(Math.abs(this.vLat) / (Math.abs(this.vLong) * 0.35 + 4), 0, 1);

    // --- 拉力路面：沥青/碎石/泥地/沙地/涉水 影响抓地与扬尘 ---
    if (track.surfaceAt) {
      var sfc = track.surfaceAt(this.idx, this.lat);
      this.dust = sfc.dust; this.wet = sfc.water; this.sIdx = sfc.idx; this.sw0 = sfc.mu;
      this.vLong -= Math.sign(this.vLong) * Math.min(Math.abs(this.vLong), sfc.rr * 9.8 * dt);
    } else { this.dust = 0; this.wet = 0; this.sIdx = 0; this.sw0 = 1; }
  },
  // 垂向：贴地 / 坡顶·跳台台唇抛射腾空 / 落地压缩
  _vertical: function (dt, gy, slopeSeg, vx, vz, tn) {
    var g = 9.81;
    this.gy = gy;
    var vyG = slopeSeg * (vx * tn.x + vz * tn.z);     // 沿坡面的地面抬升速度
    if (this.air) {
      this.airT += dt;
      this.vy -= g * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= gy || this.airT > 4) {
        var imp = vyG - this.vy;                      // 相对地面的下落速度
        this.pos.y = gy; this.air = false; this.airT = 0; this.vy = vyG;
        if (imp > 2.2) {
          var k = G.CLAMP(imp / 10, 0, 1.2);
          this.rideZ = -Math.min(0.24, imp * 0.032);  // 落地悬挂压缩（视觉）
          this.vLong *= 1 - Math.min(0.1, imp * 0.007);
          this.shake = Math.max(this.shake, Math.min(1.1, imp / 9));
          if (imp > 4) { this.event = 'land'; if (G.audio) G.audio.thud(k); }
        }
      }
    } else {
      var yb = this.pos.y + this.vy * dt - 0.5 * g * dt * dt;
      // 地面比抛物线下落得更快 -> 离地（跳台台唇 / 坡顶）
      if (yb > gy + 0.004 && this.vy - vyG > 1.2) { this.air = true; this.airT = 0; this.pos.y = yb; }
      else { this.pos.y = gy; this.vy = vyG; }
    }
    this.rideZ = G.DAMP(this.rideZ, 0, 6, dt);
  }
};
/* ---------- 13. 追逐相机（跟随 / 速度FOV / 过弯倾斜 / 碰撞震动） ---------- */
G.ChaseCam = function (camera) {
  this.cam = camera;
  this.pos = new THREE.Vector3(0, 4, -10);
  this.look = new THREE.Vector3();
  this.shakeAmp = 0;
  this._target = new THREE.Vector3();
  this._lastVeh = new THREE.Vector3();
};
G.ChaseCam.prototype = {
  snap: function (veh) {
    var fx = Math.sin(veh.heading), fz = Math.cos(veh.heading);
    // 拉力图视野拉远一点，能看到前方起伏与扬尘（与原版 HTML 一致）
    var rally = !!(G.race && G.race.track && G.race.track.surfaceAt);
    var d0 = rally ? 9 : 6.4, h0 = rally ? 3.0 : 2.1;
    this.pos.set(veh.pos.x - fx * d0, veh.pos.y + h0, veh.pos.z - fz * d0);
    this.look.set(veh.pos.x, veh.pos.y + 0.25, veh.pos.z);
    this._lastVeh.copy(veh.pos);
    this.ang = veh.heading; this._ci = null;
  },
  update: function (dt, veh, input) {
    var speed01 = G.CLAMP(Math.abs(veh.vLong) / veh.meta.vmax, 0, 1);
    // 相机朝向 = 车头与行驶方向的折中：漂移时车身侧过来，画面看得到滑移角
    var slipAng = Math.hypot(veh.vLong, veh.vLat) > 6 ? Math.atan2(veh.vLat, veh.vLong) : 0;
    var goal = veh.heading + slipAng * 0.6;
    if (this.ang == null) this.ang = goal;
    this.ang += G.wrapAngle(goal - this.ang) * (1 - Math.exp(-(veh.drifting ? 8 : 6) * dt));
    var fx = Math.sin(this.ang), fz = Math.cos(this.ang);
    var boost = veh.boostT > 0 ? 1 : 0;
    this.boostK = G.DAMP(this.boostK || 0, boost, 5, dt);
    var rallyCam = !!(G.race && G.race.track && G.race.track.surfaceAt);
    var dist = rallyCam ? (9.2 + speed01 * 2.0 + this.boostK * 1.2) : (6.4 + speed01 * 0.8 + this.boostK * 0.5);
    var h = rallyCam ? (2.9 + speed01 * 0.4) : (2.1 + speed01 * 0.2);
    this._target.set(veh.pos.x - fx * dist, veh.pos.y + h, veh.pos.z - fz * dist);
    // 速度前馈：阻尼跟随会在高速时把相机越拖越远，先把车身位移同步给相机
    var mvx = veh.pos.x - this._lastVeh.x, mvy = veh.pos.y - this._lastVeh.y, mvz = veh.pos.z - this._lastVeh.z;
    this._lastVeh.copy(veh.pos);
    this.pos.x += mvx; this.pos.y += mvy; this.pos.z += mvz;
    this.look.x += mvx; this.look.y += mvy; this.look.z += mvz;
    var lam = 8.5 - speed01 * 2.5;                  // 高速略松弛（速度感）
    this.pos.x = G.DAMP(this.pos.x, this._target.x, lam, dt);
    this.pos.y = G.DAMP(this.pos.y, this._target.y, lam, dt);
    this.pos.z = G.DAMP(this.pos.z, this._target.z, lam, dt);
    // 相机不出墙：发卡弯里相机滞后会甩到护墙/防碎网外侧，约束回赛道内
    var tr = G.race && G.race.track;
    if (tr && tr.wallInner) {
      var ci = tr.nearest(this.pos, this._ci != null ? this._ci : veh.idx), cl = tr.lateral(this.pos, ci);
      this._ci = ci;
      var cs = cl >= 0 ? 1 : -1, lim = tr.wallInner(ci, cs) - 0.7;
      if (Math.abs(cl) > lim) { var rr = tr.RIGHT[ci], o = Math.abs(cl) - lim; this.pos.x -= rr.x * cs * o; this.pos.z -= rr.z * cs * o; }
    }
    var lookF = rallyCam ? 7.0 : 2.2, lookY = rallyCam ? 1.1 : 0.25;
    this.look.x = G.DAMP(this.look.x, veh.pos.x + fx * lookF, 12, dt);
    this.look.y = G.DAMP(this.look.y, veh.pos.y + lookY, 12, dt);
    this.look.z = G.DAMP(this.look.z, veh.pos.z + fz * lookF, 12, dt);
    // 山地：相机不要钻进地形
    if (tr && tr.groundY) {
      var th = tr.terrainHeight(this.pos.x, this.pos.z) + 0.9;
      if (this.pos.y < th) this.pos.y = th;
    }
    // 震动衰减
    this.shakeAmp = Math.max(veh.shake, this.shakeAmp, this.boostK * 0.18) * Math.exp(-3.2 * dt);
    veh.shake = 0;
    var sx = (Math.random() - 0.5) * this.shakeAmp * 0.5;
    var sy = (Math.random() - 0.5) * this.shakeAmp * 0.35;
    this.cam.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z + sx);
    this.cam.lookAt(this.look.x + sx * 0.5, this.look.y + sy * 0.5, this.look.z);
    // 过弯倾斜（侧倾 roll） + 漂移方向
    var bank = -input.steer * speed01 * 0.05 - G.CLAMP(veh.vLat * 0.004, -0.04, 0.04);
    this.cam.rotateZ(bank);
    // 速度 FOV（喷射时再拉开，整体更紧，车在画面里更大）
    var fov = rallyCam ? (58 + speed01 * 12 + this.boostK * 8) : (50 + speed01 * 6 + this.boostK * 5);
    if (Math.abs(this.cam.fov - fov) > 0.1) { this.cam.fov = fov; this.cam.updateProjectionMatrix(); }
  }
};

/* ---------- 13b. 轮胎刹车印（环形缓冲的条带网格）+ 轮胎烟 ---------- */
G.Skids = function (scene, cap) {
  cap = this.cap = cap || 6000;
  this.head = 0; this.full = false; this.w = []; this.dirty = false;
  var pos = new Float32Array(cap * 12), al = new Float32Array(cap * 4), uv = new Float32Array(cap * 8), idx = new Uint32Array(cap * 6), i;
  for (i = 0; i < cap; i++) { var b = i * 4; idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6); }
  var g = this.geo = new THREE.BufferGeometry();
  this.aPos = new THREE.BufferAttribute(pos, 3); this.aAl = new THREE.BufferAttribute(al, 1); this.aUv = new THREE.BufferAttribute(uv, 2);
  [this.aPos, this.aAl, this.aUv].forEach(function (a) { a.setUsage(THREE.DynamicDrawUsage); });
  g.setAttribute('position', this.aPos); g.setAttribute('alpha', this.aAl); g.setAttribute('uv', this.aUv);
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.setDrawRange(0, 0);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
  // 横向软边 + 纵向斑驳（干胶痕）的 alpha 贴图
  var cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  var c2 = cv.getContext('2d'), im = c2.createImageData(64, 128), x, y;
  for (y = 0; y < 128; y++) for (x = 0; x < 64; x++) {
    var u = x / 63, edge = Math.min(1, Math.min(u, 1 - u) / 0.26);
    var n = G.pFbm(x / 64, y / 128, 4, 3, 5) * 0.6 + G.pHash(x, y, 7) * 0.4;
    var tread = 0.85 + 0.15 * Math.sin(u * 40);
    var a = edge * edge * tread * (0.5 + 0.5 * G.SS(0.25, 0.7, n));
    var j = (y * 64 + x) * 4; im.data[j] = im.data[j + 1] = im.data[j + 2] = a * 255; im.data[j + 3] = 255;
  }
  c2.putImageData(im, 0, 0);
  var tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  var mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
    vertexShader: 'attribute float alpha; varying vec2 vUv; varying float vA;\n#include <fog_pars_vertex>\nvoid main(){ vUv = uv; vA = alpha; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}',
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; varying float vA;\n#include <fog_pars_fragment>\nvoid main(){ gl_FragColor = vec4(0.006, 0.006, 0.007, texture2D(map, vUv).g * vA);\n#include <fog_fragment>\n}',
    transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6
  });
  mat.uniforms.map.value = tex;
  this.mesh = new THREE.Mesh(g, mat);
  this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
  scene.add(this.mesh);
};
G.Skids.prototype = {
  clear: function () { this.head = 0; this.full = false; this.geo.setDrawRange(0, 0); this.w.forEach(function (s) { s.has = false; }); },
  // pts: [{x,z,k}]（k = 该轮强度系数）；intensity 0..1
  update: function (pts, intensity, y) {
    var hw = 0.14, i;
    for (i = 0; i < pts.length; i++) {
      var s = this.w[i] || (this.w[i] = { has: false, x: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, d: 0, a: 0 });
      var a = intensity * pts[i].k;
      if (a < 0.12) { s.has = false; continue; }
      var px = pts[i].x, pz = pts[i].z;
      if (!s.has) { s.has = true; s.x = px; s.z = pz; s.a = a; s.first = true; continue; }
      var dx = px - s.x, dz = pz - s.z, dd = Math.hypot(dx, dz);
      if (dd < 0.7) continue;
      if (dd > 8) { s.x = px; s.z = pz; s.first = true; continue; }          // 传送/重置
      var nx = -dz / dd * hw, nz = dx / dd * hw;
      var nlx = px + nx, nlz = pz + nz, nrx = px - nx, nrz = pz - nz;
      if (s.first) { s.lx = s.x + nx; s.lz = s.z + nz; s.rx = s.x - nx; s.rz = s.z - nz; s.d = 0; s.first = false; }
      this._quad(s.lx, s.lz, s.rx, s.rz, nlx, nlz, nrx, nrz, y + 0.012, s.d, s.d + dd, s.a, a);
      s.lx = nlx; s.lz = nlz; s.rx = nrx; s.rz = nrz; s.x = px; s.z = pz; s.d += dd; s.a = a;
    }
    this._flush();
  },
  _quad: function (l0x, l0z, r0x, r0z, l1x, l1z, r1x, r1z, y, d0, d1, a0, a1) {
    var q = this.head, p = this.aPos.array, c = this.aAl.array, u = this.aUv.array, o = q * 12, k = q * 4, t = q * 8;
    p[o] = l0x; p[o + 1] = y; p[o + 2] = l0z; p[o + 3] = r0x; p[o + 4] = y; p[o + 5] = r0z;
    p[o + 6] = l1x; p[o + 7] = y; p[o + 8] = l1z; p[o + 9] = r1x; p[o + 10] = y; p[o + 11] = r1z;
    var A0 = Math.min(0.92, a0 * 0.95), A1 = Math.min(0.92, a1 * 0.95);
    c[k] = A0; c[k + 1] = A0; c[k + 2] = A1; c[k + 3] = A1;
    var v0 = d0 / 1.4, v1 = d1 / 1.4;
    u[t] = 0; u[t + 1] = v0; u[t + 2] = 1; u[t + 3] = v0; u[t + 4] = 0; u[t + 5] = v1; u[t + 6] = 1; u[t + 7] = v1;
    this.dirty = true;
    if (++this.head >= this.cap) { this.head = 0; this.full = true; }
  },
  _flush: function () {
    if (!this.dirty) return;
    this.dirty = false;
    this.aPos.needsUpdate = this.aAl.needsUpdate = this.aUv.needsUpdate = true;
    this.geo.setDrawRange(0, (this.full ? this.cap : this.head) * 6);
  }
};
G.Smoke = function (scene, n) {
  n = n || 90; this.list = []; this.acc = [0, 0, 0, 0];
  var cv = document.createElement('canvas'); cv.width = cv.height = 64;
  var g = cv.getContext('2d'), im = g.createImageData(64, 64);
  for (var y = 0; y < 64; y++) for (var x = 0; x < 64; x++) {
    var d = Math.hypot(x - 31.5, y - 31.5) / 32, a = Math.max(0, 1 - d); a = a * a * (3 - 2 * a) * (0.6 + 0.4 * G.pNoise(x / 8, y / 8, 8, 8, 3));
    var j = (y * 64 + x) * 4; im.data[j] = im.data[j + 1] = im.data[j + 2] = 255; im.data[j + 3] = a * 255;
  }
  g.putImageData(im, 0, 0);
  this.tex = new THREE.CanvasTexture(cv);
  for (var i = 0; i < n; i++) {
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xcfcac2, transparent: true, depthWrite: false, opacity: 0 }));
    sp.visible = false; scene.add(sp);
    this.list.push({ s: sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0 });
  }
};
G.Smoke.prototype = {
  update: function (dt, pts, veh, intensity) {
    var i, p, vx = Math.sin(veh.heading) * veh.vLong + Math.cos(veh.heading) * veh.vLat, vz = Math.cos(veh.heading) * veh.vLong - Math.sin(veh.heading) * veh.vLat;
    for (i = 0; i < pts.length; i++) {
      if (!pts[i].smoke || intensity < 0.3) continue;
      this.acc[i] += dt * 26 * intensity;
      while (this.acc[i] >= 1) { this.acc[i] -= 1; this._emit(pts[i], veh.pos.y, vx, vz); }
    }
    for (i = 0; i < this.list.length; i++) {
      p = this.list[i]; if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      var t = 1 - p.life / p.max;
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      p.vx *= 1 - 1.6 * dt; p.vz *= 1 - 1.6 * dt;
      var sc = 0.9 + 3.4 * Math.sqrt(t);
      p.s.scale.set(sc, sc, 1);
      p.s.material.opacity = 0.2 * Math.pow(1 - t, 1.6);
    }
  },
  _emit: function (pt, y, vx, vz) {
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i];
      if (p.life > 0) continue;
      p.life = p.max = 0.9 + Math.random() * 0.7;
      p.s.position.set(pt.x + (Math.random() - 0.5) * 0.3, y + 0.25, pt.z + (Math.random() - 0.5) * 0.3);
      p.vx = vx * 0.16 + (Math.random() - 0.5) * 1.2; p.vz = vz * 0.16 + (Math.random() - 0.5) * 1.2; p.vy = 0.5 + Math.random() * 0.8;
      p.s.visible = true; p.s.material.rotation = Math.random() * 6.28;
      return;
    }
  },
  clear: function () { this.list.forEach(function (p) { p.life = 0; p.s.visible = false; }); }
};

/* ---------- 14. 比赛控制：场景搭建 / 圈速 / 倒计时 / 结算 ---------- */
G.bestKey = function (mapId) { var d = G.TRACKS[mapId]; return 'apex_best_' + mapId + (d && d.ver ? '_' + d.ver : ''); };
G.Race = function (renderer, input, audio) {
  this.renderer = renderer; this.input = input; this.audio = audio;
  this.scene = null; this.track = null; this.car = null; this.veh = null;
  this.cam = new G.ChaseCam(renderer.camera);
  this.state = 'idle';                            // idle | countdown | running | finished
  this.mapId = null; this.def = null;
  this.raceTime = 0; this.lapStart = 0; this.lap = 1; this.lapTimes = [];
  this.cdT = 0; this._cdShown = -1;
  this.msgT = 0;
};
// 不同地图的调色（曝光/对比/饱和），未配置时回到默认
// 注意：低端机不支持 HDR 时会走直出模式，grade 只有 uSpeed/uTime 的占位对象，不能直接改 uExposure
G.Race.applyGrade = function (renderer, g) {
  var u = renderer && renderer.grade && renderer.grade.uniforms;
  if (!u) return;
  g = g || {};
  if (u.uExposure) u.uExposure.value = g.uExposure || 0.95;
  if (u.uContrast) u.uContrast.value = g.uContrast || 1.05;
  if (u.uSat) u.uSat.value = g.uSat || 1.02;
  // 直出模式没有调色 Pass：把本图的曝光同步给材质里的 ACES 色调映射
  if (renderer.fallbackRender && renderer.renderer) {
    renderer.renderer.toneMappingExposure = (g.uExposure || 0.95) / 0.6;
  }
};
G.Race.prototype = {
  // 搭建比赛场景（同步，城市/山地生成约 0.3~0.8s）
  setup: function (mapId, carVisual) {
    this.dispose();
    this.mapId = mapId;
    this.def = G.TRACKS[mapId];
    var scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(this.def.fog[0]);
    scene.fog = new THREE.Fog(this.def.fog[0], this.def.fog[1], this.def.fog[2]);
    scene.add(G.makeSky(this.renderer));
    if (this.renderer.envMap) scene.environment = this.renderer.envMap;
    this.renderer.makeLights(scene);
    this.track = G.buildTrack(scene, this.def, this.renderer);
    G.Race.applyGrade(this.renderer, this.def.grade);
    this.car = carVisual;
    scene.add(carVisual.root);
    // 非 PBR 世界（旧山地/城市）弱化场景物件环境反射；PBR 世界保持物理正确的 1.0
    carVisual.root.traverse(function (o) { if (o.isMesh) o.userData.carMat = true; });
    if (!this.def.pbrWorld) scene.traverse(function (o) {
      if (o.isMesh && !o.userData.carMat && o.material) {
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < ms.length; i++) if ('envMapIntensity' in ms[i]) ms[i].envMapIntensity = 0.3;
      }
    });
    this._setupProbe(scene, carVisual);
    this.veh = new G.Vehicle(carVisual.meta, carVisual.dims);
    this.veh.reset(this.track);
    this.skids = new G.Skids(scene);
    this.smoke = new G.Smoke(scene);
    // 拉力赛道：松软路面扬尘（G.Dust 由 mountain 模块的 surfaceAt 驱动）
    this.dust = this.track.surfaceAt ? new G.Dust(scene, G.Quality.level === 'low' ? 520 : 1000) : null;
    this._wheelPts = null;
    this._thr = 0;
    this._flatForced = false;
    WIN.__shaderFail = false;                     // 只统计本次赛道构建后的着色器编译结果
    carVisual.root.rotation.order = 'YXZ';        // 先偏航后俯仰（坡道姿态正确）
    G.Compat.convert(scene);
    this.cam.snap(this.veh);
    this._applyCarPose(0);
  },
  begin: function () {                            // 进入倒计时
    this.raceTime = 0; this.lapStart = 0; this.lap = 1; this.lapTimes = [];
    this.cdT = 0; this._cdShown = -1;
    this.state = 'countdown';
    var best = parseFloat(G.store.get(G.bestKey(this.mapId), 'NaN'));
    G.UI.setHudBest(isFinite(best) ? best : null);
  },
  restart: function () {
    this.veh.reset(this.track);
    this.skids.clear(); this.smoke.clear(); if (this.dust) this.dust.clear();
    this.cam.snap(this.veh);
    this._applyCarPose(0);
    this.begin();
  },
  // 撞墙复位：回到最近的赛道中心线并对准赛道方向，不重置圈速
  respawn: function () {
    if (!this.track || !this.veh || this.state !== 'running') return;
    var now = Date.now();
    if (this._resetAt && now - this._resetAt < 600) return;
    this._resetAt = now;
    var v = this.veh, tr = this.track;
    var i = tr.nearest(v.pos, v.idx);
    v.idx = v.prevIdx = i;
    v.pos.copy(tr.P[i]);
    v.pos.y = tr.P[i].y;
    v.heading = Math.atan2(tr.TAN[i].x, tr.TAN[i].z);
    v.vLong = 0; v.vLat = 0; v.steerAngle = 0;
    v.slip = 0; v.skid = 0; v.lat = 0; v.hitCooldown = 0.6;
    v.drifting = false; v.charge = 0; v.driftT = 0; v.boostT = 0; v.recoverT = 0;
    v.air = false; v.airT = 0; v.vy = 0; v.rideZ = 0;
    this.cam.snap(v);
    this._applyCarPose(0);
    if (G.UI) G.UI.raceMsg('已复位 · 继续比赛', 1.2);
  },
  // 手动释放氮气（仅比赛中有效）
  useNitro: function () {
    if (!this.veh || this.state !== 'running') return false;
    return this.veh.useNitro();
  },
  dispose: function () {
    if (!this.scene) return;
    // 先摘除车辆（模型与展厅共享，不可销毁其几何/材质）
    if (this.car) { this.scene.remove(this.car.root); this._restoreCarEnv(); }
    if (this.probe) { this.probe.renderTarget.dispose(); this.probe = null; }
    this.scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < ms.length; i++) {
          for (var k in ms[i]) { if (ms[i][k] && ms[i][k].isTexture) ms[i][k].dispose(); }
          ms[i].dispose();
        }
      }
    });
    this.scene = null; this.track = null; this.car = null; this.veh = null; this.skids = null; this.smoke = null;
    this.state = 'idle';
  },
  // 轮胎印 / 烟：按车轮枢轴位置换算世界接地点
  _fx: function (dt) {
    var v = this.veh, car = this.car, i;
    if (!this._wheelPts) {
      var ws = car.wheels && car.wheels.length === 4 ? car.wheels.map(function (w) { return { x: w.pivot.position.x, z: w.pivot.position.z, front: w.front }; })
        : [{ x: 0.8, z: 1.4, front: true }, { x: -0.8, z: 1.4, front: true }, { x: 0.8, z: -1.4, front: false }, { x: -0.8, z: -1.4, front: false }];
      this._wheelPts = ws.map(function (w) { return { lx: w.x, lz: w.z, front: w.front, x: 0, z: 0, k: w.front ? 0.55 : 1, smoke: !w.front }; });
    }
    var cs = Math.cos(v.heading), sn = Math.sin(v.heading);
    for (i = 0; i < this._wheelPts.length; i++) {
      var p = this._wheelPts[i];
      p.x = v.pos.x + p.lx * cs + p.lz * sn; p.z = v.pos.z - p.lx * sn + p.lz * cs;
    }
    this.skids.update(this._wheelPts, v.skid, v.pos.y);
    this.smoke.update(dt, this._wheelPts, v, v.skid);
    // 松软路面扬尘：速度 + 打滑 + 油门共同决定强度，颜色跟随路面（沙地偏黄、泥地偏暗）
    if (this.dust) {
      var spd = Math.hypot(v.vLong, v.vLat);
      if (v.dust > 0.03 && spd > 2.5 && !v.air) {
        var drive = G.CLAMP((spd - 2) / 20, 0, 1.3);
        var slide = 0.9 * v.skid + 0.7 * Math.min(1, Math.abs(v.vLat) / 5);
        // 漂移/沙地时扬尘要明显：提高发射率 + 更大更浓的尘团
        var kk = v.dust * (drive * 0.9 + slide * 1.35 + 0.5 * (this._thr || 0) * drive) * 26;
        var col = v.sIdx === 3 ? 0xb39a74 : (v.sIdx === 2 ? 0x5a4a38 : 0x9c8665);
        if (kk > 0.15) this.dust.emitFrom(dt, this._wheelPts, v, kk, col, v.sIdx === 3 ? 0.22 : 0.2, false);
      }
      this.dust.tick(dt, this.renderer.camera);
    }
  },
  // 车辆周围的动态反射探针：车漆/玻璃反射真实的岸桥、集装箱与墙体（仅高画质）
  _setupProbe: function (scene, car) {
    this.probe = null; this._probeT = 0; this._carMats = [];
    if (!G.Quality.conf().probe || !this.renderer.renderer.capabilities.isWebGL2) return;
    var rt = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    this.probe = new THREE.CubeCamera(0.5, 2500, rt);
    scene.add(this.probe);
    var mats = this._carMats;
    car.root.traverse(function (o) {
      if (!o.isMesh || !o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
        if (m.isMeshStandardMaterial && mats.indexOf(m) < 0) { mats.push(m); m.userData.envBak = m.envMap; m.envMap = rt.texture; m.needsUpdate = true; }
      });
    });
  },
  _restoreCarEnv: function () {
    (this._carMats || []).forEach(function (m) { m.envMap = m.userData.envBak || null; m.needsUpdate = true; });
    this._carMats = [];
  },
  updateProbe: function () {
    if (!this.probe || !this.car) return;
    if ((this._probeT = (this._probeT + 1) % 3) !== 0) return;
    var r = this.renderer.renderer, sm = r.shadowMap.autoUpdate;
    this.car.root.visible = false;
    r.shadowMap.autoUpdate = false;
    this.probe.position.copy(this.veh.pos); this.probe.position.y += 0.9;
    this.probe.update(r, this.scene);
    r.shadowMap.autoUpdate = sm;
    this.car.root.visible = true;
  },
  // 车辆视觉姿态：位置 / 航向 / 坡度俯仰 / 车轮
  _applyCarPose: function (dt) {
    var v = this.veh;
    this.car.root.position.copy(v.pos);
    if (v.rideZ) this.car.root.position.y += v.rideZ;   // 落地悬挂压缩
    this.car.root.rotation.y = v.heading;
    // 拉力图用平滑后的坡度俯仰；海港等平地保持原逻辑
    this.car.root.rotation.x = (this.track && this.track.surfaceAt)
      ? -G.CLAMP(v.pitch, -0.45, 0.45)
      : -Math.asin(G.CLAMP(v.slope, -0.5, 0.5)) * 0.9;
    G.CarFactory.spinWheels(this.car, (dt || 0) * v.vLong, -v.steerAngle * 1.4);
  },
  update: function (dt) {
    if (this.state === 'idle' || this.state === 'finished') return;
    var UI = G.UI;

    if (this.state === 'countdown') {
      this.cdT += dt;
      var step = Math.floor(this.cdT);
      if (step !== this._cdShown && step <= 3) {
        this._cdShown = step;
        var label = step < 3 ? String(3 - step) : 'GO';
        UI.countdown(label);
        if (this.audio) this.audio.countBeep(step === 3);
      }
      // F1 式起跑灯：每 0.6s 亮一组，五组全亮后全灭即发车
      if (this.track.setLights) this.track.setLights(this.cdT < 3 ? Math.min(5, Math.floor(this.cdT / 0.6) + 1) : 0);
      this._applyCarPose(0);
      this.cam.update(dt, this.veh, this.input.sample(dt));
      this.renderer.followSun(this.veh.pos);
      this.updateProbe();
      if (this.cdT >= 3.4) { this.state = 'running'; UI.countdown(null); }
      return;
    }

    // --- running ---
    var input = this.input.sample(dt);
    this.veh.step(dt, input, this.track);
    this._applyCarPose(dt);
    this._thr = input.throttle;
    this._fx(dt);
    this.cam.update(dt, this.veh, input);
    this.renderer.followSun(this.veh.pos);
    this.updateProbe();
    this.raceTime += dt;
    var ev = this.veh.event;
    if (ev) {
      this.veh.event = null;
      if (ev === 'nitroReady') { UI.raceMsg('氮气已就绪', 1.2); if (this.audio) this.audio.beep(880, 0.12, 0.18, 'sine'); }
      else if (ev === 'nitroFire') { UI.raceMsg('氮气喷射', 1.1); if (this.audio) this.audio.beep(660, 0.24, 0.22, 'sawtooth'); }
    }
    UI.setBoost(this.veh.charge, this.veh.boostT > 0, this.veh.nitro);

    // --- 圈数判定：从末段越过起跑线 ---
    var N = this.track.N, idx = this.veh.idx, prev = this.veh.prevIdx;
    if (prev > N * 0.88 && idx < N * 0.12 && this.veh.vLong > 1 && this.raceTime - this.lapStart > 8) {
      var lapT = this.raceTime - this.lapStart;
      this.lapTimes.push(lapT);
      this.lapStart = this.raceTime;
      var isBest = this._updateBest(lapT);
      this.audio && this.audio.lapChime();
      if (this.lap >= this.def.laps) {
        this._finish();
      } else {
        this.lap++;
        UI.raceMsg('第 ' + (this.lap - 1) + ' 圈  ' + G.fmtTime(lapT) + (isBest ? '  ◆ 个人最佳' : ''), 2.6);
      }
      UI.setHudLap(this.lap, this.def.laps);
    }
    UI.setHudTime(this.raceTime - this.lapStart);
    UI.setHudSpeed(Math.abs(this.veh.vLong) * 3.6, Math.abs(this.veh.vLong) / this.veh.meta.vmax);
    UI.setDrift(this.veh.drifting);
    // 行驶音效
    if (this.audio) {
      this.audio.drive(
        G.CLAMP(Math.abs(this.veh.vLong) / this.veh.meta.vmax * 0.85 + input.throttle * 0.18, 0, 1),
        input.throttle,
        G.CLAMP(Math.abs(this.veh.vLong) / this.veh.meta.vmax, 0, 1),
        this.veh.slip * (this.veh.drifting ? 1 : 0.55), input.brake, dt);
    }
  },
  _updateBest: function (t) {
    var k = G.bestKey(this.mapId);
    var old = parseFloat(G.store.get(k, 'NaN'));
    if (!isFinite(old) || t < old) { G.store.set(k, t); return true; }
    return false;
  },
  _finish: function () {
    this.state = 'finished';
    if (this.audio) this.audio.mute();
    G.UI.showFinish(this.def.name, this.lapTimes, this._total());
  },
  _total: function () {
    var s = 0;
    for (var i = 0; i < this.lapTimes.length; i++) s += this.lapTimes[i];
    return s;
  }
};

/* ---------- 15. 展厅（暗色影棚 + 转台 + 拖拽旋转 + 车辆切换） ---------- */
// 影棚环境：暗色房间 + 顶部大柔光箱 + 两侧竖条灯 + 背后暖色轮廓灯带，烘焙成 PMREM
G.makeStudioEnv = function (renderer) {
  var s = new THREE.Scene();
  var room = new THREE.Mesh(new THREE.BoxGeometry(40, 16, 40), new THREE.MeshBasicMaterial({ color: 0x050607, side: THREE.BackSide }));
  room.position.y = 7; s.add(room);
  var panel = function (w, h, x, y, z, rx, ry, k, hex) {
    var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex || 0xffffff).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0); s.add(m);
  };
  panel(16, 5, 0, 14.8, 0, Math.PI / 2, 0, 5);
  panel(3, 11, -19.8, 6, -4, 0, Math.PI / 2, 3.5, 0xdff6ff); panel(3, 11, -19.8, 6, 6, 0, Math.PI / 2, 2.4, 0xff4d8d);
  panel(3, 11, 19.8, 6, 4, 0, -Math.PI / 2, 3.5, 0xdff6ff);
  panel(26, 1.2, 0, 2.6, -19.8, 0, 0, 3, 0x5ee6ff);
  panel(10, 4, 0, 7, 19.8, 0, Math.PI, 1.2);
  var pm = new THREE.PMREMGenerator(renderer), t = pm.fromScene(s, 0.02).texture;
  pm.dispose();
  return t;
};
G.Showroom = function (renderer) {
  this.renderer = renderer;
  this.scene = new THREE.Scene();
  this.scene.background = new THREE.Color(0x03060a);
  this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  this.yaw = 0.6; this.yawVel = 0;
  this.slot = 0; this.zoom = 1; this.t = 0;
  this.carRoot = null;
  this._W = 0; this._H = 0;
  this._build();
};
G.Showroom.prototype = {
  _build: function () {
    var scene = this.scene, i;
    scene.fog = new THREE.FogExp2(0x03060a, 0.022);
    // 地面：深色高光漆面 + 径向渐隐的霓虹网格（自发光，又能被 Bloom 拾取）
    var gc = document.createElement('canvas'); gc.width = gc.height = 1024;
    var g = gc.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = '#2de2ff'; g.lineWidth = 2;
    for (i = 0; i <= 32; i++) {
      var p = i * 32; g.globalAlpha = i % 4 === 0 ? 0.9 : 0.35;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 1024); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(1024, p); g.stroke();
    }
    g.globalAlpha = 1;
    var fade = g.createRadialGradient(512, 512, 40, 512, 512, 512);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(0.35, 'rgba(0,0,0,0.55)'); fade.addColorStop(0.8, 'rgba(0,0,0,1)');
    g.fillStyle = fade; g.fillRect(0, 0, 1024, 1024);
    var gridTex = new THREE.CanvasTexture(gc); gridTex.encoding = THREE.sRGBEncoding; gridTex.anisotropy = 8;
    var floor = new THREE.Mesh(new THREE.CircleGeometry(24, 96),
      new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.2, metalness: 0.0, emissive: 0xffffff, emissiveMap: gridTex, emissiveIntensity: 0.22 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    scene.add(floor);
    // 底座：黑镍铬转台 + 青色光环
    var deck = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.85, 0.1, 96), new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.3, metalness: 0.85 }));
    deck.position.y = 0.05; deck.receiveShadow = true; scene.add(deck);
    var glow = function (r, tube, k, hex) {
      var m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 128), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex || 0x2de2ff).multiplyScalar(k) }));
      m.rotation.x = -Math.PI / 2; m.position.y = 0.11; scene.add(m); return m;
    };
    glow(3.62, 0.028, 3.2); glow(4.5, 0.012, 1.4);
    // 虚线外环（缓慢自转）
    var dc = document.createElement('canvas'); dc.width = 512; dc.height = 8;
    var dg = dc.getContext('2d'); dg.fillStyle = '#fff';
    for (i = 0; i < 24; i++) dg.fillRect(i * 21.3, 0, 12, 8);
    var dt = new THREE.CanvasTexture(dc); dt.wrapS = THREE.RepeatWrapping;
    var dash = new THREE.Mesh(new THREE.RingGeometry(5.7, 5.78, 128), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2de2ff).multiplyScalar(1.6), alphaMap: dt, transparent: true, side: THREE.DoubleSide }));
    dash.rotation.x = -Math.PI / 2; dash.position.y = 0.02; scene.add(dash); this.dash = dash;
    // 扫描环：上下往复扫过车身（全息建模感）
    this.scanMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.scan = new THREE.Mesh(new THREE.TorusGeometry(3.05, 0.012, 6, 128), this.scanMat);
    this.scan.rotation.x = -Math.PI / 2; scene.add(this.scan);
    // 背景光源：大弧光环 + 两侧竖灯
    var halo = new THREE.Mesh(new THREE.TorusGeometry(9, 0.07, 8, 160, Math.PI * 1.25), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2de2ff).multiplyScalar(2.2) }));
    halo.position.set(0, 5.5, -22); halo.rotation.z = Math.PI * 0.375; halo.scale.setScalar(1.5); scene.add(halo);
    var bar = function (x, hex, k) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 14, 0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) }));
      m.position.set(x, 7, -24); scene.add(m);
    };
    bar(-14, 0x2de2ff, 2.0); bar(14, 0xff4d8d, 1.6); bar(-9, 0x2de2ff, 0.8); bar(9, 0xff4d8d, 0.7);
    // 灯光：冷白主光 + 青/洋红轮廓光
    var key = new THREE.SpotLight(0xe8f6ff, 3.4, 60, 0.5, 0.5);
    key.position.set(5, 12, 7); key.castShadow = !WIN.__SAFE_RENDER;
    key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0002;
    scene.add(key);
    var rimC = new THREE.SpotLight(0x2de2ff, 2.6, 50, 0.7, 0.6); rimC.position.set(-9, 5, -8); scene.add(rimC);
    var rimM = new THREE.SpotLight(0xff4d8d, 1.8, 50, 0.7, 0.6); rimM.position.set(9, 4, -8); scene.add(rimM);
    scene.add(new THREE.AmbientLight(0x30404c, 0.3));
    this.camera.position.set(0, 1.5, 11.5);
    this.camera.lookAt(0, 0.8, 0);
  },
  setCar: function (carVisual) {
    if (this.carRoot) this.scene.remove(this.carRoot);
    this.carRoot = carVisual.root;
    this.carRoot.position.set(0, 0.1, 0);
    this.carRoot.rotation.x = 0;
    this.scene.add(this.carRoot);
  },
  update: function (dt, input) {
    this.t += dt;
    // 拖拽 -> 角速度（带惯性），无操作时缓慢自转
    if (Math.abs(input.dragDX) > 0.01) {
      this.yawVel = input.dragDX * 0.14;
      input.dragDX = 0;
    }
    this.yawVel *= Math.exp(-3.4 * dt);
    this.yaw += (this.yawVel + 0.22) * dt;
    if (this.carRoot) this.carRoot.rotation.y = this.yaw;
    this.dash.rotation.z += dt * 0.12;
    var ph = (this.t % 3.6) / 3.6;
    this.scan.position.y = 0.12 + ph * 1.9;
    this.scanMat.color.setRGB(0.5, 2.0, 2.4).multiplyScalar(Math.sin(ph * Math.PI) * 1.2);
    // 显式按窗口比例维护透视（之前相机比例固定为 1，宽屏下车辆被横向拉伸、车轮变椭圆）
    var W = WIN.innerWidth, H = WIN.innerHeight, asp = W / H, cam = this.camera;
    if (W !== this._W || H !== this._H) {
      this._W = W; this._H = H; cam.aspect = asp;
      if (W > 760) cam.setViewOffset(W, H, -W * (asp > 1.4 ? 0.12 : 0.17), 0, W, H); else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
    var frac = W > 760 ? (asp > 1.4 ? 0.42 : 0.5) : 0.72;
    var dist = 5.0 / (frac * 2 * Math.tan(cam.fov * Math.PI / 360) * Math.min(asp, 1.8)) * this.zoom;
    cam.position.x = Math.sin(this.t * 0.2) * 0.35;
    cam.position.y = 1.35 + Math.sin(this.t * 0.4) * 0.08;
    cam.position.z = dist;
    cam.lookAt(0, 0.75, 0);
  }
};

/* ---------- 16. UI 状态机：见 js/ui.js（Canvas2D 重绘，替代原 DOM 版） ---------- */

/* ---------- 17. 启动与主循环 ---------- */
(function main() {
  // 0. WebGL 能力检查
  var canvas = WIN.__canvas;
  try {
    G.renderer = new G.Render(canvas);
  } catch (e) {
    if (G.UI && G.UI.fatal) G.UI.fatal('无法创建 WebGL 上下文：' + e.message);
    else if (WIN.__fatal) WIN.__fatal('设备不支持 WebGL');
    return;
  }
  var renderer = G.renderer;
  G.Quality.detect(renderer.renderer.getContext());
  renderer.applyQuality(G.Quality.level);
  G.audio = new G.AudioKit();
  G.input = new G.Input();
  G.MODEL_YAW_FIX = -Math.PI / 2;                  // SU7 原生车头朝 +X，内旋 -90° 校正到 +Z（实机校准）

  // UI 提前初始化，让启动进度条可见（ctx 稍后补全）
  G.UI.init({ renderer: renderer, input: G.input, audio: G.audio });

  var setBoot = function (pct, msg) {
    G.UI.setBoot(pct, msg);
  };
  setBoot(0.08, '正在点火渲染引擎');

  // 1. 天空 -> PMREM 环境贴图（车漆反射）；兼容模式下跳过，避免半浮点/PMREM 异常
  if (!WIN.__SAFE_RENDER) {
    var envScene = new THREE.Scene();
    envScene.add(G.makeSky(renderer, true));
    renderer.bakeEnvironment(envScene);
  } else {
    renderer.envMap = null;
  }
  setBoot(0.2, '正在布设展厅灯光');

  // 2. 展厅
  G.showroom = new G.Showroom(renderer);
  G.Compat.convert(G.showroom.scene);
  if (!WIN.__SAFE_RENDER) {
    G.showroom.scene.environment = G.makeStudioEnv(renderer.renderer); // 影棚灯箱环境（车漆长条高光）
  }
  var ghost1 = G.CarFactory.buildGhost();
  G.ghostVisual = ghost1;
  G.carVisuals = {};
  var firstCar = G.CARS[0];                        // 展厅首位（按上架过滤后的顺序）
  G.su7Visual = G.CarFactory.build(firstCar);      // 暂用兜底/缓存模型，加载完成后替换
  G.carVisuals[firstCar.id] = G.su7Visual;
  G.showroom.setCar(G.su7Visual);
  G.showroom.slot = 0;

  // 3. 比赛
  G.race = new G.Race(renderer, G.input, G.audio);

  // 4. UI
  G.UI.init({ race: G.race, showroom: G.showroom, renderer: renderer, input: G.input, audio: G.audio });
  G.UI.refreshShowroom();

  // 5. 模型异步加载（失败 -> 方块车兜底）；只加载当前上架的车辆
  G.bootReady = false;
  setBoot(0.26, '正在载入 车库');
  var syncVisual = function (meta) {
    var vis = G.CarFactory.build(meta);
    G.carVisuals[meta.id] = vis;
    if (meta.id === firstCar.id) G.su7Visual = vis;
    if (G.showroom && G.CARS[G.showroom.slot].id === meta.id) {
      G.showroom.setCar(vis);
      G.UI.refreshShowroom();
    }
  };
  G.CarFactory.load(firstCar.id, function (p) {
    setBoot(0.26 + p * 0.6, '正在载入 车库');
  }, function (ok) {
    if (ok) { syncVisual(firstCar); setBoot(1, '车模就绪'); }
    else { G.UI.toast('车模加载失败，已启用备用赛车', 3600); setBoot(1, '备用车辆就绪'); }
    G.bootReady = true;
    // 其余上架车辆后台依次预载；visible:false 的车不在列表里，也就不会加载分包
    var rest = G.CARS.slice(1), idx = 0;
    var preloadNext = function () {
      if (idx >= rest.length) return;
      var meta = rest[idx++];
      G.CarFactory.load(meta.id, null, function (ok2) {
        if (ok2) syncVisual(meta);
        setTimeout(preloadNext, 600);
      });
    };
    setTimeout(preloadNext, 600);
  });

  // 6. 首次交互解锁音频（小游戏触屏由 UI 层转发）
  var unlock = function () { G.audio.start(); G.audio.resume(); };
  G.input.onFirstTouch(unlock);

  // 7. 主循环
  var clock = { last: 0 };
  var state = 'boot';
  function loop(t) {
    WIN.requestAnimationFrame(loop);
    var dt = Math.min(0.05, (t - clock.last) / 1000 || 0.016);
    clock.last = t;
    var UI = G.UI;

    // Esc / R 快捷键
    if (G.input.consumePause()) {
      if (UI.state === 'race') { UI.paused ? UI.resume() : UI.pause(); }
    }
    if (G.input.consumeRestart() && UI.state === 'race') { UI.restart(); }

    // 背景音乐场景切换：展厅 / 比赛，暂停时自动压低
    if (G.audio) {
      // 比赛音效按地图主题区分：海港 = 风声 + 海浪
      var auScene = UI.state === 'race'
        ? ((G.race && G.race.mapId === 'harbor') ? 'harbor' : 'race')
        : (UI.state === 'boot' || UI.state === 'pilot' || UI.state === 'showroom' || UI.state === 'mapsel') ? 'showroom' : null;
      G.audio.setScene(auScene, UI.paused || UI.finishVisible);
    }

    if (UI.state === 'showroom' || UI.state === 'mapsel') {
      renderer.grade.uniforms.uSpeed.value = 0;
      G.showroom.update(dt, G.input);
      renderer.render(G.showroom.scene, G.showroom.camera);
      clock.acc = (clock.acc || 0) + dt; clock.n = (clock.n || 0) + 1;
      if (clock.acc > 0.5) { UI.setSys(clock.n / clock.acc); clock.acc = 0; clock.n = 0; }
    } else if (UI.state === 'race') {
      // 自定义着色器在个别 WebGL1 机型上确实编译失败时，强制降级为 Lambert（至少保证场景可见）
      if (WIN.__shaderFail && G.race.scene && !G.race._flatForced) {
        G.race._flatForced = true;
        G.Compat.convert(G.race.scene, true);
      }
      if (!UI.paused) {
        G.race.update(dt);
        // 天空云层 / 水面流动
        var i, now = t * 0.001;
        for (i = 0; i < G.waterMats.length; i++) G.waterMats[i].uniforms.time.value = now;
        if (G.race.track) for (i = 0; i < G.race.track.clouds.length; i++) {
          var cl = G.race.track.clouds[i];
          cl.position.x += dt * 1.2;
          if (cl.position.x > 950) cl.position.x = -950;
        }
        if (G.race.veh) {
          var sp01 = G.CLAMP(Math.abs(G.race.veh.vLong) / G.race.veh.meta.vmax, 0, 1);
          renderer.grade.uniforms.uSpeed.value = sp01 * sp01 + (G.race.veh.boostT > 0 ? 0.3 : 0);
        }
      }
      renderer.grade.uniforms.uTime.value = t * 0.001;
      if (G.race.scene) renderer.render(G.race.scene, renderer.camera);
    } else {
      // boot：转一下兜底车
      G.showroom.update(dt, G.input);
      renderer.render(G.showroom.scene, G.showroom.camera);
    }

    // 启动完成 -> 等车模/分包加载完成后淡出启动屏，再进展厅
    if (state === 'boot') {
      if (G.bootReady && t > 1400 && !UI.boot.done) UI.hideBoot();
      if (UI.boot.done && UI.boot.fade >= 1) {
        state = 'showroom';
        // 已有车手名：直接进展厅，不再每次登记
        var savedName = String(UI.pilotName || '').trim();
        if (savedName) {
          UI.show('showroom');
          UI.toast('欢迎回来，' + savedName, 2200);
        } else {
          UI.showPilot();
        }
      }
    }

    // UI 叠加层（Canvas2D -> 全屏纹理，最后绘制）
    UI.render(dt, t);
  }
  WIN.requestAnimationFrame(loop);

  // 8. 切后台自动暂停（小游戏生命周期）
  if (wx.onHide) wx.onHide(function () {
    if (G.UI.state === 'race' && !G.UI.paused) G.UI.pause();
  });
})();


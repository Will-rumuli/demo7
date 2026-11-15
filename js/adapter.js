/**
 * 微信小游戏运行环境适配层
 * 职责：上屏画布 / window 与 document 兜底 / 本地存储 / RAF / Blob+URL（GLTF 内嵌贴图）
 * 游戏代码通过 WIN(=GameGlobal) 访问这些能力，避免直接依赖浏览器 API。
 */
var WIN = (typeof GameGlobal !== 'undefined') ? GameGlobal : this;
// 浏览器联调模式（dev-test）：保留浏览器原生 window/document/RAF/Blob，仅模拟 wx
var DEV = !!WIN.__DEV_TEST__;

function def(obj, key, value) {
  try { obj[key] = value; if (obj[key] === value) return; } catch (e) {}
  try { Object.defineProperty(obj, key, { value: value, writable: true, configurable: true }); } catch (e) {}
}
function defGetter(obj, key, getter) {
  try { Object.defineProperty(obj, key, { get: getter, configurable: true }); } catch (e) {}
}

/* ---------- 1. 屏幕与上屏画布 ---------- */
var info = wx.getSystemInfoSync();
var W = info.windowWidth || 375;
var H = info.windowHeight || 667;
var DPR = info.pixelRatio || 1;

var canvas = wx.createCanvas();          // 首个 createCanvas 即上屏画布
canvas.width = Math.round(W * DPR);
canvas.height = Math.round(H * DPR);
WIN.__canvas = canvas;

// 刘海屏安全区（横屏时主要是左右）
var _sa = info.safeArea;
WIN.__safe = _sa ? {
  left: Math.max(0, _sa.left),
  top: Math.max(0, _sa.top),
  right: Math.max(0, W - _sa.right),
  bottom: Math.max(0, H - _sa.bottom)
} : { left: 0, top: 0, right: 0, bottom: 0 };

// 右上角胶囊按钮区域（避免 UI 被微信菜单/关闭按钮遮挡）
WIN.__capsule = null;
try {
  if (wx.getMenuButtonBoundingClientRect) {
    var _mb = wx.getMenuButtonBoundingClientRect();
    if (_mb && _mb.width) {
      WIN.__capsule = { left: _mb.left, right: _mb.right, top: _mb.top, bottom: _mb.bottom, width: _mb.width, height: _mb.height };
    }
  }
} catch (e) {}

// three 的 WebGLRenderer 会访问这些浏览器属性
if (!DEV) {
  def(canvas, 'style', {});
  def(canvas, 'addEventListener', function () {});
  def(canvas, 'removeEventListener', function () {});
  def(canvas, 'setAttribute', function () {});
  def(canvas, 'focus', function () {});
  def(canvas, 'getBoundingClientRect', function () { return { left: 0, top: 0, width: W, height: H }; });
  defGetter(canvas, 'clientWidth', function () { return W; });
  defGetter(canvas, 'clientHeight', function () { return H; });

  defGetter(WIN, 'innerWidth', function () { return W; });
  defGetter(WIN, 'innerHeight', function () { return H; });
  defGetter(WIN, 'devicePixelRatio', function () { return DPR; });
}

/* ---------- 2. 简易事件表（resize / blur 等） ---------- */
var listeners = {};
if (!DEV) {
  def(WIN, 'addEventListener', function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); });
  def(WIN, 'removeEventListener', function (type, fn) {
    var a = listeners[type]; if (!a) return;
    var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  });
}
function emit(type, ev) {
  var a = listeners[type] || [];
  for (var i = 0; i < a.length; i++) { try { a[i](ev || {}); } catch (e) {} }
}
WIN.__emit = emit;

/* ---------- 3. document 兜底（游戏里主要用 createElement('canvas')） ---------- */
function stubEl(tag) {
  return {
    tagName: tag, style: {}, hidden: false, textContent: '', innerHTML: '', className: '', disabled: false,
    classList: { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} },
    appendChild: function (c) { return c; }, removeChild: function () {},
    addEventListener: function () {}, removeEventListener: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    querySelectorAll: function () { return []; }, querySelector: function () { return null; },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 0, height: 0 }; }
  };
}

// 小游戏 Image 没有 addEventListener，补齐 three ImageLoader 依赖的接口
WIN.__blobData = WIN.__blobData || {};
function bytesToBase64(bytes) {
  var B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '', i;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B[(n >> 18) & 63] + B[(n >> 12) & 63] + B[(n >> 6) & 63] + B[n & 63];
  }
  var r = bytes.length - i;
  if (r === 1) { var n1 = bytes[i] << 16; out += B[(n1 >> 18) & 63] + B[(n1 >> 12) & 63] + '=='; }
  else if (r === 2) { var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B[(n2 >> 18) & 63] + B[(n2 >> 12) & 63] + B[(n2 >> 6) & 63] + '='; }
  return out;
}

function makeImage() {
  var img = wx.createImage();
  var handlers = { load: [], error: [] };
  def(img, 'style', {});
  def(img, 'addEventListener', function (type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  });
  def(img, 'removeEventListener', function (type, fn) {
    var a = handlers[type]; if (!a) return;
    var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  });
  def(img, 'setAttribute', function () {});
  try { img.crossOrigin = null; } catch (e) {}
  var fire = function (type, ev) {
    var a = handlers[type] || [];
    for (var i = 0; i < a.length; i++) { try { a[i].call(img, ev); } catch (e) {} }
  };
  try { img.onload = function () { fire('load', { type: 'load', target: img }); }; } catch (e) {}
  try {
    img.onerror = function () {
      // 有些机型不支持直接读 wxfile:// 路径：自动改用 base64 data URI 重试一次
      var data = WIN.__blobData[img.src];
      if (data && !img.__retried) { img.__retried = true; img.src = data; return; }
      fire('error', { type: 'error', target: img });
    };
  } catch (e) {}
  return img;
}

var doc = (typeof document !== 'undefined' && document) ? document : {};
if (!DEV) {
  def(WIN, 'document', doc);
  def(doc, 'createElement', function (tag) {
    tag = String(tag || 'div').toLowerCase();
    if (tag === 'canvas') return wx.createCanvas();
    if (tag === 'img' || tag === 'image') return makeImage();
    return stubEl(tag);
  });
  def(doc, 'createElementNS', function (ns, tag) { return doc.createElement(tag); });
  def(doc, 'getElementById', function () { return stubEl('div'); });
  def(doc, 'querySelector', function () { return null; });
  def(doc, 'querySelectorAll', function () { return []; });
  def(doc, 'addEventListener', function () {});
  def(doc, 'removeEventListener', function () {});
  def(doc, 'body', stubEl('body'));
  def(doc, 'documentElement', stubEl('html'));
  defGetter(doc, 'hidden', function () { return false; });
}

/* ---------- 4. Blob + URL：GLTFLoader 内嵌贴图走 createObjectURL ---------- */
function toBytes(part, out) {
  if (part == null) return;
  if (part instanceof ArrayBuffer) { out.push(new Uint8Array(part)); return; }
  if (ArrayBuffer.isView(part)) { out.push(new Uint8Array(part.buffer, part.byteOffset, part.byteLength)); return; }
  if (typeof part === 'string') {
    var s = unescape(encodeURIComponent(part)), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    out.push(b); return;
  }
  if (typeof part.length === 'number') { for (var j = 0; j < part.length; j++) toBytes(part[j], out); }
}
function Blob(parts, opts) {
  var list = [];
  toBytes(parts, list);
  this._parts = list;
  this.type = (opts && opts.type) || '';
  var n = 0;
  for (var i = 0; i < list.length; i++) n += list[i].length;
  this.size = n;
}
Blob.prototype.arrayBuffer = function () {
  var total = 0, i;
  for (i = 0; i < this._parts.length; i++) total += this._parts[i].length;
  var out = new Uint8Array(total), off = 0;
  for (i = 0; i < this._parts.length; i++) { out.set(this._parts[i], off); off += this._parts[i].length; }
  return out;
};

var fsm = wx.getFileSystemManager();
var texSeq = 0;
function extOf(mime) {
  if (!mime) return '.bin';
  if (mime.indexOf('png') >= 0) return '.png';
  if (mime.indexOf('jpg') >= 0 || mime.indexOf('jpeg') >= 0) return '.jpg';
  if (mime.indexOf('webp') >= 0) return '.webp';
  return '.bin';
}

if (!DEV) {
  def(WIN, 'Blob', Blob);
  def(WIN, 'URL', {
    createObjectURL: function (blob) {
      var bytes = blob.arrayBuffer();
      var p = wx.env.USER_DATA_PATH + '/gt_tex_' + (texSeq++) + extOf(blob.type);
      try { fsm.writeFileSync(p, bytes.buffer, 'binary'); } catch (e) {}
      // 同时缓存 data URI，供 Image 读取本地路径失败时重试
      try { WIN.__blobData[p] = 'data:' + (blob.type || 'image/jpeg') + ';base64,' + bytesToBase64(bytes); } catch (e) {}
      return p;
    },
    revokeObjectURL: function (p) { try { fsm.unlinkSync(p); } catch (e) {} delete WIN.__blobData[p]; }
  });
}
if (typeof WIN.self === 'undefined') def(WIN, 'self', WIN);

// 小游戏里没有 createImageBitmap，强制 GLTFLoader 走 Image 解码路径
def(WIN, 'createImageBitmap', undefined);

/* ---------- 5. 存储：wx 本地缓存 ---------- */
if (!DEV) {
  def(WIN, 'localStorage', {
    getItem: function (k) {
      try { var v = wx.getStorageSync(k); return (v === '' || v === undefined) ? null : v; } catch (e) { return null; }
    },
    setItem: function (k, v) { try { wx.setStorageSync(k, String(v)); } catch (e) {} },
    removeItem: function (k) { try { wx.removeStorageSync(k); } catch (e) {} }
  });
}

/* ---------- 6. 时间 / RAF ---------- */
if (typeof WIN.performance === 'undefined') def(WIN, 'performance', { now: function () { return Date.now(); } });

var startTime = Date.now();
var nativeRAF = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : null;
if (!DEV) {
  def(WIN, 'requestAnimationFrame', function (cb) {
    var tick = function () { cb(Date.now() - startTime); };
    if (nativeRAF) return nativeRAF(tick);
    return setTimeout(tick, 16);
  });
  def(WIN, 'cancelAnimationFrame', function (id) {
    if (nativeRAF && WIN.cancelAnimationFrame) { try { WIN.cancelAnimationFrame(id); } catch (e) {} } else clearTimeout(id);
  });
}

/* ---------- 7. 尺寸变化 ---------- */
function resizeTo(w, h) {
  W = w; H = h;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  emit('resize', {});
  try { if (WIN.G && WIN.G.renderer && WIN.G.renderer.onResize) WIN.G.renderer.onResize(); } catch (e) {}
}
if (!DEV && wx.onWindowResize) {
  wx.onWindowResize(function (res) {
    var s = res && res.size ? res.size : res;
    if (s && s.windowWidth && s.windowHeight) resizeTo(s.windowWidth, s.windowHeight);
  });
}

WIN.__fatal = function (msg) {
  try { wx.showToast({ title: msg || '启动失败', icon: 'none' }); } catch (e) {}
};

/* ---------- 8. 运行诊断（真机排查用） ---------- */
WIN.__diag = { modelErr: '', log: '', jsErr: '', gl: '' };
// 小游戏默认走兼容渲染：关闭阴影与环境贴图烘焙，先保证场景可见
WIN.__SAFE_RENDER = !DEV;
// 部分移动 GPU 上 Standard/Physical 着色器会编译失败（真机日志已确认），默认降级为 Lambert
WIN.__FLAT_MAT = !DEV;
// 真机 WebGL1 上 InstancedMesh 有概率整批不绘制（树/石头/路桩全消失），
// 默认改走“实例烘焙成普通网格”的兼容路径；浏览器联调仍用实例化保持原画质
WIN.__noInst = !DEV || !!WIN.__FORCE_NO_INST;
// 真机开启实时阴影，但阴影图固定 1024（画质档里的 2048/4096 对手机太重）
WIN.__SHADOW_SIZE = !DEV ? 1024 : 0;
if (!DEV) {
  var _origConsoleError = console.error;
  console.error = function () {
    try {
      var s = '';
      for (var i = 0; i < arguments.length; i++) s += (i ? ' ' : '') + String(arguments[i]);
      if (/Shader Error|not compiled/i.test(s)) {
        WIN.__shaderFail = true;            // 供渲染层做材质强制降级兜底
        var es = s.match(/ERROR:\s*\d+:\d+:[^\n]*/g);
        var ws = s.match(/WARNING:\s*\d+:\d+:[^\n]*/g);
        WIN.__diag.log = ((es ? es.slice(0, 2).join(' | ') : '') + (ws ? ' || ' + ws[0] : '') || s.slice(0, 180)).slice(0, 190);
      } else {
        WIN.__diag.log = s.slice(0, 160);
      }
    } catch (e) {}
    try { _origConsoleError.apply(console, arguments); } catch (e) {}
  };
  if (wx.onError) {
    wx.onError(function (e) {
      WIN.__diag.jsErr = String(e && (e.message || e)).slice(0, 140);
    });
  }
}

// 浏览器联调用的 wx API 桩（仅在 dev-test 页面使用，不参与小游戏打包）
// ?mini=1 时关闭浏览器原生分支，完整走小游戏适配层（document/window/Blob/URL 桩）
var _MINI = /[?&]mini=1/.test(location.search);
window.__DEV_TEST__ = !_MINI;

// ?webgl=1 强制 WebGL1（模拟部分真机只有 WebGL1 的情况）
if (/[?&]webgl=1/.test(location.search)) {
  var _origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    if (type === 'webgl2') return null;
    return _origGetContext.apply(this, arguments);
  };
}

// ?nowasm=1 模拟真机没有 WebAssembly 的环境
if (/[?&]nowasm=1/.test(location.search)) {
  try { window.WebAssembly = undefined; } catch (e) {}
}

var NativeURL = window.URL;
var NativeBlob = window.Blob;
var _nativeCreateElement = Document.prototype.createElement;
var _nativeBody = document.body;
var _mainCanvasEl = document.getElementById('view');
var _nativeLS = window.localStorage;
var _fileMap = {};

window.GameGlobal = window;

var _touch = { start: [], move: [], end: [], cancel: [] };
var _mainCanvasGiven = false;

function _dispatch(type, e) {
  var cv = _mainCanvasEl;
  var r = cv.getBoundingClientRect();
  var x = e.clientX - r.left, y = e.clientY - r.top;
  var t = { identifier: e.pointerId || 0, clientX: x, clientY: y };
  var ev = {
    touches: (type === 'end' || type === 'cancel') ? [] : [t],
    changedTouches: [t]
  };
  (_touch[type] || []).forEach(function (fn) { fn(ev); });
}

window.wx = {
  getSystemInfoSync: function () {
    return { windowWidth: window.innerWidth, windowHeight: window.innerHeight, pixelRatio: window.devicePixelRatio || 1, platform: 'devtools' };
  },
  createCanvas: function () {
    if (!_mainCanvasGiven) { _mainCanvasGiven = true; return _mainCanvasEl; }
    return _nativeCreateElement.call(document, 'canvas');
  },
  createImage: function () {
    if (!_MINI) return new Image();
    var img = new Image();
    var real = '';
    var setter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
    Object.defineProperty(img, 'src', {
      configurable: true,
      get: function () { return real; },
      set: function (v) { real = v; setter.call(img, _fileMap[v] || v); }
    });
    return img;
  },
  getStorageSync: function (k) { var v = _nativeLS.getItem(k); return v == null ? '' : v; },
  setStorageSync: function (k, v) { _nativeLS.setItem(k, v); },
  removeStorageSync: function (k) { _nativeLS.removeItem(k); },
  getFileSystemManager: function () {
    return {
      readFileSync: function (p, enc) {
        // 文本配置（config/*.json）：开发环境用同步 XHR 读取
        if (/\.json$/i.test(p) && enc) {
          try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '../' + p, false);
            xhr.send(null);
            if (xhr.status === 200 || xhr.status === 0) return xhr.responseText;
          } catch (e) {}
          throw new Error('json not ready: ' + p);
        }
        var key = /will_GT/i.test(p) ? 'res2' : 'res';
        if (!window.__GLB__ || !window.__GLB__[key]) throw new Error('glb not ready: ' + p);
        return window.__GLB__[key];
      },
      writeFileSync: function (p, buf) {
        if (_MINI) _fileMap[p] = NativeURL.createObjectURL(new NativeBlob([buf]));
      },
      unlinkSync: function (p) { if (_fileMap[p]) { NativeURL.revokeObjectURL(_fileMap[p]); delete _fileMap[p]; } }
    };
  },
  loadSubpackage: function (opt) {
    var url = (opt && opt.name) === 'res2' ? '../res2/will_GT_mini.glb' : '../res/su7_mini.glb';
    var key = (opt && opt.name) === 'res2' ? 'res2' : 'res';
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) {
      window.__GLB__ = window.__GLB__ || {};
      window.__GLB__[key] = b;
      opt.success && opt.success();
    }).catch(function (e) {
      console.error('[dev-test] 分包加载失败', e);
      opt.fail && opt.fail(e);
    });
  },
  env: { USER_DATA_PATH: _MINI ? 'wxfile://usr' : '/tmp' },
  onTouchStart: function (fn) { _touch.start.push(fn); },
  onTouchMove: function (fn) { _touch.move.push(fn); },
  onTouchEnd: function (fn) { _touch.end.push(fn); },
  onTouchCancel: function (fn) { _touch.cancel.push(fn); },
  onWindowResize: function () {},
  onHide: function () {},
  showToast: function (o) { console.log('[dev-test][toast]', o && o.title); },
  showKeyboard: function (o) {
    if (window.__kbEl) { try { window.__kbEl.remove(); } catch (e) {} }
    var inp = _nativeCreateElement.call(document, 'input');
    inp.type = 'text';
    inp.maxLength = (o && o.maxLength) || 12;
    inp.value = (o && o.defaultValue) || '';
    inp.setAttribute('style',
      'position:fixed;left:50%;top:36%;transform:translateX(-50%);width:64%;max-width:520px;' +
      'padding:14px 18px;font:700 22px monospace;color:#e6f0f4;background:rgba(5,14,22,.97);' +
      'border:2px solid #2de2ff;border-radius:12px;outline:none;z-index:9999;text-align:center;' +
      'box-shadow:0 0 24px rgba(45,226,255,.55);');
    _nativeBody.appendChild(inp);
    window.__kbEl = inp;
    window.__kbOpen = true;
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
    inp.addEventListener('input', function () { window.__simKeyboard(inp.value, false); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.__simKeyboard(inp.value, true);
        try { inp.remove(); } catch (x) {}
        window.__kbEl = null;
        window.__kbOpen = false;
      }
    });
  },
  hideKeyboard: function () {
    window.__kbOpen = false;
    if (window.__kbEl) { try { window.__kbEl.remove(); } catch (e) {} window.__kbEl = null; }
  },
  onKeyboardInput: function (fn) { _kb.input.push(fn); },
  onKeyboardConfirm: function (fn) { _kb.confirm.push(fn); },
  onKeyboardComplete: function (fn) { _kb.complete.push(fn); }
};

// 浏览器里模拟微信键盘输入：__simKeyboard('车手名') / __simKeyboard('车手名', true)
var _kb = { input: [], confirm: [], complete: [] };
window.__simKeyboard = function (value, confirm) {
  var e = { value: String(value == null ? '' : value) };
  _kb.input.forEach(function (fn) { fn(e); });
  if (confirm) {
    _kb.confirm.forEach(function (fn) { fn(e); });
    _kb.complete.forEach(function (fn) { fn(e); });
    window.__kbOpen = false;
  }
};

window.addEventListener('pointerdown', function (e) { _dispatch('start', e); });
window.addEventListener('pointermove', function (e) { if (e.buttons) _dispatch('move', e); });
window.addEventListener('pointerup', function (e) { _dispatch('end', e); });
window.addEventListener('pointercancel', function (e) { _dispatch('cancel', e); });

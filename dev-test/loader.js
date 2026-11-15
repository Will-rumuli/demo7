// 极简 CommonJS 加载器：在浏览器里按小游戏的模块方式执行 demo 代码
(function () {
  var FILES = [
    'game.js',
    'js/adapter.js',
    'libs/three.min.js',
    'libs/meshopt.js',
    'libs/GLTFLoader.js',
    'libs/postprocessing.js',
    'game/core.js',
    'game/world.js',
    'game/mountain.js',
    'game/dust.js',
    'js/ui.js',
    'game/play.js'
  ];
  var cache = {};
  var texts = {};
  var ROOT = '../';

  function normalize(p) {
    var parts = p.split('/'), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === '.') continue;
      if (parts[i] === '..') out.pop(); else out.push(parts[i]);
    }
    return out.join('/');
  }
  function dirname(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function join(dir, p) { return normalize((dir ? dir + '/' : '') + p); }

  function req(dir, p) {
    var full = join(dir, p);
    if (cache[full]) return cache[full].exports;
    var src = texts[full];
    if (src == null) throw new Error('模块不存在: ' + full);
    var module = { exports: {} };
    cache[full] = module;
    var fn = new Function('GameGlobal', 'wx', 'module', 'exports', 'require',
      src + '\n//# sourceURL=' + full);
    fn(window, window.wx, module, module.exports, function (q) { return req(dirname(full), q); });
    return module.exports;
  }

  function fail(e) {
    window.__BOOT_ERR__ = e && (e.stack || e.message) || String(e);
    console.error(e);
    var el = window.__ERR_EL__ || document.getElementById('err');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = '启动失败：\n' + window.__BOOT_ERR__;
  }

  Promise.all(FILES.map(function (f) {
    return fetch(ROOT + f).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + f);
      return r.text().then(function (t) { texts[f] = t; });
    });
  })).then(function () {
    req('', 'game.js');
    window.__BOOT_OK__ = true;
  }).catch(fail);
})();

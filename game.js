// 巴音布鲁克的干 · Will GP —— 微信小游戏入口
require('./js/adapter.js');

var THREE = require('./libs/three.min.js');
GameGlobal.THREE = THREE;

var MeshoptDecoder = require('./libs/meshopt.js');
GameGlobal.MeshoptDecoder = MeshoptDecoder;

require('./libs/GLTFLoader.js');
require('./libs/postprocessing.js');

require('./game/core.js');
require('./game/world.js');
require('./game/mountain.js');
require('./game/dust.js');
require('./js/ui.js');
require('./game/play.js');

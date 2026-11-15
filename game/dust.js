G.puffTex = function () {
  if (G._puff) return G._puff;
  var S = 128, A = 256, data = new Uint8Array(A * A * 4), hgt = new Float32Array(S * S), v, x, y;
  for (v = 0; v < 4; v++) {
    var ox = (v & 1) * S, oy = (v >> 1) * S, sd = v * 17.3;
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
      var u = x / S * 2 - 1, w = y / S * 2 - 1;
      var wu = u + 0.35 * (G.fbm(u * 1.7 + sd, w * 1.7, 3) - 0.5), ww = w + 0.35 * (G.fbm(u * 1.7, w * 1.7 - sd, 3) - 0.5), r = Math.sqrt(wu * wu + ww * ww);
      var n = G.fbm(u * 2.6 + sd, w * 2.6 - sd, 5), n2 = G.fbm(u * 7.3 - sd, w * 7.3 + sd, 4), lobes = 0;
      for (var lb = 0; lb < 5; lb++) { var la = lb * 1.26 + sd, lx = Math.cos(la) * 0.42, ly = Math.sin(la) * 0.38; lobes = Math.max(lobes, 1 - Math.hypot(u - lx, w - ly) / (0.42 + 0.12 * Math.sin(sd + lb))); }
      var body = Math.max(1 - r * 1.25, lobes * 0.85);
      hgt[y * S + x] = Math.max(0, body * (0.4 + 0.8 * n) + 0.18 * (n2 - 0.5)) * G.SS(1.0, 0.75, r);
    }
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
      var h = hgt[y * S + x], hx = hgt[y * S + Math.min(S - 1, x + 1)] - hgt[y * S + Math.max(0, x - 1)], hy = hgt[Math.min(S - 1, y + 1) * S + x] - hgt[Math.max(0, y - 1) * S + x];
      var nx = -hx * 3.5, ny = -hy * 3.5, il = 1 / Math.sqrt(nx * nx + ny * ny + 1), j = ((oy + y) * A + ox + x) * 4;
      data[j] = (nx * il * 0.5 + 0.5) * 255; data[j + 1] = (ny * il * 0.5 + 0.5) * 255;
      data[j + 2] = Math.min(1, h * 1.2) * 255; data[j + 3] = G.SS(0.03, 0.55, h) * 255;
    }
  }
  var t = new THREE.DataTexture(data, A, A, THREE.RGBAFormat); t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  return (G._puff = t);
};
G.Dust = function (scene, cap) {
  cap = this.cap = cap || 700;
  this.list = []; this.acc = [0, 0, 0, 0]; this._v = new THREE.Vector3();
  var g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  var mk = function (n) { var a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  this.aPos = mk(4); this.aMisc = mk(4); this.aCol = mk(4);
  g.setAttribute('aPos', this.aPos); g.setAttribute('aMisc', this.aMisc); g.setAttribute('aCol', this.aCol);
  g.instanceCount = 0; this.geo = g;
  var S = G.SUN_DIR;
  this.mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: G.puffTex() }, uSunDir: { value: S.clone() }, uSun: { value: new THREE.Vector3(3.3, 2.7, 2.0) },
      uAmbLo: { value: new THREE.Vector3(0.42, 0.36, 0.3) }, uAmbHi: { value: new THREE.Vector3(0.85, 0.92, 1.05) } },
    vertexShader: [
      'attribute vec4 aPos; attribute vec4 aMisc; attribute vec4 aCol;',
      'varying vec2 vUv; varying vec4 vCol; varying vec2 vOff; varying vec3 vToCam, vT, vB; varying float vAge, vDist, vGh, vSoft;',
      'void main(){',
      '  float c = cos(aMisc.x), s = sin(aMisc.x); vec2 rc = vec2(position.x * c - position.y * s, position.x * s + position.y * c);',
      '  vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0); mv.xy += rc * aPos.w;',
      '  gl_Position = projectionMatrix * mv;',
      '  vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);',
      '  vT = R * c + U * s; vB = U * c - R * s;',
      '  vGh = aPos.y + dot(R * rc.x + U * rc.y, vec3(0.0, 1.0, 0.0)) * aPos.w - aMisc.z; vSoft = 0.25 + aPos.w * 0.18;',
      '  float v = floor(aMisc.w + 0.5); vUv = (vec2(mod(v, 2.0), floor(v / 2.0)) + position.xy + 0.5) * 0.5;',
      '  vOff = position.xy; vCol = aCol; vAge = aMisc.y; vToCam = cameraPosition - aPos.xyz; vDist = -mv.z;',
      '}'].join('\n'),
    fragmentShader: [
      'uniform sampler2D uTex; uniform vec3 uSunDir, uSun, uAmbLo, uAmbHi;',
      'varying vec2 vUv; varying vec4 vCol; varying vec2 vOff; varying vec3 vToCam, vT, vB; varying float vAge, vDist, vGh, vSoft;',
      'void main(){',
      '  vec4 t = texture2D(uTex, vUv);',
      '  float er = vAge * 0.5;',
      '  float a = smoothstep(er, er + 0.55, t.a) * vCol.a * smoothstep(2.5, 10.0, vDist) * smoothstep(0.0, vSoft, vGh);',
      '  if (a < 0.003) discard;',
      '  vec3 V = normalize(vToCam); vec2 q = vOff * 2.0; float r2 = min(dot(q, q), 1.0);',
      '  vec3 Ns = vT * q.x + vB * q.y + V * (sqrt(1.0 - r2) * 0.9 + 0.05);',
      '  vec2 tn = t.rg * 2.0 - 1.0; vec3 Nb = vT * tn.x + vB * tn.y + V * sqrt(max(1.0 - dot(tn, tn), 0.0));',
      '  vec3 N = normalize(Ns * 0.55 + Nb);',
      '  float wrap = clamp((dot(N, uSunDir) + 0.45) / 1.45, 0.0, 1.0);',
      '  float back = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 5.0);',
      '  float thin = 1.0 - 0.7 * t.b * smoothstep(0.0, 0.5, a);',
      '  vec3 col = vCol.rgb * (mix(uAmbLo, uAmbHi, N.y * 0.5 + 0.5) * (1.0 - 0.25 * t.b) + uSun * (wrap * wrap * 0.85 + 0.12 + back * (0.6 + 1.6 * thin)));',
      '  gl_FragColor = vec4(col * a, a);',
      '}'].join('\n'),
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor
  });
  this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
  scene.add(this.mesh);
};
G.Dust.prototype = {
  clear: function () { this.list.length = 0; this.geo.instanceCount = 0; },
  // kind: 0 尘土 1 水花；col 为反照率（线性）
  emitFrom: function (dt, pts, veh, rate, col, op, water) {
    var vx = Math.sin(veh.heading) * veh.vLong + Math.cos(veh.heading) * veh.vLat, vz = Math.cos(veh.heading) * veh.vLong - Math.sin(veh.heading) * veh.vLat;
    var gy = veh.gy != null ? veh.gy : veh.pos.y, c = new THREE.Color(col), spd = Math.hypot(vx, vz);
    for (var i = 0; i < pts.length; i++) {
      if (!water && pts[i].front) continue;
      this.acc[i] += dt * rate;
      while (this.acc[i] >= 1 && this.list.length < this.cap) {
        this.acc[i] -= 1;
        var R = Math.random, s0 = water ? 0.35 + R() * 0.45 : 1.8 + R() * 1.4;
        this.list.push({ x: pts[i].x + (R() - 0.5) * 0.6, y: gy + s0 * 0.3, z: pts[i].z + (R() - 0.5) * 0.6,
          vx: vx * (water ? 0.15 : 0.3) + (R() - 0.5) * (2.5 + spd * 0.12), vz: vz * (water ? 0.15 : 0.3) + (R() - 0.5) * (2.5 + spd * 0.12),
          vy: water ? 2.5 + R() * 3 : 0.25 + R() * 0.6 + spd * 0.012, life: 0, max: water ? 0.7 + R() * 0.5 : 2.2 + R() * 2.2,
          s0: s0, s1: water ? 0.8 + R() * 0.6 : 5.5 + R() * 4 + spd * 0.08, rot: R() * 6.28, spin: (R() - 0.5) * 0.6, v: (R() * 4) | 0,
          r: c.r * (0.9 + R() * 0.2), g: c.g * (0.9 + R() * 0.2), b: c.b * (0.9 + R() * 0.2), a: op, water: !!water, gy: gy, ph: R() * 6.28 });
      }
      if (this.acc[i] > 1) this.acc[i] = 0;
    }
  },
  tick: function (dt, cam) {
    var L = this.list, i, n = 0;
    for (i = 0; i < L.length; i++) {
      var p = L[i]; p.life += dt; if (p.life >= p.max) continue;
      var dr = Math.exp(-(p.water ? 1.0 : 1.4) * dt);
      p.vx *= dr; p.vz *= dr; p.vy = p.water ? p.vy - 9.0 * dt : p.vy * Math.exp(-0.9 * dt) + 0.12 * dt;
      if (!p.water) { var tq = p.life * 1.3 + p.ph; p.vx += Math.sin(tq) * 0.9 * dt; p.vz += Math.cos(tq * 0.8) * 0.9 * dt; }   // 湍流翅动
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.spin * dt;
      L[n++] = p;
    }
    L.length = n;
    if (cam) { var cx = cam.position.x, cy = cam.position.y, cz = cam.position.z; L.sort(function (a, b) { return ((b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) + (b.z - cz) * (b.z - cz)) - ((a.x - cx) * (a.x - cx) + (a.y - cy) * (a.y - cy) + (a.z - cz) * (a.z - cz)); }); }
    var P = this.aPos.array, M = this.aMisc.array, C = this.aCol.array;
    for (i = 0; i < n; i++) {
      var q = L[i], t = q.life / q.max, o = i * 4, sz = q.s0 + (q.s1 - q.s0) * (1 - Math.pow(1 - t, 2.2));
      P[o] = q.x; P[o + 1] = q.y; P[o + 2] = q.z; P[o + 3] = sz;
      M[o] = q.rot; M[o + 1] = t; M[o + 2] = q.gy; M[o + 3] = q.v;
      C[o] = q.r; C[o + 1] = q.g; C[o + 2] = q.b; C[o + 3] = q.a * Math.min(1, q.life * 6) * (q.water ? 1 - t : Math.pow(1 - t, 0.7));
    }
    this.geo.instanceCount = n;
    this.aPos.needsUpdate = this.aMisc.needsUpdate = this.aCol.needsUpdate = true;
  }
};
// 飞溅碎石 / 泥块：从后轮向后上方抛出，受重力弹跳后静止消失

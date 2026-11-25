(() => {
  'use strict';
  const models = window.PartAgentGalleryModels;
  const panel = document.querySelector('[data-model-viewer]');
  if (!panel || !Array.isArray(models) || !models.length) return;
  const canvas = panel.querySelector('#model-canvas');
  const poster = panel.querySelector('#model-poster');
  const heading = panel.querySelector('#model-name');
  const picker = panel.querySelector('[data-model-picker]');
  const actions = panel.querySelector('[data-viewer-actions]');
  const controlsHint = panel.querySelector('#model-instructions');
  const spin = panel.querySelector('[data-viewer-spin]');
  const spinText = spin.querySelector('[data-spin-text]');
  const reset = panel.querySelector('[data-viewer-reset]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const radians = Math.PI / 180;
  const radiansPerSecond = 16 * radians;
  const idleDelay = 2800;
  const pointers = new Map();
  const scripts = new Map();
  const asset = (name) => name.startsWith('assets/') ? name : 'assets/' + name;
  let selected;
  let mesh;
  let renderer;
  let automatic = !motion.matches;
  let inView = !('IntersectionObserver' in window);
  let resumeAt = 0;
  let previousTime = null;
  let frame = 0;
  let idleTimer = 0;
  let azimuth = 0;
  let elevation = 0;
  let modelRevision = 0;

  function decode(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function getColors(labels, palette) {
    const parts = Object.fromEntries(Object.entries(palette).map(([id, hex]) => [
      id, hex.slice(1).match(/../g).map((channel) => parseInt(channel, 16))
    ]));
    const colors = new Uint8Array(labels.length * 9);
    for (let i = 0; i < labels.length; i++) {
      const rgb = parts[labels[i]];
      colors.set(rgb, i * 9);
      colors.set(rgb, i * 9 + 3);
      colors.set(rgb, i * 9 + 6);
    }
    return colors;
  }

  function createProgram(gl) {
    const vertex = `
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec3 aColor;
      uniform vec3 uRight;
      uniform vec3 uUp;
      uniform vec3 uView;
      uniform vec3 uCenter;
      uniform vec3 uScale;
      varying vec3 vColor;
      varying vec3 vNormal;
      void main() {
        vec3 point = aPosition - uCenter;
        gl_Position = vec4(
          dot(point, uRight) * uScale.x,
          dot(point, uUp) * uScale.y,
          -dot(point, uView) * uScale.z, 1.0
        );
        vNormal = vec3(dot(aNormal, uRight), dot(aNormal, uUp), dot(aNormal, uView));
        vColor = aColor;
      }
    `;
    const fragment = `
      precision mediump float;
      varying vec3 vColor;
      varying vec3 vNormal;
      void main() {
        vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        float key = max(0.0, dot(normal, normalize(vec3(-0.48, 0.68, 0.58))));
        float fill = max(0.0, dot(normal, normalize(vec3(0.65, 0.16, 0.63))));
        float highlight = pow(max(0.0, dot(normal, normalize(vec3(-0.23, 0.34, 0.90)))), 20.0);
        vec3 color = vColor * (0.52 + 0.41 * key + 0.18 * fill) + vec3(0.05 * highlight);
        gl_FragColor = vec4(color, 1.0);
      }
    `;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader unavailable');
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Viewer unavailable');
    return program;
  }

  function createRenderer() {
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' });
    if (!gl || gl.isContextLost()) return null;
    const program = createProgram(gl);
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    const attributes = [['aPosition', gl.FLOAT, false], ['aNormal', gl.BYTE, true], ['aColor', gl.UNSIGNED_BYTE, true]];
    const buffers = attributes.map(([name, type, normalized]) => {
      const buffer = gl.createBuffer();
      const location = gl.getAttribLocation(program, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 3, type, normalized, 0, 0);
      return buffer;
    });
    const uniforms = Object.fromEntries(['Right', 'Up', 'View', 'Center', 'Scale'].map(
      (name) => [name, gl.getUniformLocation(program, 'u' + name)]
    ));
    return { gl, buffers, uniforms };
  }

  function loadSource(model) {
    if (window.PartAgentModels?.[model.id]) return Promise.resolve(window.PartAgentModels[model.id]);
    if (scripts.has(model.id)) return scripts.get(model.id);
    const promise = new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = asset(model.data);
      node.onload = () => {
        const data = window.PartAgentModels?.[model.id];
        if (data) resolve(data);
        else reject(new Error('The object is unavailable.'));
      };
      node.onerror = () => reject(new Error('The object is unavailable.'));
      document.head.append(node);
    }).catch((error) => {
      scripts.delete(model.id);
      throw error;
    });
    scripts.set(model.id, promise);
    return promise;
  }

  function upload(data) {
    const position = new Float32Array(decode(data.positions));
    const normals = new Int8Array(decode(data.normals));
    const faceLabels = new Uint8Array(decode(data.labels[0]));
    if (!position.length || normals.length !== position.length || faceLabels.length * 9 !== position.length) {
      throw new Error('The object has incomplete geometry.');
    }
    const colors = getColors(faceLabels, data.palettes[0]);
    const { gl, buffers, uniforms } = renderer;
    [position, normals, colors].forEach((values, i) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i]);
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    });
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis], position[i + axis]);
        high[axis] = Math.max(high[axis], position[i + axis]);
      }
    }
    const center = low.map((min, axis) => (min + high[axis]) / 2);
    let radiusXYSquared = 0;
    let radiusSquared = 0;
    for (let i = 0; i < position.length; i += 3) {
      const dx = position[i] - center[0];
      const dy = position[i + 1] - center[1];
      const dz = position[i + 2] - center[2];
      const horizontalSquared = dx * dx + dy * dy;
      radiusXYSquared = Math.max(radiusXYSquared, horizontalSquared);
      radiusSquared = Math.max(radiusSquared, horizontalSquared + dz * dz);
    }
    gl.uniform3fv(uniforms.Center, center);
    return {
      count: position.length / 3,
      radiusXY: Math.sqrt(radiusXYSquared),
      radius: Math.max(.0001, Math.sqrt(radiusSquared))
    };
  }

  function draw() {
    if (!renderer || !mesh || canvas.hidden) return;
    const { gl, uniforms } = renderer;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const sa = Math.sin(azimuth), ca = Math.cos(azimuth);
    const se = Math.sin(elevation), ce = Math.cos(elevation);
    gl.uniform3f(uniforms.Right, ca, sa, 0);
    gl.uniform3f(uniforms.Up, -se * sa, se * ca, ce);
    gl.uniform3f(uniforms.View, sa * ce, -ca * ce, se);
    const aspect = width / height;
    // Use the same framing at every angle, including views from below.
    const fit = .87 / Math.max(mesh.radius, mesh.radiusXY / aspect);
    gl.uniform3f(uniforms.Scale, fit / aspect, fit, .95 / mesh.radius);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  function schedule() {
    if (frame || !mesh || !renderer || document.hidden || !inView) return;
    frame = requestAnimationFrame(animate);
  }

  function animate(time) {
    frame = 0;
    if (!mesh || !renderer || document.hidden || !inView) { previousTime = null; return; }
    const advancing = automatic && !pointers.size && time >= resumeAt;
    if (advancing && previousTime !== null) azimuth += (time - previousTime) * .001 * radiansPerSecond;
    previousTime = advancing ? time : null;
    draw();
    if (advancing) schedule();
  }

  function yieldToInput() {
    previousTime = null;
    resumeAt = performance.now() + idleDelay;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(schedule, idleDelay + 30);
    schedule();
  }

  function setMode(mode) {
    panel.dataset.viewerMode = mode;
    const interactive = mode === 'webgl';
    canvas.hidden = !interactive;
    poster.hidden = interactive;
    actions.hidden = !interactive;
    controlsHint.hidden = !interactive;
  }

  function updateSpin() {
    spin.setAttribute('aria-pressed', String(automatic));
    spinText.textContent = automatic ? 'Pause rotation' : 'Start rotation';
    previousTime = null;
    schedule();
  }

  function resetView() {
    azimuth = selected.azimuth * radians;
    elevation = selected.elevation * radians;
  }

  async function select(model) {
    selected = model;
    const revision = ++modelRevision;
    mesh = null;
    previousTime = null;
    pointers.clear();
    resumeAt = 0;
    clearTimeout(idleTimer);
    panel.dataset.modelId = model.id;
    heading.textContent = model.name;
    canvas.setAttribute('aria-label', 'Interactive final part segmentation of ' + model.name);
    poster.src = asset(model.thumbnail);
    poster.alt = 'Final part segmentation of ' + model.name;
    for (const button of picker.children) button.setAttribute('aria-pressed', String(button.dataset.modelId === model.id));
    setMode('poster');
    resetView();
    if (!renderer) return;
    try {
      const data = await loadSource(model);
      if (revision !== modelRevision || !renderer) return;
      mesh = upload(data);
      setMode('webgl');
      draw();
      schedule();
    } catch {
      if (revision === modelRevision) setMode('poster');
    }
  }

  for (const [i, model] of models.entries()) {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'model-choice';
    choice.dataset.modelId = model.id;
    choice.setAttribute('aria-controls', 'model-name model-canvas model-poster');
    choice.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.alt = '';
    image.src = asset(model.thumbnail);
    const label = document.createElement('span');
    label.textContent = model.name;
    choice.append(image, label);
    choice.addEventListener('click', () => select(model));
    choice.addEventListener('keydown', (event) => {
      const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (!direction) return;
      event.preventDefault();
      const next = (i + direction + models.length) % models.length;
      picker.children[next].focus();
      select(models[next]);
    });
    picker.append(choice);
  }
  picker.hidden = false;

  function rotate(dx, dy) {
    azimuth += dx * .009;
    elevation = Math.max(-1.48, Math.min(1.48, elevation + dy * .009));
    yieldToInput();
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointers.size >= 2) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.focus({ preventScroll: true });
    yieldToInput();
  });
  canvas.addEventListener('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) rotate(event.clientX - previous.x, previous.y - event.clientY);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(type, (event) => {
      if (pointers.delete(event.pointerId)) yieldToInput();
    });
  }
  canvas.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowLeft': rotate(-10, 0); break;
      case 'ArrowRight': rotate(10, 0); break;
      case 'ArrowUp': rotate(0, 10); break;
      case 'ArrowDown': rotate(0, -10); break;
      case '0': case 'Home': resetView(); yieldToInput(); break;
      default: return;
    }
    event.preventDefault();
  });
  spin.addEventListener('click', () => {
    automatic = !automatic;
    resumeAt = 0;
    updateSpin();
  });
  reset.addEventListener('click', () => { resetView(); yieldToInput(); });
  const onMotionChange = () => { automatic = !motion.matches; updateSpin(); };
  if (motion.addEventListener) motion.addEventListener('change', onMotionChange);
  else motion.addListener(onMotionChange);

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    modelRevision++;
    pointers.clear();
    mesh = null;
    renderer = null;
    previousTime = null;
    setMode('poster');
  });
  function startRenderer() {
    try { renderer = createRenderer(); } catch { renderer = null; }
    select(selected || models[0]);
  }
  canvas.addEventListener('webglcontextrestored', startRenderer);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      previousTime = null;
      schedule();
    }).observe(panel.querySelector('.model-stage'));
  }
  document.addEventListener('visibilitychange', () => { previousTime = null; schedule(); });
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(canvas);
  else window.addEventListener('resize', schedule);
  updateSpin();
  startRenderer();
})();

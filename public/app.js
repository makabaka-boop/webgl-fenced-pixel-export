'use strict';

(() => {
  const MAX_SIZE = 64;
  const MAX_INFLIGHT = 2;
  const PIXEL_BYTES = 4;
  const MANUAL_POLL = new URLSearchParams(window.location.search).has('manualPoll');

  const $ = (id) => document.getElementById(id);

  function clampByte(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(255, Math.round(number)));
  }

  function makeInitialPixels(width, height) {
    const pixels = new Uint8Array(width * height * PIXEL_BYTES);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * PIXEL_BYTES;
        pixels[offset] = clampByte(24 + x * (210 / Math.max(1, width - 1)));
        pixels[offset + 1] = clampByte(48 + y * (190 / Math.max(1, height - 1)));
        pixels[offset + 2] = clampByte(210 - ((x + y) * 135) / Math.max(1, width + height - 2));
        pixels[offset + 3] = 255;
      }
    }

    if (width > 1 && height > 1) {
      const corners = [
        [0, 0, 237, 37, 58],
        [width - 1, 0, 46, 204, 113],
        [0, height - 1, 54, 115, 255],
        [width - 1, height - 1, 245, 245, 245],
      ];
      for (const [x, y, r, g, b] of corners) {
        const offset = (y * width + x) * PIXEL_BYTES;
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
        pixels[offset + 3] = 255;
      }
    }
    return pixels;
  }

  class PixelDocument {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.revision = 1;
      this.pixels = makeInitialPixels(width, height);
    }

    index(x, y) {
      return (y * this.width + x) * PIXEL_BYTES;
    }

    setPixel(x, y, rgba) {
      const ix = Math.trunc(x);
      const iy = Math.trunc(y);
      if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return false;
      const offset = this.index(ix, iy);
      const next = rgba.map(clampByte);
      this.pixels.set(next, offset);
      this.revision += 1;
      return true;
    }

    fill(rgba) {
      const color = rgba.map(clampByte);
      for (let offset = 0; offset < this.pixels.length; offset += PIXEL_BYTES) {
        this.pixels.set(color, offset);
      }
      this.revision += 1;
    }

    clear() {
      this.pixels.fill(0);
      this.revision += 1;
    }

    resize(width, height) {
      if (width === this.width && height === this.height) return false;
      const next = new Uint8Array(width * height * PIXEL_BYTES);
      const commonWidth = Math.min(width, this.width);
      const commonHeight = Math.min(height, this.height);

      for (let y = 0; y < commonHeight; y += 1) {
        const sourceStart = y * this.width * PIXEL_BYTES;
        const targetStart = y * width * PIXEL_BYTES;
        next.set(
          this.pixels.subarray(sourceStart, sourceStart + commonWidth * PIXEL_BYTES),
          targetStart,
        );
      }

      this.width = width;
      this.height = height;
      this.pixels = next;
      this.revision += 1;
      return true;
    }

    snapshot() {
      return {
        revision: this.revision,
        width: this.width,
        height: this.height,
        pixels: new Uint8Array(this.pixels),
      };
    }
  }

  const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

  const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform highp usampler2D u_pixels;
uniform ivec2 u_size;
out vec4 out_color;
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  uvec4 rgba = texelFetch(u_pixels, cell, 0);
  out_color = vec4(rgba) / 255.0;
}`;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = null;
      this.program = null;
      this.vao = null;
      this.vertexBuffer = null;
      this.texture = null;
      this.uniformSize = null;
      this.initContext();
    }

    initContext() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'default',
      });
      if (!gl) throw new Error('当前浏览器不支持 WebGL2。');
      this.gl = gl;
      this.createPersistentResources();
    }

    createShader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || '着色器编译失败';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    }

    createPersistentResources() {
      const gl = this.gl;
      const vertex = this.createShader(gl.VERTEX_SHADER, VERTEX_SHADER);
      const fragment = this.createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || '着色器链接失败';
        gl.deleteProgram(program);
        throw new Error(message);
      }
      this.program = program;
      this.uniformSize = gl.getUniformLocation(program, 'u_size');

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      this.vao = vao;
      this.vertexBuffer = vertexBuffer;
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    drawDocument(doc) {
      const gl = this.gl;
      if (gl.isContextLost()) return;

      this.canvas.width = doc.width;
      this.canvas.height = doc.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, doc.width, doc.height);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8UI,
        doc.width,
        doc.height,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        doc.pixels,
      );
      gl.uniform2i(this.uniformSize, doc.width, doc.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindVertexArray(null);
    }

    beginReadback(snapshot) {
      const gl = this.gl;
      const { width, height, pixels } = snapshot;
      const byteLength = width * height * PIXEL_BYTES;
      const job = {
        width,
        height,
        byteLength,
        pbo: null,
        sourceTexture: null,
        destinationTexture: null,
        framebuffer: null,
        sync: null,
        live: true,
      };

      try {
        if (gl.isContextLost()) throw new Error('WebGL 上下文已丢失，无法开始读回。');

        job.pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        job.sourceTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, job.sourceTexture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, width, height);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          width,
          height,
          gl.RGBA_INTEGER,
          gl.UNSIGNED_BYTE,
          pixels,
        );

        job.destinationTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, job.destinationTexture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);

        job.framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, job.framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          job.destinationTexture,
          0,
        );
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('离屏帧缓冲不完整。');
        }

        gl.viewport(0, 0, width, height);
        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, job.sourceTexture);
        gl.uniform2i(this.uniformSize, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pbo);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        job.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);

        if (!job.sync || gl.isContextLost()) {
          throw new Error('无法创建 GPU fenceSync。');
        }
        return job;
      } catch (error) {
        this.deleteReadback(job);
        throw error;
      }
    }

    pollReadback(job) {
      const gl = this.gl;
      if (!job.live) return { status: 'failed', error: new Error('读回任务已取消。') };
      if (gl.isContextLost()) return { status: 'failed', error: new Error('WebGL 上下文丢失。') };
      if (!job.sync) return { status: 'failed', error: new Error('缺少 fenceSync。') };

      const waitResult = gl.clientWaitSync(job.sync, 0, 0);
      if (
        waitResult === gl.TIMEOUT_EXPIRED ||
        waitResult === gl.WAIT_FAILED
      ) {
        if (waitResult === gl.WAIT_FAILED || gl.isContextLost()) {
          return { status: 'failed', error: new Error('fenceSync 等待失败。') };
        }
        return { status: 'waiting' };
      }

      try {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, job.pbo);
        const allocated = gl.getBufferParameter(gl.PIXEL_PACK_BUFFER, gl.BUFFER_SIZE);
        if (allocated !== job.byteLength || gl.getError() !== gl.NO_ERROR) {
          throw new Error('PIXEL_PACK_BUFFER 大小无效。');
        }
        if (gl.isContextLost()) {
          throw new Error('读回完成前 WebGL 上下文已丢失。');
        }

        const pixels = new Uint8Array(job.byteLength);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
        const errorAfterCopy = gl.getError();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        if (gl.isContextLost() || errorAfterCopy !== gl.NO_ERROR) {
          throw new Error('GPU 读回失败，未生成有效字节。');
        }
        if (pixels.byteLength !== job.byteLength) {
          throw new Error('读回字节长度不足。');
        }

        return { status: 'complete', pixels };
      } catch (error) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        return {
          status: 'failed',
          error: error instanceof Error ? error : new Error('GPU 读回失败。'),
        };
      } finally {
        this.deleteReadback(job);
      }
    }

    deleteReadback(job) {
      const gl = this.gl;
      if (!job.live) return;
      job.live = false;
      if (gl && !gl.isContextLost()) {
        if (job.sync) gl.deleteSync(job.sync);
        if (job.pbo) gl.deleteBuffer(job.pbo);
        if (job.sourceTexture) gl.deleteTexture(job.sourceTexture);
        if (job.destinationTexture) gl.deleteTexture(job.destinationTexture);
        if (job.framebuffer) gl.deleteFramebuffer(job.framebuffer);
      }
      job.sync = null;
      job.pbo = null;
      job.sourceTexture = null;
      job.destinationTexture = null;
      job.framebuffer = null;
    }

    abandonReadback(job) {
      if (!job) return;
      job.live = false;
      job.sync = null;
      job.pbo = null;
      job.sourceTexture = null;
      job.destinationTexture = null;
      job.framebuffer = null;
    }

    loseContextExtension() {
      if (!this.loseExtension) {
        this.loseExtension = this.gl.getExtension('WEBGL_lose_context');
      }
      if (!this.loseExtension) throw new Error('浏览器未提供 WEBGL_lose_context。');
      return this.loseExtension;
    }

    recreateAfterRestore() {
      this.loseExtension = null;
      this.createPersistentResources();
    }
  }

  function flipRowsForPng(pixels, width, height) {
    const corrected = new Uint8Array(pixels.length);
    const rowBytes = width * PIXEL_BYTES;
    for (let y = 0; y < height; y += 1) {
      const sourceStart = (height - 1 - y) * rowBytes;
      const targetStart = y * rowBytes;
      corrected.set(pixels.subarray(sourceStart, sourceStart + rowBytes), targetStart);
    }
    return corrected;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  class ExportApp {
    constructor() {
      this.canvas = $('grid-canvas');
      this.doc = new PixelDocument(8, 8);
      this.renderer = new Renderer(this.canvas);
      this.pending = [];
      this.active = [];
      this.records = new Map();
      this.nextTaskId = 1;
      this.exportSequence = 0;
      this.contextLost = false;
      this.polling = false;
      this.painting = false;
      this.selectedColor = [37, 87, 201, 255];
      this.lostPromise = this.makeSignal();
      this.restoredPromise = this.makeSignal();

      this.bindUi();
      this.syncColorInputs();
      this.renderer.drawDocument(this.doc);
      this.updateState();
      this.installContextHandlers();

      if (!MANUAL_POLL) this.startAutoPoll();

      window.__pixelTestHooks = this.testHooks();
    }

    makeSignal() {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    bindUi() {
      $('dimensions-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const width = clampByte($('width-input').value);
        const height = clampByte($('height-input').value);
        if (width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) return;
        this.doc.resize(width, height);
        this.afterEdit();
      });

      $('color-input').addEventListener('input', () => {
        const value = $('color-input').value;
        const r = parseInt(value.slice(1, 3), 16);
        const g = parseInt(value.slice(3, 5), 16);
        const b = parseInt(value.slice(5, 7), 16);
        this.selectedColor = [r, g, b, this.selectedColor[3]];
        this.syncRgbaInputs();
      });

      for (const suffix of ['r', 'g', 'b', 'a']) {
        $(`${suffix}-input`).addEventListener('input', () => {
          const order = { r: 0, g: 1, b: 2, a: 3 };
          this.selectedColor[order[suffix]] = clampByte($(`${suffix}-input`).value);
          this.syncHexInput();
        });
      }

      $('fill-button').addEventListener('click', () => {
        this.doc.fill(this.selectedColor);
        this.afterEdit();
      });

      $('clear-button').addEventListener('click', () => {
        this.doc.clear();
        this.afterEdit();
      });

      $('export-button').addEventListener('click', () => {
        this.requestExport().catch((error) => {
          console.warn('导出失败', error);
        });
      });

      const paintAt = (event) => {
        const rect = this.canvas.getBoundingClientRect();
        const x = Math.floor(((event.clientX - rect.left) / rect.width) * this.doc.width);
        const y = Math.floor(((event.clientY - rect.top) / rect.height) * this.doc.height);
        if (this.doc.setPixel(x, y, this.selectedColor)) this.afterEdit();
      };

      this.canvas.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.canvas.setPointerCapture(event.pointerId);
        this.painting = true;
        paintAt(event);
      });
      this.canvas.addEventListener('pointermove', (event) => {
        if (this.painting && (event.buttons & 1) === 1) paintAt(event);
      });
      const stopPaint = () => {
        this.painting = false;
      };
      this.canvas.addEventListener('pointerup', stopPaint);
      this.canvas.addEventListener('pointercancel', stopPaint);
    }

    installContextHandlers() {
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.handleContextLost();
      });

      this.canvas.addEventListener('webglcontextrestored', async () => {
        try {
          this.renderer.recreateAfterRestore();
          this.contextLost = false;
          this.renderer.drawDocument(this.doc);
          this.setStatus('GPU 上下文已恢复，并从保留的 CPU 编辑数据重建。');
          this.updateState();
        } catch (error) {
          this.setStatus(`上下文恢复失败：${error.message}`);
        } finally {
          const signal = this.restoredPromise;
          this.restoredPromise = this.makeSignal();
          signal.resolve();
        }
      });
    }

    handleContextLost() {
      this.contextLost = true;
      for (const task of [...this.pending, ...this.active]) {
        if (task.job) this.renderer.abandonReadback(task.job);
        task.job = null;
        this.failTask(task, new Error('WebGL 上下文丢失：尚未完成的读回已取消。'));
      }
      this.pending = [];
      this.active = [];
      this.setStatus('GPU 上下文丢失：排队和在途任务均明确失败，空缓冲不会被导出。');
      this.updateState();

      const signal = this.lostPromise;
      this.lostPromise = this.makeSignal();
      signal.resolve();
    }

    afterEdit() {
      if (!this.contextLost) this.renderer.drawDocument(this.doc);
      this.updateState();
    }

    syncColorInputs() {
      this.syncHexInput();
      this.syncRgbaInputs();
    }

    syncHexInput() {
      const [r, g, b] = this.selectedColor;
      const hex = (value) => value.toString(16).padStart(2, '0');
      $('color-input').value = `#${hex(r)}${hex(g)}${hex(b)}`;
    }

    syncRgbaInputs() {
      $('r-input').value = this.selectedColor[0];
      $('g-input').value = this.selectedColor[1];
      $('b-input').value = this.selectedColor[2];
      $('a-input').value = this.selectedColor[3];
    }

    updateState() {
      $('revision-value').textContent = String(this.doc.revision);
      $('size-value').textContent = `${this.doc.width}×${this.doc.height}`;
      $('inflight-value').textContent = `${this.active.length}/${MAX_INFLIGHT}`;
      $('width-input').value = String(this.doc.width);
      $('height-input').value = String(this.doc.height);
      $('export-button').disabled = this.contextLost;
    }

    setStatus(message) {
      $('renderer-status').textContent = message;
    }

    startAutoPoll() {
      window.setInterval(() => {
        this.pumpQueue();
        this.pollOnce().catch((error) => console.warn(error));
      }, 20);
    }

    pumpQueue() {
      if (this.contextLost) return;
      while (this.active.length < MAX_INFLIGHT && this.pending.length > 0) {
        const task = this.pending.shift();
        try {
          task.job = this.renderer.beginReadback(task.snapshot);
          task.status = 'waiting';
          this.active.push(task);
          this.renderTask(task);
        } catch (error) {
          this.failTask(task, error);
        }
      }
      this.updateState();
    }

    createExportTask() {
      if (this.contextLost) {
        const error = new Error('WebGL 上下文丢失，不能创建导出。');
        return Promise.reject(error);
      }

      const snapshot = this.doc.snapshot();
      this.exportSequence += 1;
      const fileName = `pixel-sheet-r${snapshot.revision}-${snapshot.width}x${snapshot.height}-${String(this.exportSequence).padStart(4, '0')}.png`;
      const id = this.nextTaskId++;
      const task = {
        id,
        fileName,
        snapshot,
        revision: snapshot.revision,
        width: snapshot.width,
        height: snapshot.height,
        status: 'queued',
        job: null,
        error: null,
        element: null,
      };
      task.promise = new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
      });
      task.promise.catch(() => {
        // 失败状态和回调由任务列表负责；这里避免无监听 Promise 报告。
      });
      this.records.set(id, task);
      this.pending.push(task);
      this.addTaskElement(task);
      this.pumpQueue();
      return {
        id,
        fileName,
        revision: task.revision,
        width: task.width,
        height: task.height,
        status: task.status,
        promise: task.promise,
      };
    }

    requestExport() {
      return this.createExportTask().promise;
    }

    async pollOnce() {
      if (this.polling) return { advanced: 0, waited: 0 };
      this.polling = true;
      let advanced = 0;
      let waited = 0;
      try {
        for (const task of [...this.active]) {
          if (task.status !== 'waiting' || !task.job) continue;
          const result = this.renderer.pollReadback(task.job);
          if (result.status === 'waiting') {
            waited += 1;
            continue;
          }
          if (result.status === 'failed') {
            task.job = null;
            this.removeActive(task);
            this.failTask(task, result.error);
            continue;
          }

          advanced += 1;
          task.job = null;
          this.removeActive(task);
          this.updateState();
          await this.completeExport(task, result.pixels);
        }
        this.pumpQueue();
        return { advanced, waited, active: this.active.length, pending: this.pending.length };
      } finally {
        this.polling = false;
        this.updateState();
      }
    }

    removeActive(task) {
      const index = this.active.indexOf(task);
      if (index >= 0) this.active.splice(index, 1);
    }

    async completeExport(task, gpuPixels) {
      try {
        task.status = 'encoding';
        this.renderTask(task);

        if (gpuPixels.byteLength !== task.width * task.height * PIXEL_BYTES) {
          throw new Error('读回数据为空或长度与快照尺寸不符。');
        }

        const topDownPixels = flipRowsForPng(gpuPixels, task.width, task.height);
        const offscreen = new OffscreenCanvas(task.width, task.height);
        const context2d = offscreen.getContext('2d');
        if (!context2d) throw new Error('无法创建离屏 2D 编码上下文。');
        const image = new ImageData(new Uint8ClampedArray(topDownPixels), task.width, task.height);
        context2d.putImageData(image, 0, 0);
        const blob = await offscreen.convertToBlob({ type: 'image/png' });
        if (!blob || blob.size < 8) throw new Error('PNG 编码器返回了空文件。');

        downloadBlob(blob, task.fileName);
        task.status = 'done';
        task.error = null;
        this.renderTask(task);
        task.resolve({
          id: task.id,
          fileName: task.fileName,
          revision: task.revision,
          width: task.width,
          height: task.height,
          size: blob.size,
        });
        task.resolve = null;
        task.reject = null;
      } catch (error) {
        this.failTask(task, error);
      }
    }

    failTask(task, error) {
      if (task.status === 'done') return;
      if (task.job) {
        this.renderer.abandonReadback(task.job);
        task.job = null;
      }
      const pendingIndex = this.pending.indexOf(task);
      if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
      this.removeActive(task);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      this.renderTask(task);
      const reject = task.reject;
      task.resolve = null;
      task.reject = null;
      if (reject) reject(error instanceof Error ? error : new Error(task.error));
      this.updateState();
    }

    addTaskElement(task) {
      const item = document.createElement('li');
      item.className = 'task-item';
      const name = document.createElement('span');
      name.className = 'task-name';
      const state = document.createElement('span');
      state.className = 'task-state';
      const detail = document.createElement('span');
      detail.className = 'task-detail';
      item.append(name, state, detail);
      $('task-list').prepend(item);
      task.element = { item, name, state, detail };
      this.renderTask(task);
    }

    renderTask(task) {
      if (!task.element) return;
      const { item, name, state, detail } = task.element;
      item.dataset.status = task.status;
      name.textContent = task.fileName;
      state.className = `task-state state-${task.status}`;
      const labels = {
        queued: '排队',
        waiting: 'GPU 在途',
        encoding: 'PNG 编码',
        done: '已下载',
        failed: '失败',
      };
      state.textContent = labels[task.status] || task.status;
      if (task.status === 'failed') {
        detail.textContent = task.error || '导出失败。';
      } else {
        detail.textContent = `修订 ${task.revision} · ${task.width}×${task.height}`;
      }
    }

    testHooks() {
      const snapshotState = () => ({
        revision: this.doc.revision,
        width: this.doc.width,
        height: this.doc.height,
        pixels: Array.from(this.doc.pixels),
        active: this.active.map((task) => ({
          id: task.id,
          hasSync: Boolean(task.job && task.job.sync),
          hasPbo: Boolean(task.job && task.job.pbo),
          live: Boolean(task.job && task.job.live),
        })),
        pending: this.pending.map((task) => task.id),
      });

      return {
        manualPoll: MANUAL_POLL,
        getState: snapshotState,
        getTasks: () => Array.from(this.records.values()).map((task) => ({
          id: task.id,
          status: task.status,
          fileName: task.fileName,
          revision: task.revision,
          width: task.width,
          height: task.height,
          error: task.error,
        })),
        requestExport: () => {
          if (this.contextLost) throw new Error('WebGL 上下文丢失，不能创建导出。');
          const { promise, ...metadata } = this.createExportTask();
          void promise;
          return metadata;
        },
        pollOnce: () => this.pollOnce(),
        setSize: (width, height) => {
          this.doc.resize(width, height);
          this.afterEdit();
          return snapshotState();
        },
        fill: (rgba) => {
          this.doc.fill(rgba);
          this.afterEdit();
          return snapshotState();
        },
        clear: () => {
          this.doc.clear();
          this.afterEdit();
          return snapshotState();
        },
        setPixel: (x, y, rgba) => {
          const changed = this.doc.setPixel(x, y, rgba);
          this.afterEdit();
          return changed;
        },
        isContextLost: () => this.renderer.gl.isContextLost(),
        loseContext: async () => {
          this.renderer.loseContextExtension().loseContext();
          await this.lostPromise.promise;
        },
        restoreContext: async () => {
          this.renderer.loseContextExtension().restoreContext();
          await this.restoredPromise.promise;
        },
      };
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    try {
      new ExportApp();
    } catch (error) {
      const status = $('renderer-status');
      if (status) status.textContent = error.message;
      console.error(error);
    }
  });
})();

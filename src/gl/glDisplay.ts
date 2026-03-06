import vertSrc from "./shaders/fullscreen.vert?raw";
import fragSrc from "./shaders/fullscreen.frag?raw";

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Failed to create shader");
  }
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("Failed to create program");
  }
  const vert = compile(gl, gl.VERTEX_SHADER, vs);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "Unknown program link error";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

export class GLDisplay {
  readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly texLoc: WebGLUniformLocation;
  private texWidth = 0;
  private texHeight = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    if (!gl) {
      throw new Error("WebGL2 is required");
    }
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc);
    const texture = gl.createTexture();
    if (!texture) {
      throw new Error("Failed to create texture");
    }
    this.texture = texture;
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("Failed to create VAO");
    }
    this.vao = vao;
    const vbo = gl.createBuffer();
    if (!vbo) {
      throw new Error("Failed to create VBO");
    }
    this.vbo = vbo;
    const texLoc = gl.getUniformLocation(this.program, "uTex");
    if (texLoc === null) {
      throw new Error("Missing uTex uniform");
    }
    this.texLoc = texLoc;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const quad = new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      -1, 1, 0, 1,
      -1, 1, 0, 1,
      1, -1, 1, 0,
      1, 1, 1, 1
    ]);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
  }

  private bindForDraw(): void {
    const gl = this.gl;
    this.resizeToClientSize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.texLoc, 0);
  }

  private ensureTexture(width: number, height: number): void {
    const gl = this.gl;
    if (this.texWidth === width && this.texHeight === height) {
      return;
    }
    this.texWidth = width;
    this.texHeight = height;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  beginFrame(width: number, height: number): void {
    this.ensureTexture(width, height);
  }

  updateTile(x: number, y: number, width: number, height: number, rgba: Uint8Array): void {
    const gl = this.gl;
    if (this.texWidth <= 0 || this.texHeight <= 0) {
      return;
    }
    const glY = this.texHeight - y - height;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, glY, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  present(): void {
    const gl = this.gl;
    this.bindForDraw();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  resizeToClientSize(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.canvas.clientWidth || window.innerWidth;
    const cssH = rect.height || this.canvas.clientHeight || window.innerHeight;
    const width = Math.max(1, Math.round(cssW * dpr));
    const height = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  displayRGBA(width: number, height: number, rgba: Uint8Array): void {
    const gl = this.gl;
    this.beginFrame(width, height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.present();
  }
}

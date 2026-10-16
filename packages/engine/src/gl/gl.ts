/**
 * The GL resource layer (ADR-0009). Every GPU object is created through a
 * descriptor kept on the CPU side, so after a context loss everything can be
 * rebuilt from scratch with `rebuildAll()`.
 */

export class ShaderError extends Error {
  constructor(
    readonly program: string,
    readonly log: string,
  ) {
    super(`Shader "${program}" failed: ${log}`);
  }
}

interface Rebuildable {
  rebuild(): void;
}

export class Gl {
  readonly gl: WebGL2RenderingContext;
  private readonly resources = new Set<Rebuildable>();

  constructor(readonly canvas: HTMLCanvasElement, attributes: WebGLContextAttributes) {
    const gl = canvas.getContext("webgl2", attributes);
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  track<T extends Rebuildable>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }

  untrack(resource: Rebuildable): void {
    this.resources.delete(resource);
  }

  /** Recreates every tracked GPU resource (after `webglcontextrestored`). */
  rebuildAll(): void {
    for (const resource of this.resources) resource.rebuild();
  }

  program(name: string, vertex: string, fragment: string): Program {
    return this.track(new Program(this.gl, name, vertex, fragment));
  }

  /** A unit quad (0..1) as a triangle strip, the base geometry for everything we draw. */
  quad(): QuadGeometry {
    return this.track(new QuadGeometry(this.gl));
  }

  texture(): Texture {
    return this.track(new Texture(this.gl));
  }
}

export class Program implements Rebuildable {
  handle!: WebGLProgram;
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly name: string,
    private readonly vertexSource: string,
    private readonly fragmentSource: string,
  ) {
    this.rebuild();
  }

  rebuild(): void {
    const { gl } = this;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new ShaderError(this.name, gl.getShaderInfoLog(shader) ?? "compile error");
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, this.vertexSource);
    const fs = compile(gl.FRAGMENT_SHADER, this.fragmentSource);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_corner");
    gl.bindAttribLocation(program, 1, "a_instance");
    gl.bindAttribLocation(program, 2, "a_instance2");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new ShaderError(this.name, gl.getProgramInfoLog(program) ?? "link error");
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.handle = program;
    this.locations.clear();
  }

  use(): this {
    this.gl.useProgram(this.handle);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, location);
    }
    return location;
  }

  f(name: string, x: number): this {
    this.gl.uniform1f(this.loc(name), x);
    return this;
  }

  v2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.loc(name), x, y);
    return this;
  }

  v3(name: string, x: number, y: number, z: number): this {
    this.gl.uniform3f(this.loc(name), x, y, z);
    return this;
  }

  v4(name: string, x: number, y: number, z: number, w: number): this {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
    return this;
  }

  rgb(name: string, color: readonly [number, number, number]): this {
    this.gl.uniform3f(this.loc(name), color[0], color[1], color[2]);
    return this;
  }

  i(name: string, x: number): this {
    this.gl.uniform1i(this.loc(name), x);
    return this;
  }
}

/** Unit quad plus optional per-instance buffers (instanced drawing for particles). */
export class QuadGeometry implements Rebuildable {
  vao!: WebGLVertexArrayObject;
  private corners!: WebGLBuffer;
  private instanceBuffers: Array<{ buffer: WebGLBuffer; location: number; size: number; data: Float32Array }> = [];

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.rebuild();
  }

  rebuild(): void {
    const { gl } = this;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const previous = this.instanceBuffers;
    this.instanceBuffers = [];
    for (const entry of previous) this.attachInstances(entry.location, entry.size, entry.data);
    gl.bindVertexArray(null);
  }

  /** Adds (or after rebuild, re-adds) a per-instance vec attribute. */
  attachInstances(location: number, size: number, data: Float32Array): void {
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, 1);
    this.instanceBuffers.push({ buffer, location, size, data });
    gl.bindVertexArray(null);
  }

  /** Re-uploads a slice of instance data after the CPU copy changed. */
  updateInstances(location: number, offsetFloats: number, lengthFloats: number): void {
    const entry = this.instanceBuffers.find((b) => b.location === location);
    if (!entry) return;
    const { gl } = this;
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, offsetFloats * 4, entry.data, offsetFloats, lengthFloats);
  }

  draw(instances = 1): void {
    const { gl } = this;
    gl.bindVertexArray(this.vao);
    if (instances === 1 && this.instanceBuffers.length === 0) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);
    gl.bindVertexArray(null);
  }
}

/** A texture whose pixels come from a 2D canvas (text sprites). */
export class Texture implements Rebuildable {
  handle!: WebGLTexture;
  width = 0;
  height = 0;
  private source: TexImageSource | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.rebuild();
  }

  rebuild(): void {
    const { gl } = this;
    this.handle = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    if (this.source) this.upload(this.source, this.width, this.height);
  }

  upload(source: TexImageSource, width: number, height: number): void {
    const { gl } = this;
    this.source = source;
    this.width = width;
    this.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  bind(unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
  }
}

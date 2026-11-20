"use client";

import { cn } from "cn";
import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../hooks/use-reduced-motion";

/** Two levels, 0 to 1: the microphone's and the agent's voice. */
export interface OrbLevels {
  readonly mic: number;
  readonly agent: number;
}

/**
 * Where the orb reads its levels. Levels change about 30 times a second, so they never go
 * through React state: the orb subscribes and draws from its own animation frame.
 */
export interface LevelSource {
  get(): OrbLevels;
  subscribe(listener: () => void): () => void;
}

/** A source that never changes: for stories, replays, and a paused session. */
export function staticLevels(levels: OrbLevels): LevelSource {
  return { get: () => levels, subscribe: () => () => {} };
}

/**
 * - `webgl`: the shader, the default.
 * - `css`: gradients scaled by the level, where WebGL is missing.
 * - `still`: one frame plus a ring that shows the level, for reduced motion.
 * - `auto`: `still` with reduced motion, otherwise `webgl`, or `css` without WebGL.
 */
export type OrbRenderer = "auto" | "webgl" | "css" | "still";

export interface OrbProps extends Omit<ComponentProps<"div">, "children"> {
  levels: LevelSource;
  /** The accessible name, such as "Microphone level". The orb is an image to assistive tech. */
  label: string;
  /** Width and height in CSS pixels. */
  size?: number;
  renderer?: OrbRenderer;
  /** The device pixel ratio is capped here; long frames scale the canvas down further. */
  maxPixelRatio?: number;
}

const QUIET = 0.01;
const SETTLED = 0.002;

const VERTEX = `attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// A disk that swells with the levels and wobbles while there's sound, tinted toward the glow
// color by the agent's voice. Output is premultiplied, as the canvas expects.
const FRAGMENT = `precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_mic;
uniform float u_agent;
uniform vec3 u_ink;
uniform vec3 u_glow;
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / (0.5 * min(u_res.x, u_res.y));
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float level = clamp(u_mic + u_agent, 0.0, 1.0);
  float wobble = 0.03 * (sin(a * 3.0 + u_time * 1.7) + sin(a * 5.0 - u_time * 1.3)) * (0.25 + level);
  float radius = 0.6 + 0.2 * level + wobble;
  float disk = smoothstep(radius, radius - 0.025, r);
  float glow = exp(-7.0 * max(r - radius, 0.0)) * (0.2 + 0.6 * level) * (1.0 - disk);
  vec3 tint = mix(u_ink, u_glow, clamp(u_agent * 1.5, 0.0, 1.0));
  vec3 shaded = tint * (0.82 + 0.18 * (1.0 - r / max(radius, 0.001)));
  float alpha = clamp(disk + glow, 0.0, 1.0);
  gl_FragColor = vec4(shaded * disk + u_glow * glow, alpha);
}`;

type Rgb = readonly [number, number, number];
const FALLBACK_INK: Rgb = [0.15, 0.18, 0.24];
const FALLBACK_GLOW: Rgb = [0.42, 0.67, 0.92];

let colorProbe: CanvasRenderingContext2D | null | undefined;

/** Any CSS color (hex, oklch, display-p3) as sRGB 0..1, through a 1×1 canvas. */
function toRgb(color: string, fallback: Rgb): Rgb {
  if (!color) return fallback;
  if (colorProbe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorProbe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!colorProbe) return fallback;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = "#000";
  colorProbe.fillStyle = color;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = colorProbe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

/** The theme's ink and glow colors, read from the tokens where the orb sits. */
function themeColors(element: HTMLElement): { ink: Rgb; glow: Rgb } {
  const style = getComputedStyle(element);
  return {
    ink: toRgb(style.getPropertyValue("--es-accent-9").trim(), FALLBACK_INK),
    glow: toRgb(style.getPropertyValue("--es-proposed-7").trim(), FALLBACK_GLOW),
  };
}

let webglSupport: boolean | undefined;

function supportsWebgl(): boolean {
  if (webglSupport === undefined) {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      webglSupport = Boolean(gl);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}

/**
 * Calls `paint` on animation frames while the levels move, and stops once they're quiet. `wake`
 * draws again (after a theme change, say) without waiting for the levels.
 */
function runLevelLoop(
  levels: LevelSource,
  host: HTMLElement,
  paint: (current: OrbLevels, elapsed: number, frameMs: number) => void,
  smoothing: boolean,
): { stop: () => void; wake: () => void } {
  const current = { mic: 0, agent: 0 };
  let target = levels.get();
  let frame = 0;
  let last = 0;
  let elapsed = 0;
  const step = (now: number) => {
    frame = 0;
    const frameMs = last ? Math.min(now - last, 100) : 16;
    last = now;
    const k = smoothing ? 1 - Math.exp(-frameMs / 80) : 1;
    current.mic += (target.mic - current.mic) * k;
    current.agent += (target.agent - current.agent) * k;
    elapsed += (frameMs / 1000) * (0.35 + current.mic + current.agent);
    paint(current, elapsed, frameMs);
    const settled =
      Math.abs(target.mic - current.mic) < SETTLED &&
      Math.abs(target.agent - current.agent) < SETTLED;
    if (settled && target.mic < QUIET && target.agent < QUIET) {
      last = 0;
      host.dataset.animating = "false";
      return;
    }
    frame = requestAnimationFrame(step);
  };
  const wake = () => {
    target = levels.get();
    if (frame) return;
    host.dataset.animating = "true";
    frame = requestAnimationFrame(step);
  };
  const unsubscribe = levels.subscribe(wake);
  // The first frame, even when silent, so the orb is never blank.
  host.dataset.animating = "true";
  frame = requestAnimationFrame(step);
  return {
    wake,
    stop: () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      host.dataset.animating = "false";
    },
  };
}

/** Re-runs `onChange` when the page's theme attribute changes. */
function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** Sets up the shader on `canvas`; null when WebGL refuses (then the orb falls back to CSS). */
function setupGl(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const at = (name: string) => gl.getUniformLocation(program, name);
  return {
    gl,
    uniforms: {
      res: at("u_res"),
      time: at("u_time"),
      mic: at("u_mic"),
      agent: at("u_agent"),
      ink: at("u_ink"),
      glow: at("u_glow"),
    },
  };
}

function WebglOrb({
  levels,
  size,
  maxPixelRatio,
  onUnavailable,
}: {
  levels: LevelSource;
  size: number;
  maxPixelRatio: number;
  onUnavailable: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const setup = setupGl(canvas);
    if (!setup) {
      onUnavailable();
      return;
    }
    const { gl, uniforms } = setup;
    let colors = themeColors(host);
    let scale = 1;
    let slowFrames = 0;
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio) * scale;
      const pixels = Math.max(1, Math.round(size * ratio));
      canvas.width = pixels;
      canvas.height = pixels;
      gl.viewport(0, 0, pixels, pixels);
    };
    resize();
    const loop = runLevelLoop(
      levels,
      host,
      (current, elapsed, frameMs) => {
        // Frames that run long scale the canvas down, to half resolution at most.
        slowFrames = frameMs > 28 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
        if (slowFrames > 8 && scale > 0.5) {
          scale = Math.max(0.5, scale * 0.75);
          slowFrames = 0;
          resize();
        }
        gl.uniform2f(uniforms.res, canvas.width, canvas.height);
        gl.uniform1f(uniforms.time, elapsed);
        gl.uniform1f(uniforms.mic, current.mic);
        gl.uniform1f(uniforms.agent, current.agent);
        gl.uniform3f(uniforms.ink, ...colors.ink);
        gl.uniform3f(uniforms.glow, ...colors.glow);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
      true,
    );
    const stopTheme = watchTheme(() => {
      colors = themeColors(host);
      loop.wake();
    });
    const lost = (event: Event) => {
      event.preventDefault();
      onUnavailable();
    };
    canvas.addEventListener("webglcontextlost", lost);
    return () => {
      loop.stop();
      stopTheme();
      canvas.removeEventListener("webglcontextlost", lost);
    };
  }, [levels, size, maxPixelRatio, onUnavailable]);

  // No aria-hidden needed: the orb's role="img" makes its children presentational.
  return <canvas ref={canvasRef} style={{ width: size, height: size }} />;
}

function CssOrb({ levels }: { levels: LevelSource }) {
  const blobRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const blob = blobRef.current;
    const host = blob?.parentElement;
    if (!blob || !host) return;
    const loop = runLevelLoop(
      levels,
      host,
      (current) => {
        const level = Math.min(1, current.mic + current.agent);
        blob.style.setProperty("--orb-scale", (0.82 + 0.3 * level).toFixed(3));
        blob.style.setProperty("--orb-glow", (0.2 + 0.6 * level).toFixed(3));
        blob.style.setProperty("--orb-agent", Math.min(1, current.agent * 1.5).toFixed(3));
      },
      true,
    );
    return loop.stop;
  }, [levels]);

  return (
    <div
      ref={blobRef}
      aria-hidden="true"
      className="absolute inset-[12%] rounded-full bg-[radial-gradient(circle_at_35%_30%,color-mix(in_oklab,var(--es-accent-9)_70%,white),var(--es-accent-9)_65%)] shadow-[0_0_calc(var(--orb-glow,0.2)*40px)_calc(var(--orb-glow,0.2)*12px)_var(--es-proposed-7)]"
      style={{ transform: "scale(var(--orb-scale, 0.82))" }}
    >
      <div
        className="absolute inset-0 rounded-full bg-(--es-proposed-7)"
        style={{ opacity: "var(--orb-agent, 0)" }}
      />
    </div>
  );
}

const RING_RADIUS = 46;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function StillOrb({ levels }: { levels: LevelSource }) {
  const ringRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const ring = ringRef.current;
    const host = ring?.closest<HTMLElement>("[data-slot=orb]");
    if (!ring || !host) return;
    host.dataset.animating = "false";
    // No animation frames and no transitions: the ring jumps to each new level, at most once a
    // frame, and nothing moves between levels.
    let frame = 0;
    const show = () => {
      frame = 0;
      const { mic, agent } = levels.get();
      const level = Math.min(1, Math.max(0, mic + agent));
      ring.setAttribute("stroke-dashoffset", (RING_LENGTH * (1 - level)).toFixed(2));
      host.dataset.level = level.toFixed(2);
    };
    show();
    const unsubscribe = levels.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(show);
    });
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [levels]);

  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" className="absolute inset-0 size-full">
      <circle cx="50" cy="50" r="30" fill="var(--es-accent-9)" />
      <circle
        cx="50"
        cy="50"
        r={RING_RADIUS}
        fill="none"
        stroke="var(--es-neutral-6)"
        strokeWidth="4"
      />
      <circle
        ref={ringRef}
        cx="50"
        cy="50"
        r={RING_RADIUS}
        fill="none"
        stroke="var(--es-proposed-9)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={RING_LENGTH.toFixed(2)}
        strokeDashoffset={RING_LENGTH.toFixed(2)}
        transform="rotate(-90 50 50)"
      />
    </svg>
  );
}

/**
 * Earshot's orb: a WebGL shader driven by two levels, the microphone and the agent. It draws only
 * while the levels move and stops its animation loop when they're quiet; it caps the device pixel
 * ratio and scales its canvas down when frames run long. With reduced motion it's a still frame
 * plus a ring that shows the level; without WebGL, CSS gradients.
 */
export function Orb({
  levels,
  label,
  size = 160,
  renderer = "auto",
  maxPixelRatio = 2,
  className,
  ...props
}: OrbProps) {
  const reduced = useReducedMotion();
  const [glFailed, setGlFailed] = useState(false);
  const [canWebgl, setCanWebgl] = useState<boolean | null>(null);
  const onUnavailable = useCallback(() => setGlFailed(true), []);

  useEffect(() => {
    setCanWebgl(supportsWebgl());
  }, []);

  let resolved: Exclude<OrbRenderer, "auto">;
  if (renderer !== "auto") resolved = renderer === "webgl" && glFailed ? "css" : renderer;
  else if (reduced) resolved = "still";
  else if (canWebgl === null) resolved = "still";
  else resolved = canWebgl && !glFailed ? "webgl" : "css";

  return (
    <div
      data-slot="orb"
      data-renderer={resolved}
      role="img"
      aria-label={label}
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      {...props}
    >
      {resolved === "webgl" && (
        <WebglOrb
          levels={levels}
          size={size}
          maxPixelRatio={maxPixelRatio}
          onUnavailable={onUnavailable}
        />
      )}
      {resolved === "css" && <CssOrb levels={levels} />}
      {resolved === "still" && <StillOrb levels={levels} />}
    </div>
  );
}

import {
  AmbientLight,
  CanvasTexture,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';
import { MOOD_COLORS, drawFace } from './face';
import type { Mood } from './face';

export type AvatarStyle = 'bot' | 'orb';

export interface AvatarHandle {
  setMood(mood: Mood): void;
  setStyle(style: AvatarStyle): void;
  /** Call when a chunk of text arrives; makes the mouth meter livelier for a moment. */
  pulse(): void;
  dispose(): void;
  readonly renderer: 'webgl' | '2d';
}

interface Options {
  style: AvatarStyle;
  mood: Mood;
  /** True in light themes: slightly darker shell so Oki does not vanish on white. */
  light: boolean;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Oki, the chat companion: a small procedural robot (or a plain orb) rendered with
 * Three.js. Everything is generated in code, so there are no model or texture files.
 * Falls back to a flat 2D drawing when WebGL is unavailable.
 */
export function mount(canvas: HTMLCanvasElement, options: Options): AvatarHandle {
  try {
    return mountWebgl(canvas, options);
  } catch (err) {
    console.warn('[opencode-hub] WebGL unavailable, using the 2D companion', err);
    return mount2d(canvas, options);
  }
}

function sharedState(canvas: HTMLCanvasElement, options: Options) {
  const s = {
    mood: options.mood,
    style: options.style,
    energy: 0,
    pointerX: 0,
    pointerY: 0,
    moodSince: performance.now(),
    visible: true,
    /** False while VS Code keeps the view alive but hidden (retainContextWhenHidden). */
    hostVisible: true,
    disposed: false,
    reduced: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    s.pointerX = clamp((e.clientX - (r.left + r.width / 2)) / 260, -1, 1);
    s.pointerY = clamp((e.clientY - (r.top + r.height / 2)) / 260, -1, 1);
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  const onHostVisible = (e: Event) => (s.hostVisible = (e as CustomEvent<boolean>).detail !== false);
  window.addEventListener('ochub-visible', onHostVisible);
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => (s.visible = entries.some((e) => e.isIntersecting))) : undefined;
  io?.observe(canvas);
  const cleanup = () => {
    s.disposed = true;
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('ochub-visible', onHostVisible);
    io?.disconnect();
  };
  canvas.dataset.mood = s.mood;
  return { s, cleanup };
}

/* --------------------------------------------------------------------- WebGL */

function mountWebgl(canvas: HTMLCanvasElement, options: Options): AvatarHandle {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  const { s, cleanup } = sharedState(canvas, options);
  canvas.dataset.renderer = 'webgl';

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.15, 7.4);

  scene.add(new AmbientLight(0xffffff, options.light ? 1.25 : 0.85));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 4, 5);
  scene.add(key);
  const rim = new PointLight(MOOD_COLORS[s.mood], 14, 12);
  rim.position.set(-2.4, 1.2, -1.5);
  scene.add(rim);

  const moodColor = new Color(MOOD_COLORS[s.mood]);
  const targetColor = new Color(MOOD_COLORS[s.mood]);
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);

  /* ---- bot ---- */
  const bot = new Group();
  scene.add(bot);
  const shell = track(new MeshStandardMaterial({ color: options.light ? 0xd7dde8 : 0xf1f4f9, roughness: 0.38, metalness: 0.08 }));
  const dark = track(new MeshStandardMaterial({ color: 0x232a3a, roughness: 0.5, metalness: 0.3 }));
  const glow = track(new MeshBasicMaterial({ color: moodColor }));

  const head = new Group();
  head.position.y = 0.42;
  bot.add(head);
  const skull = new Mesh(track(new SphereGeometry(1, 48, 32)), shell);
  skull.scale.set(1.08, 0.92, 0.98);
  head.add(skull);

  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = 384;
  faceCanvas.height = 224;
  const faceCtx = faceCanvas.getContext('2d')!;
  const faceTexture = track(new CanvasTexture(faceCanvas));
  faceTexture.colorSpace = SRGBColorSpace;
  // A patch of a slightly larger sphere, centred on +Z, carries the visor texture.
  const vw = 1.75;
  const vh = 1.02;
  const visor = new Mesh(track(new SphereGeometry(1.012, 40, 24, Math.PI / 2 - vw / 2, vw, Math.PI / 2 - vh / 2 - 0.02, vh)), track(new MeshBasicMaterial({ map: faceTexture, transparent: true })));
  visor.scale.copy(skull.scale);
  head.add(visor);

  for (const side of [-1, 1]) {
    const ear = new Mesh(track(new CylinderGeometry(0.2, 0.2, 0.14, 24)), dark);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(side * 1.08, 0, 0);
    head.add(ear);
    const ring = new Mesh(track(new TorusGeometry(0.2, 0.03, 10, 28)), glow);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(side * 1.16, 0, 0);
    head.add(ring);
  }
  const stalk = new Mesh(track(new CylinderGeometry(0.025, 0.035, 0.42, 10)), dark);
  stalk.position.set(0, 1.08, 0);
  head.add(stalk);
  const tip = new Mesh(track(new SphereGeometry(0.085, 16, 12)), glow);
  tip.position.set(0, 1.32, 0);
  head.add(tip);

  const body = new Mesh(track(new CapsuleGeometry(0.5, 0.22, 8, 24)), shell);
  body.position.y = -0.98;
  body.scale.set(1, 0.9, 0.86);
  bot.add(body);
  const chest = new Mesh(track(new TorusGeometry(0.15, 0.028, 10, 28)), glow);
  chest.position.set(0, -0.9, 0.43);
  bot.add(chest);
  const hands = [-1, 1].map((side) => {
    const hand = new Mesh(track(new SphereGeometry(0.17, 20, 14)), shell);
    hand.position.set(side * 0.82, -0.95, 0.15);
    bot.add(hand);
    return hand;
  });

  const dots = new Group();
  dots.position.y = 1.55;
  bot.add(dots);
  for (let i = 0; i < 3; i++) dots.add(new Mesh(track(new SphereGeometry(0.065, 12, 10)), glow));

  const shadow = new Mesh(track(new CircleGeometry(0.85, 32)), track(new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.78;
  shadow.scale.set(1, 0.55, 1);
  scene.add(shadow);

  /* ---- orb ---- */
  const orb = new Group();
  scene.add(orb);
  const orbMaterial = track(
    new ShaderMaterial({
      transparent: true,
      uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uColor: { value: moodColor } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uEnergy;
        varying vec3 vNormal; varying vec3 vView;
        void main() {
          float wob = sin(position.x * 3.1 + uTime * 1.3) * sin(position.y * 2.7 + uTime * 1.7) * sin(position.z * 3.3 + uTime);
          vec3 p = position + normal * wob * (0.04 + uEnergy * 0.12);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uEnergy;
        varying vec3 vNormal; varying vec3 vView;
        void main() {
          float f = pow(1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0), 2.2);
          vec3 core = mix(uColor * 0.28, uColor, f);
          gl_FragColor = vec4(core + f * 0.35, 0.55 + f * 0.45 + uEnergy * 0.1);
        }`,
    }),
  );
  orb.add(new Mesh(track(new IcosahedronGeometry(1.05, 24)), orbMaterial));
  const rings = [0, 1].map((i) => {
    const ring = new Mesh(track(new TorusGeometry(1.5 + i * 0.22, 0.012, 8, 96)), glow);
    ring.rotation.x = Math.PI / 2 + (i ? 0.5 : -0.35);
    orb.add(ring);
    return ring;
  });

  const applyStyle = () => {
    bot.visible = s.style === 'bot';
    shadow.visible = s.style === 'bot';
    orb.visible = s.style === 'orb';
    canvas.dataset.style = s.style;
  };
  applyStyle();

  const resize = () => {
    const w = canvas.clientWidth || 160;
    const h = canvas.clientHeight || 160;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  let raf = 0;
  let last = 0;
  let yaw = 0;
  let pitch = 0;
  let frames = 0;
  const start = performance.now();
  const frame = (now: number) => {
    if (s.disposed) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || !s.visible || !s.hostVisible) return;
    // Idle animation does not need 60 fps; lively moods do.
    const calm = s.mood === 'idle' || s.reduced;
    if (now - last < (calm ? 33 : 15)) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = s.reduced ? 0 : (now - start) / 1000;
    const since = (now - s.moodSince) / 1000;
    s.energy = Math.max(0, s.energy - dt * 1.6);

    targetColor.set(MOOD_COLORS[s.mood]);
    moodColor.lerp(targetColor, 0.12);
    rim.color.copy(moodColor);
    glow.color.copy(moodColor);
    orbMaterial.uniforms.uTime.value = t;
    orbMaterial.uniforms.uEnergy.value = s.mood === 'speaking' ? 0.4 + s.energy * 0.6 : s.mood === 'thinking' || s.mood === 'tool' ? 0.45 : 0.1;

    if (s.style === 'bot') {
      const k = 1 - Math.pow(0.001, dt);
      let targetYaw = s.pointerX * 0.55;
      let targetPitch = s.pointerY * 0.3;
      let bob = Math.sin(t * 1.6) * 0.06;
      let tilt = 0;
      let hop = 0;
      if (s.mood === 'thinking') {
        targetYaw = Math.sin(t * 0.9) * 0.25;
        targetPitch = -0.16;
        tilt = 0.1;
      } else if (s.mood === 'tool') {
        targetPitch = 0.2;
        targetYaw = Math.sin(t * 5) * 0.04;
      } else if (s.mood === 'waiting') {
        tilt = Math.sin(t * 2) * 0.09 + 0.1;
      } else if (s.mood === 'error') {
        targetYaw = since < 0.9 ? Math.sin(since * 22) * 0.3 * (1 - since / 0.9) : 0;
        targetPitch = 0.14;
        bob *= 0.3;
      } else if (s.mood === 'happy') {
        hop = since < 0.9 ? Math.abs(Math.sin(since * 7)) * 0.3 * (1 - since / 0.9) : 0;
      } else if (s.mood === 'speaking') {
        bob += Math.sin(t * 9) * 0.012 * (0.4 + s.energy);
      }
      yaw = lerp(yaw, targetYaw, k);
      pitch = lerp(pitch, targetPitch, k);
      head.rotation.set(pitch, yaw, lerp(head.rotation.z, tilt, k));
      bot.position.y = bob + hop;
      bot.rotation.y = yaw * 0.25;
      body.rotation.y = yaw * 0.15;
      shadow.scale.x = 1 - (bob + hop) * 0.6;
      (shadow.material as MeshBasicMaterial).opacity = 0.22 - (bob + hop) * 0.25;

      const typing = s.mood === 'tool';
      hands.forEach((hand, i) => {
        const side = i ? 1 : -1;
        const ty = typing ? -0.72 + Math.abs(Math.sin(t * 11 + i * 1.6)) * 0.14 : s.mood === 'happy' ? -0.2 + hop : s.mood === 'waiting' && i ? -0.1 : -0.95 + Math.sin(t * 1.6 + i) * 0.04;
        const tx = side * (typing ? 0.42 : s.mood === 'happy' ? 1.02 : 0.82);
        const tz = typing ? 0.62 : 0.15;
        hand.position.set(lerp(hand.position.x, tx, k), lerp(hand.position.y, ty, k), lerp(hand.position.z, tz, k));
      });

      const showDots = s.mood === 'thinking' ? 1 : 0;
      dots.children.forEach((d: Object3D, i) => {
        const a = t * 2.4 + (i * Math.PI * 2) / 3;
        d.position.set(Math.cos(a) * 0.42, Math.sin(a * 2) * 0.05, Math.sin(a) * 0.42);
        d.scale.setScalar(lerp(d.scale.x, showDots, k));
      });
      tip.scale.setScalar(1 + (s.mood === 'idle' ? 0.08 : 0.3) * Math.abs(Math.sin(t * (s.mood === 'idle' ? 1.2 : 4))));
      chest.scale.setScalar(1 + s.energy * 0.25);

      drawFace(faceCtx, faceCanvas.width, faceCanvas.height, { mood: s.mood, t, gazeX: s.pointerX - yaw * 0.6, gazeY: s.pointerY, energy: s.energy, color: `#${moodColor.getHexString()}` });
      faceTexture.needsUpdate = true;
    } else {
      orb.rotation.y = t * 0.25 + s.pointerX * 0.4;
      orb.rotation.x = s.pointerY * 0.25;
      const pulse = 1 + Math.sin(t * (s.mood === 'idle' ? 1.2 : 3.5)) * 0.03 + s.energy * 0.05;
      orb.scale.setScalar(pulse * 0.92);
      rings[0].rotation.z = t * (s.mood === 'idle' ? 0.3 : 1.4);
      rings[1].rotation.z = -t * (s.mood === 'idle' ? 0.2 : 1.1);
    }
    renderer.render(scene, camera);
    canvas.dataset.frames = String(++frames);
  };
  raf = requestAnimationFrame(frame);

  return {
    renderer: 'webgl',
    setMood(mood) {
      if (mood === s.mood) return;
      s.mood = mood;
      s.moodSince = performance.now();
      canvas.dataset.mood = mood;
    },
    setStyle(style) {
      s.style = style;
      applyStyle();
    },
    pulse() {
      s.energy = Math.min(1, s.energy + 0.35);
    },
    dispose() {
      cancelAnimationFrame(raf);
      cleanup();
      ro.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
    },
  };
}

/* ------------------------------------------------------------------ fallback */

function mount2d(canvas: HTMLCanvasElement, options: Options): AvatarHandle {
  const g = canvas.getContext('2d');
  const { s, cleanup } = sharedState(canvas, options);
  canvas.dataset.renderer = '2d';
  const face = document.createElement('canvas');
  face.width = 384;
  face.height = 224;
  const fg = face.getContext('2d');
  let raf = 0;
  let last = 0;
  const start = performance.now();
  const frame = (now: number) => {
    if (s.disposed) return;
    raf = requestAnimationFrame(frame);
    if (!g || !fg || document.hidden || !s.visible || !s.hostVisible || now - last < 50) return;
    last = now;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = (canvas.width = (canvas.clientWidth || 160) * dpr);
    const h = (canvas.height = (canvas.clientHeight || 160) * dpr);
    const t = s.reduced ? 0 : (now - start) / 1000;
    s.energy = Math.max(0, s.energy - 0.08);
    const color = MOOD_COLORS[s.mood];
    const r = Math.min(w, h) * 0.34;
    const cy = h / 2 + Math.sin(t * 1.6) * r * 0.04;
    g.clearRect(0, 0, w, h);
    g.beginPath();
    g.ellipse(w / 2, cy, r * 1.08, r * 0.94, 0, 0, Math.PI * 2);
    g.fillStyle = s.style === 'orb' ? color : options.light ? '#d7dde8' : '#f1f4f9';
    g.globalAlpha = s.style === 'orb' ? 0.55 + s.energy * 0.3 : 1;
    g.fill();
    g.globalAlpha = 1;
    if (s.style === 'bot') {
      drawFace(fg, face.width, face.height, { mood: s.mood, t, gazeX: s.pointerX, gazeY: s.pointerY, energy: s.energy, color });
      g.drawImage(face, w / 2 - r * 0.9 + s.pointerX * r * 0.08, cy - r * 0.5, r * 1.8, r * 1.05);
    }
  };
  raf = requestAnimationFrame(frame);
  return {
    renderer: '2d',
    setMood(mood) {
      s.mood = mood;
      s.moodSince = performance.now();
      canvas.dataset.mood = mood;
    },
    setStyle(style) {
      s.style = style;
      canvas.dataset.style = style;
    },
    pulse() {
      s.energy = Math.min(1, s.energy + 0.35);
    },
    dispose() {
      cancelAnimationFrame(raf);
      cleanup();
    },
  };
}

declare global {
  interface Window {
    OkiAvatar?: { mount: typeof mount };
  }
}
window.OkiAvatar = { mount };

import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  WebGLRenderer,
} from 'three';
import { MOOD_COLORS, blinkAt, drawFace } from './face';
import type { Mood, Reaction, WorkKind } from './face';
import { Particles } from './particles';

export type AvatarStyle = 'buddy' | 'dots';

export interface AvatarHandle {
  setMood(mood: Mood): void;
  /** Which prop Oki uses while working: hammer, pencil or magnifying glass. */
  setWork(kind: WorkKind): void;
  setStyle(style: AvatarStyle): void;
  /** A short one-off reaction layered on top of the current mood. */
  react(kind: Reaction): void;
  /** Call when a chunk of text arrives; makes talking livelier for a moment. */
  pulse(): void;
  dispose(): void;
  readonly renderer: 'webgl' | '2d';
}

interface Options {
  style: AvatarStyle;
  mood: Mood;
  light: boolean;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smooth = (lo: number, hi: number, x: number): number => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const CONFETTI = ['#ff9ad5', '#ffd166', '#7df29a', '#6cc8ff', '#a394ff', '#ffffff'];

/**
 * Oki, the chat companion: a small round creature (or a row of dots) rendered with
 * Three.js. It is generated entirely in code, so there are no model or texture files,
 * and falls back to a flat 2D drawing when WebGL is unavailable.
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
    work: 'build' as WorkKind,
    style: options.style,
    energy: 0,
    pointerX: 0,
    pointerY: 0,
    moodSince: performance.now(),
    reaction: undefined as Reaction | undefined,
    reactionAt: 0,
    visible: true,
    /** False while VS Code keeps the view alive but hidden (retainContextWhenHidden). */
    hostVisible: true,
    disposed: false,
    reduced: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  };
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    s.pointerX = clamp((e.clientX - (r.left + r.width / 2)) / 240, -1, 1);
    s.pointerY = clamp((e.clientY - (r.top + r.height / 2)) / 240, -1, 1);
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
  canvas.dataset.style = s.style;
  return { s, cleanup };
}

/* ------------------------------------------------------------------ geometry */

/** Silhouette of Oki's body: t runs from the bottom (0) to the top (π). Chubbier towards the feet. */
function profile(t: number): [radius: number, y: number] {
  const sin = Math.sin(t);
  const cos = Math.cos(t);
  return [sin * (1 + (0.16 * (1 + cos)) / 2), -cos * 0.96];
}

/**
 * A patch of the body surface. With the full angular range it is the body itself (with a
 * colour gradient and a pale belly baked into vertex colours); with a narrow range and a
 * little inflation it is the decal that carries the face.
 */
function blobGeometry(phi0: number, phiLen: number, t0: number, tLen: number, segU: number, segV: number, inflate: number, colors?: { top: Color; bottom: Color; belly: Color }): BufferGeometry {
  const pos = new Float32Array((segU + 1) * (segV + 1) * 3);
  const uv = new Float32Array((segU + 1) * (segV + 1) * 2);
  const col = colors ? new Float32Array((segU + 1) * (segV + 1) * 3) : undefined;
  const tmp = new Color();
  let n = 0;
  for (let j = 0; j <= segV; j++) {
    const [r, y] = profile(t0 + (tLen * j) / segV);
    for (let i = 0; i <= segU; i++, n++) {
      const phi = phi0 + (phiLen * i) / segU;
      pos[n * 3] = r * Math.sin(phi) * inflate;
      pos[n * 3 + 1] = y * inflate;
      pos[n * 3 + 2] = r * Math.cos(phi) * inflate;
      uv[n * 2] = i / segU;
      uv[n * 2 + 1] = j / segV;
      if (col && colors) {
        tmp.copy(colors.bottom).lerp(colors.top, smooth(-0.9, 0.9, y));
        // A pale oval on the lower front.
        const a = Math.atan2(Math.sin(phi), Math.cos(phi));
        const d = Math.hypot(a / 0.82, (y + 0.5) / 0.46);
        tmp.lerp(colors.belly, (1 - smooth(0.55, 1, d)) * 0.9);
        col[n * 3] = tmp.r;
        col[n * 3 + 1] = tmp.g;
        col[n * 3 + 2] = tmp.b;
      }
    }
  }
  const index: number[] = [];
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + 1;
      const c = a + segU + 1;
      const d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  if (col) geo.setAttribute('color', new BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
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
  camera.position.set(0, 0.4, 7.7);
  camera.lookAt(0, 0.22, 0);

  scene.add(new HemisphereLight(0xffffff, 0x8fe3d9, options.light ? 1.5 : 1.3));
  scene.add(new AmbientLight(0xffffff, 0.35));
  const key = new DirectionalLight(0xffffff, 1.7);
  key.position.set(2.2, 4, 5);
  scene.add(key);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);
  const moodColor = new Color(MOOD_COLORS[s.mood]);
  const targetColor = new Color(MOOD_COLORS[s.mood]);
  const glow = track(new MeshBasicMaterial({ color: moodColor }));

  /* ---- buddy ---- */
  const TOP = new Color('#62e8d5');
  const BOTTOM = new Color('#27bfae');
  const buddy = new Group();
  scene.add(buddy);
  const squish = new Group(); // squash-and-stretch happens here, pivoting at the feet
  squish.position.y = -1;
  buddy.add(squish);
  const torso = new Group();
  torso.position.y = 1;
  squish.add(torso);

  const skin = track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, emissive: new Color('#0d5f57'), emissiveIntensity: 0.22 }));
  const limb = track(new MeshStandardMaterial({ color: BOTTOM, roughness: 0.62, emissive: new Color('#0d5f57'), emissiveIntensity: 0.22 }));
  // The angular range starts at the back so the seam of the surface is never in view.
  torso.add(new Mesh(track(blobGeometry(Math.PI, Math.PI * 2, 0, Math.PI, 40, 26, 1, { top: TOP, bottom: BOTTOM, belly: new Color('#f6fffc') })), skin));

  const faceCanvas = document.createElement('canvas');
  faceCanvas.width = 384;
  faceCanvas.height = 256;
  const faceCtx = faceCanvas.getContext('2d')!;
  const faceTexture = track(new CanvasTexture(faceCanvas));
  faceTexture.colorSpace = SRGBColorSpace;
  const face = new Mesh(track(blobGeometry(-1.02, 2.04, 1.22, 1.36, 20, 14, 1.012)), track(new MeshBasicMaterial({ map: faceTexture, transparent: true, depthWrite: false })));
  torso.add(face);

  const earGeo = track(new SphereGeometry(0.27, 16, 12));
  const ears = [-1, 1].map((side) => {
    const pivot = new Group();
    pivot.position.set(side * 0.5, 0.78, -0.02);
    const ear = new Mesh(earGeo, limb);
    ear.position.y = 0.2;
    ear.scale.set(0.82, 1.2, 0.6);
    pivot.add(ear);
    torso.add(pivot);
    return pivot;
  });

  const antenna = new Group();
  antenna.position.set(0, 0.93, 0);
  torso.add(antenna);
  const stalk = new Mesh(track(new CylinderGeometry(0.022, 0.03, 0.5, 8)), track(new MeshStandardMaterial({ color: 0x1c8f84, roughness: 0.6 })));
  stalk.position.y = 0.25;
  antenna.add(stalk);
  const bulb = new Mesh(track(new SphereGeometry(0.105, 16, 12)), glow);
  bulb.position.y = 0.55;
  antenna.add(bulb);

  const handGeo = track(new SphereGeometry(0.18, 16, 12));
  const handL = new Group();
  const handR = new Group();
  handL.add(new Mesh(handGeo, limb));
  handR.add(new Mesh(handGeo, limb));
  torso.add(handL, handR);

  const footGeo = track(new SphereGeometry(0.27, 16, 10));
  for (const side of [-1, 1]) {
    const foot = new Mesh(footGeo, limb);
    foot.position.set(side * 0.44, 0.06, 0.3);
    foot.scale.set(1.05, 0.5, 1.35);
    squish.add(foot);
  }

  // Props
  const hat = new Group();
  hat.position.set(0, 0.66, 0);
  const hatMat = track(new MeshStandardMaterial({ color: 0xffc93c, roughness: 0.45 }));
  const dome = new Mesh(track(new SphereGeometry(0.8, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2)), hatMat);
  dome.scale.set(1, 0.5, 1);
  const brim = new Mesh(track(new CylinderGeometry(0.93, 0.93, 0.05, 28)), hatMat);
  const ridge = new Mesh(track(new BoxGeometry(0.12, 0.08, 1.2)), hatMat);
  ridge.position.y = 0.37;
  hat.add(dome, brim, ridge);
  hat.rotation.x = -0.12;
  torso.add(hat);

  const hammer = new Group();
  const handle = new Mesh(track(new CylinderGeometry(0.04, 0.04, 0.62, 8)), track(new MeshStandardMaterial({ color: 0xb9834f, roughness: 0.8 })));
  handle.position.y = 0.3;
  const head = new Mesh(track(new BoxGeometry(0.2, 0.2, 0.4)), track(new MeshStandardMaterial({ color: 0xd5dbe7, roughness: 0.35, metalness: 0.4 })));
  head.position.y = 0.62;
  hammer.add(handle, head);

  const pencil = new Group();
  const shaft = new Mesh(track(new CylinderGeometry(0.05, 0.05, 0.5, 8)), track(new MeshStandardMaterial({ color: 0xffc93c, roughness: 0.6 })));
  shaft.position.y = -0.25;
  const tip = new Mesh(track(new ConeGeometry(0.05, 0.13, 8)), track(new MeshStandardMaterial({ color: 0x3a3340, roughness: 0.6 })));
  tip.position.y = -0.565;
  tip.rotation.x = Math.PI;
  pencil.add(shaft, tip);

  const lens = new Group();
  const rimMat = track(new MeshStandardMaterial({ color: 0xd5dbe7, roughness: 0.35, metalness: 0.4 }));
  const ring = new Mesh(track(new TorusGeometry(0.22, 0.04, 8, 28)), rimMat);
  ring.position.y = 0.36;
  const glass = new Mesh(track(new CircleGeometry(0.2, 24)), track(new MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.28, depthWrite: false })));
  glass.position.y = 0.36;
  const grip = new Mesh(track(new CylinderGeometry(0.035, 0.035, 0.26, 8)), rimMat);
  grip.position.y = 0.04;
  lens.add(ring, glass, grip);
  handR.add(hammer, pencil, lens);

  const bench = new Group();
  bench.position.set(0.98, -0.72, 0.98);
  const crate = new Mesh(track(new BoxGeometry(0.56, 0.56, 0.56)), track(new MeshStandardMaterial({ color: 0xf0a24a, roughness: 0.7 })));
  const paper = new Mesh(track(new BoxGeometry(0.44, 0.02, 0.34)), track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })));
  paper.position.y = 0.29;
  bench.add(crate, paper);
  buddy.add(bench);

  const shadow = new Mesh(track(new CircleGeometry(0.95, 32)), track(new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: options.light ? 0.14 : 0.26, depthWrite: false })));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.01;
  shadow.scale.set(1, 0.5, 1);
  scene.add(shadow);

  /* ---- dots ---- */
  const dots = new Group();
  scene.add(dots);
  const dotGeo = track(new SphereGeometry(0.26, 20, 14));
  const dotMat = track(new MeshStandardMaterial({ color: moodColor, emissive: moodColor, emissiveIntensity: 0.55, roughness: 0.35 }));
  const dotMeshes = Array.from({ length: 5 }, () => {
    const m = new Mesh(dotGeo, dotMat);
    dots.add(m);
    return m;
  });

  const particles = new Particles(scene);

  const applyStyle = () => {
    buddy.visible = s.style === 'buddy';
    shadow.visible = s.style === 'buddy';
    dots.visible = s.style === 'dots';
    canvas.dataset.style = s.style;
    particles.clear();
  };
  applyStyle();

  const resize = () => {
    const w = canvas.clientWidth || 160;
    const h = canvas.clientHeight || 160;
    // Small on-screen size: 1.5× is visually indistinguishable from 2× and a third fewer pixels.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w > 120 ? 2 : 1.5));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  /* ---- animation state (all scalars; nothing is allocated per frame) ---- */
  let raf = 0;
  let last = 0;
  let frames = 0;
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  let jiggle = 0;
  let jiggleV = 0;
  let antA = 0;
  let antV = 0;
  let hop = 0;
  let spin = 0;
  let lookAt = 0;
  let lookTarget = 0;
  let nextLook = 3;
  let emitAt = 0;
  let lastStrike = 0;
  let faceAt = -1;
  let faceKey = '';
  let hatK = 0;
  let benchK = 0;
  const propK = { build: 0, edit: 0, search: 0 };
  const start = performance.now();

  const impulse = (v: number) => {
    jiggleV += v;
  };

  const frame = (now: number) => {
    if (s.disposed) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || !s.visible || !s.hostVisible) return;
    const lively = s.mood !== 'idle' && s.mood !== 'sleepy';
    // 60 fps only while something lively happens; calm states and unfocused windows need far less.
    const budget = !document.hasFocus() && !lively ? 100 : s.reduced ? 100 : s.mood === 'sleepy' ? 66 : lively || particles.active > 0 || s.reaction ? 15 : 32;
    if (now - last < budget) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = (now - start) / 1000;
    const since = (now - s.moodSince) / 1000;
    const still = s.reduced;
    const k = 1 - Math.pow(0.0015, dt);
    s.energy = Math.max(0, s.energy - dt * 1.6);
    const mood = s.mood;
    const rSince = s.reaction ? (now - s.reactionAt) / 1000 : 99;
    if (s.reaction && rSince > 1.1) s.reaction = undefined;

    targetColor.set(MOOD_COLORS[mood]);
    moodColor.lerp(targetColor, 0.12);
    glow.color.copy(moodColor);
    dotMat.color.copy(moodColor);
    dotMat.emissive.copy(moodColor);

    if (s.style === 'buddy') {
      /* ----- pose targets for the current mood ----- */
      let tYaw = s.pointerX * 0.5;
      let tPitch = s.pointerY * 0.22;
      let tRoll = 0;
      let squash = still ? 0 : Math.sin(t * 2) * 0.018; // breathing
      let lift = 0;
      let earDroop = 0;
      let antTarget = 0;
      let lx = -1.0;
      let ly = -0.28;
      let lz = 0.22;
      let rx = 1.0;
      let ry = -0.28;
      let rz = 0.22;
      let rRotX = 0;
      let rRotZ = 0;
      const working = mood === 'working';
      const kind = s.work;

      // Occasional glance to the side while nothing is happening.
      if (mood === 'idle' && !still) {
        if (t > nextLook) {
          lookTarget = lookTarget === 0 ? rand(-0.5, 0.5) : 0;
          nextLook = t + (lookTarget === 0 ? rand(3.5, 7) : rand(0.8, 1.6));
        }
      } else lookTarget = 0;
      lookAt = lerp(lookAt, lookTarget, k * 0.6);
      tYaw += lookAt;

      switch (mood) {
        case 'listening':
          tPitch = 0.2;
          squash -= 0.02;
          ly = -0.1;
          ry = -0.1;
          lz = rz = 0.55;
          lx = -0.72;
          rx = 0.72;
          break;
        case 'thinking':
          tRoll = 0.14;
          tPitch = -0.12;
          tYaw = -0.18 + Math.sin(t * 0.8) * 0.08;
          rx = 0.5;
          ry = -0.12;
          rz = 0.96; // hand on chin
          antTarget = Math.sin(t * 3) * 0.18;
          break;
        case 'speaking':
          lift = still ? 0 : Math.abs(Math.sin(t * 6)) * 0.035 * (0.4 + s.energy);
          ly = -0.22 + Math.sin(t * 5) * 0.09 * (0.3 + s.energy);
          ry = -0.22 + Math.sin(t * 5 + 2) * 0.09 * (0.3 + s.energy);
          lx = -1.06;
          rx = 1.06;
          break;
        case 'waiting':
          tRoll = 0.16 + Math.sin(t * 2) * 0.04;
          rx = 1.02 + Math.sin(t * 9) * 0.1;
          ry = 0.62;
          rz = 0.3; // waving
          break;
        case 'happy':
        case 'excited': {
          const big = mood === 'excited';
          const dur = big ? 2.6 : 1.3;
          const hopping = since < dur && !still;
          lift = hopping ? Math.abs(Math.sin(since * (big ? 6.2 : 6.6))) * (big ? 0.55 : 0.32) * (1 - (since / dur) * 0.6) : Math.abs(Math.sin(t * 3)) * 0.04;
          ly = ry = hopping ? 0.62 : 0.1;
          lx = -1.02;
          rx = 1.02;
          earDroop = -0.2;
          if (big && hopping && since < 1.05) spin = (since / 1.05) * Math.PI * 2;
          else spin = lerp(spin, 0, 1);
          break;
        }
        case 'sad':
          squash -= 0.07;
          tPitch = 0.22;
          tRoll = Math.sin(t * 1.2) * 0.03;
          earDroop = 1.1;
          antTarget = 1.15;
          ly = ry = -0.42;
          lx = -0.9;
          rx = 0.9;
          break;
        case 'sleepy':
          squash = -0.04 + (still ? 0 : Math.sin(t * 1.3) * 0.03);
          tPitch = 0.16 + (still ? 0 : Math.sin(t * 0.65) * 0.05);
          tRoll = 0.1;
          earDroop = 0.55;
          antTarget = 0.8;
          ly = ry = -0.4;
          tYaw = 0;
          break;
        default:
          break;
      }

      if (working) {
        tYaw = kind === 'search' ? Math.sin(t * 1.3) * 0.5 : 0.32;
        tPitch = kind === 'search' ? 0.02 : 0.16;
        if (kind === 'build') {
          // Raise the hammer, strike the crate, repeat.
          const cycle = (t * 1.9) % 1;
          const raise = cycle < 0.62 ? smooth(0, 0.62, cycle) : 1 - smooth(0.62, 0.76, cycle);
          rRotX = lerp(2.05, -0.55, raise);
          rx = 0.92;
          ry = -0.12 + raise * 0.42;
          rz = 0.5;
          const strike = Math.floor(t * 1.9 + 0.24);
          if (strike !== lastStrike && !still) {
            lastStrike = strike;
            impulse(-0.9);
            for (let i = 0; i < 4; i++) particles.emit('spark', { x: 1.0 + rand(-0.1, 0.1), y: -0.38, z: 1.25, vx: rand(-1.4, 1.4), vy: rand(1, 2.6), ttl: 0.45, size: rand(0.14, 0.24), color: '#ffe27a', gravity: 6, glow: true, spin: 6 });
          }
        } else if (kind === 'edit') {
          rx = 0.96 + Math.sin(t * 15) * 0.13;
          ry = 0.14 + Math.sin(t * 31) * 0.02;
          rz = 0.95 + Math.cos(t * 9) * 0.05;
          rRotX = 0.35;
          rRotZ = -0.25 + Math.sin(t * 15) * 0.12;
        } else {
          rx = 0.5;
          ry = 0.02;
          rz = 1.02; // magnifying glass in front of one eye
          rRotZ = -0.15;
        }
        lx = -0.86;
        ly = -0.12 + (still ? 0 : Math.sin(t * 7) * 0.03);
        lz = 0.5;
      }

      // One-off reactions on top of the mood.
      if (s.reaction === 'poke') {
        tRoll += Math.sin(rSince * 22) * 0.12 * (1 - rSince / 1.1);
      } else if (s.reaction === 'fail') {
        tYaw += Math.sin(rSince * 30) * 0.22 * Math.max(0, 1 - rSince / 0.6);
        squash -= 0.06 * Math.max(0, 1 - rSince / 0.8);
        earDroop = Math.max(earDroop, 0.8 * Math.max(0, 1 - rSince / 1.1));
      } else if (s.reaction === 'success') {
        lift += Math.abs(Math.sin(Math.min(rSince, 0.5) * Math.PI * 2)) * 0.2;
      }

      /* ----- integrate ----- */
      const wasAir = hop > 0.03;
      hop = lerp(hop, lift, Math.min(1, k * 2.2));
      if (wasAir && hop <= 0.03 && lift < 0.03) impulse(-1.1); // landing squash
      // Damped springs give the body and the antenna their wobble.
      jiggleV += (-jiggle * 170 - jiggleV * 9) * dt;
      jiggle += jiggleV * dt;
      antV += ((antTarget - yaw * 0.6 - antA) * 60 - antV * 5) * dt + (yaw - tYaw) * 0.6 * dt;
      antA += antV * dt;

      yaw = lerp(yaw, tYaw, k);
      pitch = lerp(pitch, tPitch, k);
      roll = lerp(roll, tRoll, k);
      const sy = 1 + squash + jiggle * 0.1 + Math.min(0.12, hop * 0.25);
      const sxz = 1 / Math.sqrt(sy);
      squish.scale.set(sxz, sy, sxz);
      buddy.position.y = hop;
      buddy.rotation.y = yaw + spin;
      torso.rotation.set(pitch, 0, roll);
      antenna.rotation.z = antA;
      antenna.rotation.x = mood === 'sad' || mood === 'sleepy' ? 0.5 : 0;
      bulb.scale.setScalar(1 + (mood === 'idle' || mood === 'sleepy' ? 0.1 : 0.32) * Math.abs(Math.sin(t * (mood === 'idle' ? 1.3 : mood === 'sleepy' ? 0.7 : 4.2))));
      hatK = lerp(hatK, working ? 1 : 0, k);
      ears.forEach((ear, i) => {
        const side = i ? 1 : -1;
        ear.rotation.z = lerp(ear.rotation.z, -side * (0.42 + earDroop * 0.9), k);
        ear.rotation.x = lerp(ear.rotation.x, earDroop * 0.25, k);
        ear.scale.setScalar(Math.max(0.001, 1 - hatK));
      });
      hat.scale.setScalar(Math.max(0.001, hatK));
      hat.visible = hatK > 0.02;
      handL.position.set(lerp(handL.position.x, lx, k), lerp(handL.position.y, ly, k), lerp(handL.position.z, lz, k));
      handR.position.set(lerp(handR.position.x, rx, k), lerp(handR.position.y, ry, k), lerp(handR.position.z, rz, k));
      handR.rotation.x = kind === 'build' && working ? rRotX : lerp(handR.rotation.x, rRotX, k);
      handR.rotation.z = lerp(handR.rotation.z, rRotZ, k);
      propK.build = lerp(propK.build, working && kind === 'build' ? 1 : 0, k);
      propK.edit = lerp(propK.edit, working && kind === 'edit' ? 1 : 0, k);
      propK.search = lerp(propK.search, working && kind === 'search' ? 1 : 0, k);
      hammer.scale.setScalar(Math.max(0.001, propK.build));
      pencil.scale.setScalar(Math.max(0.001, propK.edit));
      lens.scale.setScalar(Math.max(0.001, propK.search));
      hammer.visible = propK.build > 0.02;
      pencil.visible = propK.edit > 0.02;
      lens.visible = propK.search > 0.02;
      benchK = lerp(benchK, working && kind !== 'search' ? 1 : 0, k);
      bench.visible = benchK > 0.02;
      bench.scale.set(benchK, benchK * (1 + Math.min(0, jiggle) * 0.25), benchK);
      paper.visible = kind === 'edit';
      shadow.scale.x = 1 - hop * 0.5;
      shadow.scale.y = 0.5 * (1 - hop * 0.5);

      /* ----- particles ----- */
      if (!still && t > emitAt) {
        if (mood === 'excited' && since < 2.2) {
          emitAt = t + 0.07;
          particles.emit('bit', { x: rand(-0.9, 0.9), y: 1.3, z: rand(0.2, 1), vx: rand(-1.6, 1.6), vy: rand(1.6, 3.2), ttl: 1.3, size: rand(0.14, 0.24), color: CONFETTI[(Math.random() * CONFETTI.length) | 0], gravity: 4.2, spin: rand(-8, 8) });
        } else if (mood === 'happy' && since < 1.3) {
          emitAt = t + 0.16;
          particles.emit('spark', { x: rand(-1.2, 1.2), y: rand(0.4, 1.5), vy: 0.5, ttl: 0.7, size: rand(0.16, 0.28), color: '#fff3a8', glow: true, spin: 3 });
        } else if (mood === 'sleepy') {
          emitAt = t + 1.5;
          particles.emit('zed', { x: 0.62, y: 1.0, vx: 0.22, vy: 0.42, ttl: 2.4, size: 0.2, grow: 2, color: '#c9d0f2' });
        } else if (mood === 'thinking') {
          emitAt = t + 0.5;
          particles.emit('dot', { x: 0.55 + rand(-0.05, 0.05), y: 1.25, vx: 0.12, vy: 0.55, ttl: 1.4, size: 0.09, grow: 2.4, color: moodColor });
        } else if (mood === 'waiting') {
          emitAt = t + 2.2;
          particles.emit('ask', { x: 0.95, y: 1.25, vy: 0.22, ttl: 1.9, size: 0.42, color: '#ffd166' });
        } else if (mood === 'sad') {
          emitAt = t + 0.9;
          particles.emit('drop', { x: rand(-0.5, 0.5) > 0 ? 0.42 : -0.42, y: 0.1, z: 1.05, vy: -0.2, ttl: 0.9, size: 0.13, color: '#8fd3ff', gravity: 2.2 });
        }
      }

      /* ----- face: redraw only when something on it changes ----- */
      const blink = still ? 1 : blinkAt(t);
      const animated = mood !== 'idle' && mood !== 'listening' && mood !== 'happy';
      const gazeX = clamp(s.pointerX - yaw * 0.5, -1, 1);
      const key2 = `${s.reaction === 'poke' ? 'happy' : s.reaction === 'fail' ? 'sad' : mood}|${blink < 1 ? blink.toFixed(1) : 1}|${gazeX.toFixed(1)}|${s.pointerY.toFixed(1)}`;
      if (key2 !== faceKey || (animated && !still && t - faceAt > 0.05)) {
        faceKey = key2;
        faceAt = t;
        drawFace(faceCtx, faceCanvas.width, faceCanvas.height, { mood: s.reaction === 'poke' ? 'happy' : s.reaction === 'fail' ? 'sad' : mood, t, gazeX, gazeY: s.pointerY, energy: s.energy, blink });
        faceTexture.needsUpdate = true;
      }
    } else {
      /* ----- dots: one formation per mood, positions eased towards it ----- */
      const n = dotMeshes.length;
      const since2 = since;
      for (let i = 0; i < n; i++) {
        const u = i - (n - 1) / 2; // -2..2
        let x = u * 0.72;
        let y = 0.25;
        let z = 0;
        let sc = 1;
        let scY = 1;
        const tt = still ? 0 : t;
        switch (s.mood) {
          case 'idle':
            y += u * u * 0.06 - 0.12 + Math.sin(tt * 1.6 + i * 0.5) * 0.05; // a soft smile that breathes
            break;
          case 'listening':
            y += Math.sin(tt * 6 + i * 0.9) * 0.05 * (1 + s.energy);
            sc = 0.9;
            break;
          case 'thinking': {
            const a = tt * 3 + (i * Math.PI * 2) / n;
            x = Math.cos(a) * 0.95;
            y = 0.25 + Math.sin(a) * 0.95;
            sc = 0.8 + 0.25 * Math.sin(a - tt * 3 + 1.2);
            break;
          }
          case 'speaking':
            scY = 1 + (0.6 + 1.9 * s.energy) * Math.abs(Math.sin(tt * (7 + i * 1.3) + i * 1.7));
            sc = 0.85;
            break;
          case 'working': {
            // A little conveyor: dots travel along a rounded track.
            const a = tt * 4.5 - i * 0.55;
            x = Math.cos(a) * 1.25;
            y = 0.25 + Math.sin(a * 2) * 0.32;
            z = Math.sin(a) * 0.6;
            sc = 0.75 + 0.2 * Math.sin(a);
            break;
          }
          case 'waiting':
            y += Math.max(0, Math.sin(tt * 5 - i * 0.7)) * 0.42;
            break;
          case 'happy':
          case 'excited': {
            const burst = since2 < 0.5 ? 1 + Math.sin((since2 / 0.5) * Math.PI) * 0.9 : 1;
            x = clamp(x * burst, -1.75, 1.75);
            y += Math.abs(u) * Math.abs(u) * 0.11 * 1 - 0.2 + Math.abs(Math.sin(tt * 6 + i)) * (s.mood === 'excited' ? 0.34 : 0.16); // a grin that bounces
            sc = 1.05;
            break;
          }
          case 'sad':
            y += -0.45 + Math.abs(u) * Math.abs(u) * -0.1 + 0.2;
            y -= 0.25;
            sc = 0.82;
            break;
          case 'sleepy':
            sc = 0.7 + 0.18 * Math.sin(tt * 1.2 - i * 0.6);
            y -= 0.2;
            break;
        }
        const d = dotMeshes[i];
        d.position.set(lerp(d.position.x, x, k), lerp(d.position.y, y, k), lerp(d.position.z, z, k));
        d.scale.set(lerp(d.scale.x, sc, k), lerp(d.scale.y, sc * scY, k), lerp(d.scale.z, sc, k));
      }
      dots.rotation.y = s.pointerX * 0.35;
      dots.rotation.x = s.pointerY * 0.2;
      dotMat.emissiveIntensity = s.mood === 'sad' || s.mood === 'sleepy' ? 0.2 : 0.55;
      if (!still && s.mood === 'excited' && since < 2 && t > emitAt) {
        emitAt = t + 0.08;
        particles.emit('bit', { x: rand(-1.4, 1.4), y: 0.8, vx: rand(-1.4, 1.4), vy: rand(1.4, 3), ttl: 1.2, size: rand(0.14, 0.22), color: CONFETTI[(Math.random() * CONFETTI.length) | 0], gravity: 4.2, spin: rand(-8, 8) });
      }
    }

    particles.update(dt);
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
      spin = 0;
      emitAt = 0;
      canvas.dataset.mood = mood;
    },
    setWork(kind) {
      s.work = kind;
      canvas.dataset.work = kind;
    },
    setStyle(style) {
      s.style = style;
      applyStyle();
    },
    react(kind) {
      s.reaction = kind;
      s.reactionAt = performance.now();
      canvas.dataset.reaction = kind;
      if (s.reduced) return;
      if (kind === 'poke') {
        impulse(2.4);
        for (let i = 0; i < 4; i++) particles.emit('heart', { x: rand(-0.7, 0.7), y: rand(0.7, 1.2), vx: rand(-0.3, 0.3), vy: rand(0.6, 1.1), ttl: 1.1, size: rand(0.2, 0.3), color: '#ff7d9c' });
      } else if (kind === 'success') {
        for (let i = 0; i < 5; i++) particles.emit('spark', { x: rand(-1, 1), y: rand(0.5, 1.4), vx: rand(-0.4, 0.4), vy: rand(0.4, 1), ttl: 0.7, size: rand(0.16, 0.26), color: '#b9ffcc', glow: true, spin: 4 });
      } else {
        impulse(-1.6);
        particles.emit('drop', { x: 0.8, y: 0.9, vy: -0.3, ttl: 0.8, size: 0.16, color: '#8fd3ff', gravity: 2 });
      }
    },
    pulse() {
      s.energy = Math.min(1, s.energy + 0.35);
    },
    dispose() {
      cancelAnimationFrame(raf);
      cleanup();
      ro.disconnect();
      particles.dispose();
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
  face.height = 256;
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
    const since = (now - s.moodSince) / 1000;
    const r = Math.min(w, h) * 0.33;
    const hopping = (s.mood === 'happy' || s.mood === 'excited') && since < 1.6;
    const cy = h * 0.56 - (hopping ? Math.abs(Math.sin(since * 6.4)) * r * 0.3 : 0) + Math.sin(t * 2) * r * 0.02;
    g.clearRect(0, 0, w, h);
    if (s.style === 'dots') {
      g.fillStyle = MOOD_COLORS[s.mood];
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.arc(w / 2 + (i - 2) * r * 0.5, cy + Math.sin(t * 3 + i) * r * 0.12, r * 0.17, 0, Math.PI * 2);
        g.fill();
      }
      return;
    }
    const grad = g.createLinearGradient(0, cy - r, 0, cy + r);
    grad.addColorStop(0, '#62e8d5');
    grad.addColorStop(1, '#27bfae');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(w / 2, cy, r * 1.08, r * (s.mood === 'sad' ? 0.9 : 0.97), 0, 0, Math.PI * 2);
    g.fill();
    drawFace(fg, face.width, face.height, { mood: s.mood, t, gazeX: s.pointerX, gazeY: s.pointerY, energy: s.energy, blink: s.reduced ? 1 : blinkAt(t) });
    g.drawImage(face, w / 2 - r * 0.98 + s.pointerX * r * 0.06, cy - r * 0.72, r * 1.96, r * 1.3);
  };
  raf = requestAnimationFrame(frame);
  return {
    renderer: '2d',
    setMood(mood) {
      s.mood = mood;
      s.moodSince = performance.now();
      canvas.dataset.mood = mood;
    },
    setWork(kind) {
      s.work = kind;
      canvas.dataset.work = kind;
    },
    setStyle(style) {
      s.style = style;
      canvas.dataset.style = style;
    },
    react(kind) {
      canvas.dataset.reaction = kind;
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

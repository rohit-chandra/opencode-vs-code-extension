export type Mood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'waiting' | 'happy' | 'excited' | 'sad' | 'sleepy';
/** What the agent is doing while "working"; picks the prop Oki holds. */
export type WorkKind = 'build' | 'edit' | 'search';
export type Reaction = 'success' | 'fail' | 'poke';

export const MOOD_COLORS: Record<Mood, string> = {
  idle: '#42e0cf',
  listening: '#6cc8ff',
  thinking: '#ffb84d',
  speaking: '#42e0cf',
  working: '#a394ff',
  waiting: '#ffd166',
  happy: '#7df29a',
  excited: '#ff9ad5',
  sad: '#7f9ac9',
  sleepy: '#9aa3c7',
};

export interface FaceParams {
  mood: Mood;
  /** Seconds since start. */
  t: number;
  /** Gaze offset, each in -1..1. */
  gazeX: number;
  gazeY: number;
  /** 0..1, how lively the mouth is while speaking. */
  energy: number;
  /** 0 (closed) .. 1 (open). */
  blink: number;
}

const INK = '#172033';
const TONGUE = '#ff8fa8';
const BLUSH = '#ff6f96';
const TEAR = '#8fd3ff';

function ellipse(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
}

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, rot = 0): void {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = rot + (i * Math.PI) / 4;
    const rr = i % 2 === 0 ? r : r * 0.32;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

/**
 * Draw Oki's face on a transparent canvas: big glossy eyes, brows, blush and a mouth that
 * change with the mood. Used as a decal on the 3D body and directly by the 2D fallback.
 */
export function drawFace(g: CanvasRenderingContext2D, w: number, h: number, p: FaceParams): void {
  g.clearRect(0, 0, w, h);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const { mood, t } = p;
  let gx = p.gazeX;
  let gy = p.gazeY;
  if (mood === 'thinking') {
    gx = -0.7 + Math.sin(t * 0.8) * 0.15;
    gy = -0.8;
  } else if (mood === 'listening') {
    gy = Math.max(gy, 0.55);
  } else if (mood === 'working') {
    gy = 0.5;
    gx = 0.35;
  } else if (mood === 'sad') {
    gy = 0.6;
  }
  const cx = w / 2 + gx * w * 0.035;
  const cy = h * 0.45 + gy * h * 0.04;
  const gap = w * 0.2;
  const big = mood === 'waiting' ? 1.14 : mood === 'listening' ? 1.07 : mood === 'excited' ? 1.1 : 1;
  const rx = w * 0.104 * big;
  const ry = h * 0.205 * big;

  // Blush
  const blush = mood === 'happy' || mood === 'excited' ? 0.9 : mood === 'sad' || mood === 'sleepy' ? 0.4 : mood === 'waiting' ? 0.75 : 0.6;
  g.fillStyle = BLUSH;
  g.globalAlpha = blush;
  for (const side of [-1, 1]) {
    ellipse(g, cx + side * gap * 1.5, cy + h * 0.2, w * 0.07, h * 0.05);
    g.fill();
  }
  g.globalAlpha = 1;

  const eye = (x: number, side: -1 | 1) => {
    g.fillStyle = INK;
    g.strokeStyle = INK;
    if (mood === 'happy' || (mood === 'idle' && p.blink < 0.25) || (mood === 'speaking' && p.blink < 0.25)) {
      // Smiling or blinking: a curved line that bulges upward.
      g.lineWidth = w * 0.03;
      g.beginPath();
      g.arc(x, cy + ry * 0.45, rx * 1.05, Math.PI * 1.12, Math.PI * 1.88);
      g.stroke();
      return;
    }
    if (mood === 'sleepy') {
      g.lineWidth = w * 0.028;
      g.beginPath();
      g.arc(x, cy - ry * 0.2, rx, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      return;
    }
    const open = mood === 'excited' || mood === 'waiting' ? Math.max(p.blink, 0.9) : p.blink;
    const ey = ry * Math.max(0.1, open);
    ellipse(g, x, cy, rx, ey);
    g.fill();
    if (open > 0.45) {
      g.fillStyle = '#ffffff';
      if (mood === 'excited') {
        star(g, x - rx * 0.1, cy - ey * 0.12, rx * (0.72 + 0.12 * Math.sin(t * 9 + side)), t * 1.5);
        g.fill();
        ellipse(g, x + rx * 0.42, cy + ey * 0.5, rx * 0.14, rx * 0.14);
        g.fill();
      } else {
        const shimmer = mood === 'waiting' ? 1 + 0.12 * Math.sin(t * 5) : 1;
        ellipse(g, x - rx * 0.3 + gx * rx * 0.25, cy - ey * 0.36 + gy * ey * 0.15, rx * 0.36 * shimmer, rx * 0.36 * shimmer);
        g.fill();
        ellipse(g, x + rx * 0.34 + gx * rx * 0.2, cy + ey * 0.38, rx * 0.17 * shimmer, rx * 0.17 * shimmer);
        g.fill();
        if (mood === 'waiting') {
          ellipse(g, x + rx * 0.05, cy + ey * 0.05, rx * 0.1, rx * 0.1);
          g.fill();
        }
      }
    }
    // Eyelids are cut out of the eye so they work on any body colour.
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    if (mood === 'working') {
      g.translate(x, cy - ey * 0.95);
      g.rotate(side * 0.34);
      g.fillRect(-rx * 2, -ey, rx * 4, ey * 0.95);
    } else if (mood === 'sad') {
      g.translate(x, cy - ey * 1.02);
      g.rotate(side * -0.36);
      g.fillRect(-rx * 2, -ey, rx * 4, ey * 0.98);
    } else if (mood === 'thinking' && side === 1) {
      g.fillRect(x - rx * 2, cy - ey * 2, rx * 4, ey * 1.3);
    }
    g.restore();
  };
  eye(cx - gap, -1);
  eye(cx + gap, 1);

  // Brows
  g.strokeStyle = INK;
  g.lineWidth = w * 0.024;
  const brow = (side: -1 | 1, lift: number, angle: number) => {
    const x = cx + side * gap;
    const y = cy - ry * 1.22 - lift * h;
    g.save();
    g.translate(x, y);
    g.rotate(side * angle);
    g.beginPath();
    g.moveTo(-rx * 0.75, 0);
    g.quadraticCurveTo(0, -h * 0.018, rx * 0.75, 0);
    g.stroke();
    g.restore();
  };
  if (mood === 'working') {
    brow(-1, -0.035, -0.42);
    brow(1, -0.035, -0.42);
  } else if (mood === 'sad') {
    brow(-1, 0.0, 0.42);
    brow(1, 0.0, 0.42);
  } else if (mood === 'thinking') {
    brow(-1, 0.035, 0.1);
    brow(1, -0.01, -0.2);
  } else if (mood === 'waiting' || mood === 'listening' || mood === 'excited') {
    brow(-1, 0.03, 0.14);
    brow(1, 0.03, 0.14);
  }

  // Tears and sweat
  if (mood === 'sad') {
    g.fillStyle = TEAR;
    for (const side of [-1, 1]) {
      const fall = (t * 0.55 + (side > 0 ? 0.45 : 0)) % 1;
      const x = cx + side * (gap + rx * 0.35);
      const y = cy + ry * 0.75 + fall * h * 0.24;
      g.globalAlpha = 1 - fall * 0.7;
      g.beginPath();
      g.moveTo(x, y - h * 0.045);
      g.quadraticCurveTo(x + w * 0.03, y + h * 0.015, x, y + h * 0.03);
      g.quadraticCurveTo(x - w * 0.03, y + h * 0.015, x, y - h * 0.045);
      g.fill();
    }
    g.globalAlpha = 1;
  }
  if (mood === 'working' && (t % 3.2) < 1.4) {
    const fall = (t % 3.2) / 1.4;
    g.fillStyle = TEAR;
    g.globalAlpha = 1 - fall;
    const x = cx + gap * 1.75;
    const y = cy - ry * 0.9 + fall * h * 0.16;
    g.beginPath();
    g.moveTo(x, y - h * 0.04);
    g.quadraticCurveTo(x + w * 0.026, y + h * 0.012, x, y + h * 0.026);
    g.quadraticCurveTo(x - w * 0.026, y + h * 0.012, x, y - h * 0.04);
    g.fill();
    g.globalAlpha = 1;
  }

  // Mouth
  const mx = cx + (mood === 'thinking' ? w * 0.03 : 0);
  const my = h * 0.76 + gy * h * 0.02;
  g.strokeStyle = INK;
  g.fillStyle = INK;
  g.lineWidth = w * 0.022;
  const openMouth = (mw: number, mh: number) => {
    // A "D" shaped open mouth with a tongue.
    g.beginPath();
    g.moveTo(mx - mw, my - mh * 0.25);
    g.quadraticCurveTo(mx, my - mh * 0.05, mx + mw, my - mh * 0.25);
    g.bezierCurveTo(mx + mw * 0.95, my + mh * 1.1, mx - mw * 0.95, my + mh * 1.1, mx - mw, my - mh * 0.25);
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = TONGUE;
    ellipse(g, mx, my + mh * 0.95, mw * 0.62, mh * 0.5);
    g.fill();
    g.restore();
  };
  switch (mood) {
    case 'speaking': {
      const open = 0.25 + 0.75 * Math.abs(Math.sin(t * 9.5)) * (0.45 + 0.55 * p.energy);
      ellipse(g, mx, my + h * 0.01, w * (0.04 + 0.012 * (1 - open)), h * (0.02 + 0.065 * open));
      g.fill();
      if (open > 0.5) {
        g.fillStyle = TONGUE;
        ellipse(g, mx, my + h * (0.035 + 0.03 * open), w * 0.026, h * 0.022);
        g.fill();
      }
      break;
    }
    case 'happy':
      openMouth(w * 0.07, h * 0.09);
      break;
    case 'excited':
      openMouth(w * 0.085, h * (0.115 + 0.015 * Math.sin(t * 12)));
      break;
    case 'sad': {
      const wob = Math.sin(t * 7) * h * 0.006;
      g.beginPath();
      g.moveTo(mx - w * 0.05, my + h * 0.035);
      g.quadraticCurveTo(mx - w * 0.02, my - h * 0.03 + wob, mx, my - h * 0.012);
      g.quadraticCurveTo(mx + w * 0.02, my - h * 0.03 - wob, mx + w * 0.05, my + h * 0.035);
      g.stroke();
      break;
    }
    case 'thinking':
      g.beginPath();
      g.moveTo(mx - w * 0.035, my + h * 0.005);
      g.quadraticCurveTo(mx - w * 0.01, my - h * 0.02, mx + w * 0.012, my + h * 0.005);
      g.quadraticCurveTo(mx + w * 0.028, my + h * 0.02, mx + w * 0.045, my);
      g.stroke();
      break;
    case 'working':
      g.beginPath();
      g.moveTo(mx - w * 0.04, my);
      g.lineTo(mx + w * 0.04, my);
      g.stroke();
      g.fillStyle = TONGUE;
      ellipse(g, mx + w * 0.03, my + h * 0.022, w * 0.022, h * 0.03);
      g.fill();
      break;
    case 'waiting':
    case 'listening':
      ellipse(g, mx, my, w * 0.02, h * (mood === 'waiting' ? 0.03 : 0.022));
      g.fill();
      break;
    case 'sleepy': {
      const breathe = 0.6 + 0.4 * Math.sin(t * 1.3);
      ellipse(g, mx, my, w * 0.016 * breathe, h * 0.022 * breathe);
      g.fill();
      break;
    }
    default:
      g.beginPath();
      g.arc(mx, my - h * 0.05, w * 0.055, Math.PI * 0.2, Math.PI * 0.8);
      g.stroke();
  }
}

/** Blink roughly every four seconds; returns eye openness 0..1. */
export function blinkAt(t: number): number {
  const phase = (t + 1.3) % 4.3;
  if (phase > 0.18) return 1;
  return Math.abs(phase - 0.09) / 0.09;
}

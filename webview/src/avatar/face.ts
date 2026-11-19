export type Mood = 'idle' | 'thinking' | 'speaking' | 'tool' | 'waiting' | 'error' | 'happy';

export const MOOD_COLORS: Record<Mood, string> = {
  idle: '#42e0cf',
  thinking: '#ffb84d',
  speaking: '#42e0cf',
  tool: '#a394ff',
  waiting: '#ffd166',
  error: '#ff6b6b',
  happy: '#7df29a',
};

export interface FaceParams {
  mood: Mood;
  /** Seconds since start; drives blinking and mouth animation. */
  t: number;
  /** Gaze offset, each in -1..1. */
  gazeX: number;
  gazeY: number;
  /** 0..1, how lively the mouth meter is while speaking. */
  energy: number;
  color: string;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Blink roughly every 4 s; returns eye openness 0..1. */
function blink(t: number): number {
  const phase = (t + 1.3) % 4.2;
  if (phase > 0.16) return 1;
  return Math.abs(phase - 0.08) / 0.08;
}

/**
 * Draw Oki's visor: a dark glass panel with two eyes and a small mouth that change with the
 * mood. Pure 2D canvas, used as a texture on the 3D head and directly by the 2D fallback.
 */
export function drawFace(g: CanvasRenderingContext2D, w: number, h: number, p: FaceParams): void {
  g.clearRect(0, 0, w, h);
  const pad = w * 0.035;
  roundRect(g, pad, pad, w - pad * 2, h - pad * 2, h * 0.42);
  const glass = g.createLinearGradient(0, 0, 0, h);
  glass.addColorStop(0, '#1b2233');
  glass.addColorStop(1, '#0a0e17');
  g.fillStyle = glass;
  g.fill();
  // Soft sheen across the top-left of the glass.
  g.save();
  g.clip();
  const sheen = g.createLinearGradient(0, 0, w * 0.7, h * 0.9);
  sheen.addColorStop(0, 'rgba(255,255,255,0.16)');
  sheen.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, w, h * 0.6);
  g.restore();

  const cx = w / 2 + p.gazeX * w * 0.045;
  const cy = h * 0.44 + p.gazeY * h * 0.07;
  const gap = w * 0.17;
  const ew = w * 0.085;
  let eh = h * 0.27;
  g.fillStyle = p.color;
  g.strokeStyle = p.color;
  g.lineCap = 'round';
  g.shadowColor = p.color;
  g.shadowBlur = w * 0.05;

  const eye = (x: number, side: -1 | 1) => {
    switch (p.mood) {
      case 'happy': {
        g.lineWidth = w * 0.03;
        g.beginPath();
        g.arc(x, cy + h * 0.07, ew * 1.05, Math.PI * 1.12, Math.PI * 1.88);
        g.stroke();
        return;
      }
      case 'error': {
        g.lineWidth = w * 0.028;
        g.beginPath();
        g.moveTo(x - ew, cy - side * h * 0.05);
        g.lineTo(x + ew, cy + side * h * 0.05);
        g.stroke();
        return;
      }
      case 'thinking': {
        // Eyes narrow and scan from side to side.
        const scan = Math.sin(p.t * 2.2) * w * 0.035;
        roundRect(g, x - ew * 0.75 + scan, cy - eh * 0.2, ew * 1.5, eh * 0.4, ew);
        g.fill();
        return;
      }
      case 'tool': {
        // Focused: slanted lids.
        g.save();
        g.translate(x, cy);
        g.rotate(side * -0.22);
        roundRect(g, -ew, -eh * 0.28, ew * 2, eh * 0.56, ew * 0.5);
        g.fill();
        g.restore();
        return;
      }
      case 'waiting': {
        const pulse = 1 + Math.sin(p.t * 3) * 0.06;
        g.beginPath();
        g.ellipse(x, cy, ew * 1.15 * pulse, eh * 0.55 * pulse, 0, 0, Math.PI * 2);
        g.fill();
        return;
      }
      default: {
        const open = blink(p.t);
        const hh = Math.max(h * 0.025, eh * open);
        roundRect(g, x - ew, cy - hh / 2, ew * 2, hh, ew);
        g.fill();
      }
    }
  };
  if (p.mood === 'speaking') eh *= 0.9 + p.energy * 0.15;
  eye(cx - gap, -1);
  eye(cx + gap, 1);

  // Mouth
  const my = h * 0.74 + p.gazeY * h * 0.03;
  g.shadowBlur = w * 0.03;
  if (p.mood === 'speaking') {
    const bars = 5;
    const bw = w * 0.022;
    const spacing = w * 0.04;
    for (let i = 0; i < bars; i++) {
      const wave = 0.35 + 0.65 * Math.abs(Math.sin(p.t * (7 + i * 1.7) + i * 1.3));
      const bh = h * (0.03 + 0.13 * wave * (0.35 + 0.65 * p.energy));
      roundRect(g, cx + (i - (bars - 1) / 2) * spacing - bw / 2, my - bh / 2, bw, bh, bw / 2);
      g.fill();
    }
  } else if (p.mood === 'happy') {
    g.lineWidth = w * 0.022;
    g.beginPath();
    g.arc(cx, my - h * 0.06, w * 0.06, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
  } else if (p.mood === 'error') {
    g.lineWidth = w * 0.02;
    g.beginPath();
    g.arc(cx, my + h * 0.06, w * 0.05, Math.PI * 1.2, Math.PI * 1.8);
    g.stroke();
  } else if (p.mood === 'waiting') {
    g.beginPath();
    g.arc(cx, my, w * 0.016, 0, Math.PI * 2);
    g.fill();
  } else {
    g.globalAlpha = 0.75;
    roundRect(g, cx - w * 0.035, my - h * 0.012, w * 0.07, h * 0.024, h * 0.012);
    g.fill();
    g.globalAlpha = 1;
  }
  g.shadowBlur = 0;
}

import { AdditiveBlending, CanvasTexture, NormalBlending, Sprite, SpriteMaterial } from 'three';
import type { Color, Object3D, Texture } from 'three';

export type ParticleKind = 'spark' | 'heart' | 'zed' | 'bit' | 'dot' | 'ask' | 'drop';

function icon(draw: (g: CanvasRenderingContext2D, s: number) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  draw(g, 64);
  return new CanvasTexture(c);
}

function makeTextures(): Record<ParticleKind, Texture> {
  return {
    spark: icon((g, s) => {
      g.fillStyle = '#fff';
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const r = i % 2 === 0 ? s * 0.48 : s * 0.13;
        g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
      }
      g.fill();
    }),
    heart: icon((g, s) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(s * 0.5, s * 0.86);
      g.bezierCurveTo(s * 0.02, s * 0.5, s * 0.16, s * 0.1, s * 0.5, s * 0.32);
      g.bezierCurveTo(s * 0.84, s * 0.1, s * 0.98, s * 0.5, s * 0.5, s * 0.86);
      g.fill();
    }),
    zed: icon((g, s) => {
      g.strokeStyle = '#fff';
      g.lineWidth = s * 0.13;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(s * 0.24, s * 0.24);
      g.lineTo(s * 0.76, s * 0.24);
      g.lineTo(s * 0.24, s * 0.76);
      g.lineTo(s * 0.76, s * 0.76);
      g.stroke();
    }),
    bit: icon((g, s) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.roundRect(s * 0.2, s * 0.3, s * 0.6, s * 0.4, s * 0.08);
      g.fill();
    }),
    dot: icon((g, s) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2);
      g.fill();
    }),
    ask: icon((g, s) => {
      g.fillStyle = '#fff';
      g.font = `900 ${s * 0.9}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('?', s / 2, s * 0.54);
    }),
    drop: icon((g, s) => {
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(s * 0.5, s * 0.1);
      g.quadraticCurveTo(s * 0.9, s * 0.62, s * 0.5, s * 0.9);
      g.quadraticCurveTo(s * 0.1, s * 0.62, s * 0.5, s * 0.1);
      g.fill();
    }),
  };
}

interface Particle {
  sprite: Sprite;
  life: number;
  ttl: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  size: number;
  spin: number;
  grow: number;
}

export interface EmitOptions {
  x: number;
  y: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  ttl?: number;
  size?: number;
  color?: string | number | Color;
  gravity?: number;
  spin?: number;
  /** Size multiplier reached at the end of life (1 = constant). */
  grow?: number;
  glow?: boolean;
}

/** A small fixed pool of sprites for confetti, sparks, hearts and sleepy z's. No allocation while running. */
export class Particles {
  private pool: Particle[] = [];
  private textures = makeTextures();
  private next = 0;
  active = 0;

  constructor(parent: Object3D, count = 28) {
    for (let i = 0; i < count; i++) {
      const sprite = new Sprite(new SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0 }));
      sprite.visible = false;
      parent.add(sprite);
      this.pool.push({ sprite, life: 0, ttl: 0, vx: 0, vy: 0, vz: 0, gravity: 0, size: 0.2, spin: 0, grow: 1 });
    }
  }

  emit(kind: ParticleKind, o: EmitOptions): void {
    const p = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    const m = p.sprite.material;
    m.map = this.textures[kind];
    m.color.set(o.color ?? 0xffffff);
    m.blending = o.glow ? AdditiveBlending : NormalBlending;
    m.rotation = Math.random() * (o.spin ? Math.PI * 2 : 0);
    m.needsUpdate = true;
    p.sprite.position.set(o.x, o.y, o.z ?? 0.9);
    p.sprite.visible = true;
    p.life = 0;
    p.ttl = o.ttl ?? 1;
    p.vx = o.vx ?? 0;
    p.vy = o.vy ?? 0;
    p.vz = o.vz ?? 0;
    p.gravity = o.gravity ?? 0;
    p.size = o.size ?? 0.2;
    p.spin = o.spin ?? 0;
    p.grow = o.grow ?? 1;
  }

  /** @returns number of live particles */
  update(dt: number): number {
    let live = 0;
    for (const p of this.pool) {
      if (!p.sprite.visible) continue;
      p.life += dt;
      const k = p.life / p.ttl;
      if (k >= 1) {
        p.sprite.visible = false;
        continue;
      }
      live++;
      p.vy -= p.gravity * dt;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const size = p.size * (1 + (p.grow - 1) * k) * Math.min(1, k * 8);
      p.sprite.scale.set(size, size, 1);
      p.sprite.material.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      p.sprite.material.rotation += p.spin * dt;
    }
    this.active = live;
    return live;
  }

  clear(): void {
    for (const p of this.pool) p.sprite.visible = false;
    this.active = 0;
  }

  dispose(): void {
    for (const p of this.pool) p.sprite.material.dispose();
    for (const t of Object.values(this.textures)) t.dispose();
  }
}

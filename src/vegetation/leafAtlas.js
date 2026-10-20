import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';
import { Rng } from '../core/random.js';

// Regions of the atlas in normalised coordinates [u0, v0, u1, v1], v up.
export const ATLAS = {
  broadleaf: [0, 0.5, 0.5, 1],
  droop: [0.5, 0.5, 1, 1],
  palm: [0, 0, 0.25, 0.5],
  fern: [0.25, 0, 0.5, 0.5],
  banana: [0.5, 0, 0.75, 0.5],
  smallLeaves: [0.75, 0.25, 1, 0.5],
  reeds: [0.75, 0, 0.875, 0.25],
  vine: [0.875, 0, 1, 0.25],
};

function hsl(h, s, l, a = 1) {
  return `hsla(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%, ${a})`;
}

// Leaf greens: dark, slightly varied, a few yellow-olive and blue-green ones.
function leafColor(rng, light = 0) {
  const h = rng.range(92, 132) + (rng.chance(0.1) ? rng.range(-25, -10) : 0);
  const s = rng.range(32, 58);
  const l = rng.range(13, 25) + light;
  return [h, s, l];
}

// One leaf with blade gradient, midrib and lateral veins. Leaf points along +y
// in local space from its petiole at the origin.
function drawLeaf(ctx, rng, x, y, angle, length, width, opts = {}) {
  const { tip = 0.55, droop = 0, light = 0, veins = true, base = 0.18 } = opts;
  const [h, s, l] = opts.color ?? leafColor(rng, light);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const L = length;
  const W = width;
  const bend = droop * L;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(W * 0.9, L * base, W * 1.05 + bend * 0.3, L * tip, bend, L);
  ctx.bezierCurveTo(-W * 1.05 + bend * 0.3, L * tip, -W * 0.9, L * base, 0, 0);
  ctx.closePath();
  const grad = ctx.createLinearGradient(-W, 0, W, L);
  grad.addColorStop(0, hsl(h, s, l * 0.75));
  grad.addColorStop(0.5, hsl(h + 2, s + 4, l * 1.05));
  grad.addColorStop(1, hsl(h + 5, s, l * 0.9));
  ctx.fillStyle = grad;
  ctx.fill();
  // Darker edge for some depth.
  ctx.lineWidth = Math.max(1, W * 0.05);
  ctx.strokeStyle = hsl(h, s, l * 0.55, 0.6);
  ctx.stroke();
  // Veins stay inside the blade.
  ctx.clip();
  if (veins) {
    ctx.strokeStyle = hsl(h + 8, s - 10, l * 1.55, 0.75);
    ctx.lineWidth = Math.max(1, W * 0.07);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(bend * 0.4, L * 0.5, bend, L * 0.97);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.6, W * 0.03);
    ctx.strokeStyle = hsl(h + 6, s - 8, l * 1.3, 0.45);
    const n = Math.max(3, Math.round(L / (W * 0.45)));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const cx = bend * t * t;
      const cy = L * t;
      const reach = W * Math.sin(Math.PI * Math.min(t * 1.05, 1)) * 0.85;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx + side * reach * 0.5, cy + L * 0.03, cx + side * reach, cy + L * 0.09);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function twig(ctx, x0, y0, x1, y1, w, color = 'rgba(52, 40, 26, 1)') {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo((x0 + x1) / 2 + (y1 - y0) * 0.08, (y0 + y1) / 2, x1, y1);
  ctx.stroke();
}

// Converts an atlas region to canvas pixels; canvas y grows downwards.
function regionRect(region, size) {
  const [u0, v0, u1, v1] = region;
  return { x: u0 * size, y: (1 - v1) * size, w: (u1 - u0) * size, h: (v1 - v0) * size };
}

function paintBroadleaf(ctx, r, rng) {
  // A leafy twig cluster: branchlets spray from the lower middle.
  const cx = r.x + r.w * 0.5;
  const cy = r.y + r.h * 0.94;
  const sprays = 7;
  for (let layer = 0; layer < 2; layer++) {
    for (let i = 0; i < sprays; i++) {
      const a = -Math.PI / 2 + (i / (sprays - 1) - 0.5) * 1.9 + rng.range(-0.12, 0.12);
      const len = r.h * rng.range(0.36, 0.5);
      const ex = cx + Math.cos(a) * len;
      const ey = cy + Math.sin(a) * len;
      twig(ctx, cx, cy, ex, ey, r.w * 0.008);
      const leaves = rng.int(4, 6);
      for (let k = 0; k < leaves; k++) {
        const t = 0.35 + (k / leaves) * 0.65;
        const lx = cx + (ex - cx) * t;
        const ly = cy + (ey - cy) * t;
        const side = k % 2 === 0 ? 1 : -1;
        const la = a + Math.PI / 2 + side * rng.range(0.5, 1.1);
        const ll = r.w * rng.range(0.12, 0.17) * (1 - t * 0.25);
        drawLeaf(ctx, rng, lx, ly, la + Math.PI, ll, ll * rng.range(0.32, 0.42), {
          light: layer * 3,
          droop: rng.range(-0.15, 0.15),
        });
      }
      drawLeaf(ctx, rng, ex, ey, a + Math.PI / 2 + Math.PI, r.w * 0.13, r.w * 0.05, { light: layer * 3 });
    }
  }
}

function paintDroop(ctx, r, rng) {
  // Long glossy leaves hanging from a horizontal twig near the top.
  const y = r.y + r.h * 0.06;
  twig(ctx, r.x + r.w * 0.05, y, r.x + r.w * 0.95, y + r.h * 0.03, r.w * 0.01);
  for (let i = 0; i < 26; i++) {
    const t = rng.range(0.16, 0.84);
    const x = r.x + r.w * t;
    const len = r.h * rng.range(0.42, 0.78);
    const ang = rng.range(-0.22, 0.22);
    drawLeaf(ctx, rng, x, y + r.h * 0.02, ang, len, len * rng.range(0.11, 0.16), {
      droop: rng.range(-0.12, 0.12),
      tip: 0.45,
      light: rng.range(-2, 3),
    });
  }
}

function paintPalm(ctx, r, rng) {
  // Rachis up the middle, narrow leaflets angled towards the tip.
  const cx = r.x + r.w * 0.5;
  const y0 = r.y + r.h;
  const y1 = r.y + r.h * 0.01;
  ctx.strokeStyle = 'hsl(70, 30%, 20%)';
  ctx.lineWidth = r.w * 0.035;
  ctx.beginPath();
  ctx.moveTo(cx, y0);
  ctx.lineTo(cx, y1);
  ctx.stroke();
  const count = 46;
  for (let i = 2; i < count; i++) {
    const t = i / count;
    const y = y0 + (y1 - y0) * t;
    const len = r.w * 0.5 * Math.sin(Math.PI * Math.min(t * 1.1, 1)) * rng.range(0.85, 1.0) + r.w * 0.04;
    for (const side of [-1, 1]) {
      const ang = side * (Math.PI / 2 - rng.range(0.55, 0.85));
      drawLeaf(ctx, rng, cx, y, Math.PI + ang, len, r.w * rng.range(0.022, 0.032), {
        veins: false,
        tip: 0.6,
        base: 0.08,
        droop: side * rng.range(0.0, 0.08),
        light: rng.range(-1, 4),
      });
    }
  }
}

function paintFern(ctx, r, rng) {
  const cx = r.x + r.w * 0.5;
  const y0 = r.y + r.h;
  const y1 = r.y + r.h * 0.02;
  ctx.strokeStyle = 'hsl(85, 35%, 18%)';
  ctx.lineWidth = r.w * 0.02;
  ctx.beginPath();
  ctx.moveTo(cx, y0);
  ctx.lineTo(cx, y1);
  ctx.stroke();
  const pinnae = 30;
  const [h, s, l] = leafColor(rng, 3);
  for (let i = 1; i < pinnae; i++) {
    const t = i / pinnae;
    const y = y0 + (y1 - y0) * t;
    const len = r.w * 0.46 * Math.pow(Math.sin(Math.PI * Math.min(t * 1.05, 1)), 0.8) + r.w * 0.02;
    for (const side of [-1, 1]) {
      const ang = side * (Math.PI / 2 - 0.35);
      ctx.save();
      ctx.translate(cx, y);
      ctx.rotate(Math.PI + ang);
      // Each pinna is a row of small rounded lobes.
      const lobes = Math.max(3, Math.round(len / (r.w * 0.04)));
      for (let k = 0; k < lobes; k++) {
        const u = (k + 0.5) / lobes;
        const ll = r.w * 0.05 * (1 - u * 0.6);
        for (const sd of [-1, 1]) {
          drawLeaf(ctx, rng, 0, len * u, sd * 1.0, ll, ll * 0.5, {
            veins: false,
            color: [h + rng.range(-4, 4), s, l + rng.range(-2, 3)],
          });
        }
      }
      ctx.restore();
    }
  }
}

function paintBanana(ctx, r, rng) {
  // One big paddle leaf with parallel veins and a few wind tears.
  const cx = r.x + r.w * 0.5;
  const y0 = r.y + r.h * 0.995;
  const L = r.h * 0.97;
  const W = r.w * 0.47;
  const [h, s, l] = leafColor(rng, 4);
  ctx.save();
  ctx.translate(cx, y0);
  ctx.rotate(Math.PI);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(W * 1.25, L * 0.12, W * 1.1, L * 0.85, 0, L);
  ctx.bezierCurveTo(-W * 1.1, L * 0.85, -W * 1.25, L * 0.12, 0, 0);
  ctx.closePath();
  const grad = ctx.createLinearGradient(-W, 0, W, 0);
  grad.addColorStop(0, hsl(h, s, l * 0.8));
  grad.addColorStop(0.5, hsl(h + 4, s + 6, l * 1.1));
  grad.addColorStop(1, hsl(h, s, l * 0.8));
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = hsl(h + 10, s - 12, l * 1.25, 0.35);
  ctx.lineWidth = 1;
  for (let i = 1; i < 60; i++) {
    const t = i / 60;
    ctx.beginPath();
    ctx.moveTo(0, L * t);
    ctx.lineTo(W * 1.2, L * (t + 0.05));
    ctx.moveTo(0, L * t);
    ctx.lineTo(-W * 1.2, L * (t + 0.05));
    ctx.stroke();
  }
  ctx.strokeStyle = hsl(h + 15, s - 15, l * 1.8, 0.9);
  ctx.lineWidth = r.w * 0.035;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, L * 0.98);
  ctx.stroke();
  ctx.restore();
  // Tears: thin wedges cut from the margin to the midrib.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i++) {
    const t = rng.range(0.15, 0.85);
    const side = rng.chance(0.5) ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(side * W * 1.3, L * (t + 0.04));
    ctx.lineTo(side * W * rng.range(0.1, 0.5), L * t);
    ctx.lineTo(side * W * 1.3, L * (t + 0.055));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function paintSmallLeaves(ctx, r, rng) {
  for (let i = 0; i < 140; i++) {
    const a = rng.range(0, Math.PI * 2);
    const rad = Math.sqrt(rng.next()) * r.w * 0.44;
    const x = r.x + r.w * 0.5 + Math.cos(a) * rad;
    const y = r.y + r.h * 0.5 + Math.sin(a) * rad;
    const len = r.w * rng.range(0.06, 0.11);
    drawLeaf(ctx, rng, x, y, rng.range(0, Math.PI * 2), len, len * 0.42, { light: rng.range(-3, 4), veins: rng.chance(0.5) });
  }
}

function paintReeds(ctx, r, rng) {
  for (let i = 0; i < 22; i++) {
    const x = r.x + r.w * rng.range(0.2, 0.8);
    const y = r.y + r.h;
    const len = r.h * rng.range(0.55, 0.98);
    const ang = rng.range(-0.22, 0.22);
    const [h, s, l] = leafColor(rng, 4);
    drawLeaf(ctx, rng, x, y, Math.PI + ang, len, r.w * rng.range(0.025, 0.04), {
      veins: false,
      tip: 0.7,
      base: 0.05,
      droop: rng.range(-0.25, 0.25),
      color: [h - 15, s - 8, l + 3],
    });
  }
}

function paintVine(ctx, r, rng) {
  const cx = r.x + r.w * 0.5;
  ctx.strokeStyle = 'hsl(60, 25%, 16%)';
  ctx.lineWidth = r.w * 0.04;
  ctx.beginPath();
  ctx.moveTo(cx, r.y);
  for (let i = 1; i <= 10; i++) ctx.lineTo(cx + Math.sin(i * 1.7) * r.w * 0.05, r.y + (r.h * i) / 10);
  ctx.stroke();
  for (let i = 0; i < 18; i++) {
    const t = (i + 0.5) / 18;
    const y = r.y + r.h * t;
    const side = i % 2 === 0 ? 1 : -1;
    const len = r.w * rng.range(0.28, 0.4);
    drawLeaf(ctx, rng, cx, y, side * rng.range(0.9, 1.4) - Math.PI / 2 + Math.PI / 2, len, len * 0.55, {
      tip: 0.5,
      base: 0.3,
      light: rng.range(-2, 4),
    });
  }
}

// Paints the atlas and returns a mip-mapped texture whose transparent texels
// carry nearby leaf colour (so filtering never pulls in black fringes).
export function createLeafAtlas(size = 2048) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rng = new Rng(777);
  const painters = {
    broadleaf: paintBroadleaf,
    droop: paintDroop,
    palm: paintPalm,
    fern: paintFern,
    banana: paintBanana,
    smallLeaves: paintSmallLeaves,
    reeds: paintReeds,
    vine: paintVine,
  };
  for (const [name, painter] of Object.entries(painters)) {
    const r = regionRect(ATLAS[name], size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    painter(ctx, r, rng);
    ctx.restore();
  }

  // Colour bleed: blurred copies of the leaves underneath, on a green ground.
  const bleed = document.createElement('canvas');
  bleed.width = size;
  bleed.height = size;
  const bctx = bleed.getContext('2d', { willReadFrequently: true });
  bctx.fillStyle = 'hsl(105, 38%, 15%)';
  bctx.fillRect(0, 0, size, size);
  for (const blur of [size / 64, size / 160, size / 400]) {
    bctx.filter = `blur(${blur}px)`;
    bctx.drawImage(canvas, 0, 0);
  }
  bctx.filter = 'none';
  bctx.drawImage(canvas, 0, 0);

  const leaves = ctx.getImageData(0, 0, size, size).data;
  const colours = bctx.getImageData(0, 0, size, size).data;
  const out = new Uint8Array(size * size * 4);
  // Flip rows so v = 0 is the bottom of the canvas, matching ATLAS.
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    const dst = y * size * 4;
    for (let x = 0; x < size * 4; x += 4) {
      out[dst + x] = colours[src + x];
      out[dst + x + 1] = colours[src + x + 1];
      out[dst + x + 2] = colours[src + x + 2];
      out[dst + x + 3] = leaves[src + x + 3];
    }
  }
  const texture = new DataTexture(out, size, size, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

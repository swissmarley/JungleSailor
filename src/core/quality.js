// Two render tiers. Phones and tablets get smaller buffers, fewer plants and a
// shorter streaming window; the frame-time governor in main.js then trims the
// pixel ratio further if a device still struggles.
const HIGH = {
  name: 'high',
  maxPixelRatio: 1.5,
  minPixelRatio: 0.7,
  antialias: true,
  reflectionScale: 0.5,
  waveSize: 512,
  simSize: 512,
  simWorld: 64,
  vegetation: 1,
  ahead: 5,
  behind: 2,
  atlasSize: 2048,
  moonSize: 1024,
  rainGrid: 44,
  fireflies: 160,
};

const LOW = {
  name: 'low',
  maxPixelRatio: 1.5,
  minPixelRatio: 0.6,
  antialias: true,
  reflectionScale: 0.35,
  waveSize: 256,
  simSize: 256,
  simWorld: 48,
  vegetation: 0.62,
  ahead: 4,
  behind: 1,
  atlasSize: 1024,
  moonSize: 512,
  rainGrid: 34,
  fireflies: 110,
};

export function detectQuality() {
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  const ua = navigator.userAgent;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const iPadOS = navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS;
  const small = Math.min(screen.width, screen.height) <= 900;
  const low = forced ? forced === 'low' : mobile || (coarse && small);
  const q = { ...(low ? LOW : HIGH) };
  q.touch = coarse || navigator.maxTouchPoints > 0;
  const dpr = parseFloat(params.get('dpr'));
  q.fixedPixelRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : null;
  return q;
}

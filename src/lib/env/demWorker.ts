import { flattenDem, TILE, tileMpp } from './demFlat';

interface Req {
  id: number;
  mode: 'heights' | 'image';
  z: number;
  x: number;
  y: number;
  url: string;
}

const cache = new Map<string, Promise<Float32Array>>();

function load(r: Req): Promise<Float32Array> {
  const key = `${r.z}/${r.x}/${r.y}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(r.url);
      if (!res.ok) throw new Error(`terrain tile ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const cv = new OffscreenCanvas(TILE, TILE);
      const ctx = cv.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, TILE, TILE).data;
      const h = new Float32Array(TILE * TILE);
      // Terrarium encoding: (R * 256 + G + B / 256) - 32768
      for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      return flattenDem(h, tileMpp(r.z, r.y));
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const r = e.data;
  try {
    const h = await load(r);
    if (r.mode === 'heights') {
      const copy = h.slice();
      (self as unknown as Worker).postMessage({ id: r.id, heights: copy }, [copy.buffer]);
      return;
    }
    const cv = new OffscreenCanvas(TILE, TILE);
    const ctx = cv.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const img = ctx.createImageData(TILE, TILE);
    const px = img.data;
    for (let i = 0; i < h.length; i++) {
      const v = Math.min(65535.99, Math.max(0, h[i] + 32768));
      const whole = Math.floor(v);
      px[i * 4] = whole >> 8;
      px[i * 4 + 1] = whole & 255;
      px[i * 4 + 2] = Math.floor((v - whole) * 256);
      px[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const image = await createImageBitmap(cv, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    (self as unknown as Worker).postMessage({ id: r.id, image }, [image as unknown as Transferable]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: r.id, error: String(err) });
  }
};

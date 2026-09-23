import type { RGBAImage } from "./core/image"
import type { ExportConfig } from "./pipeline"

/** 解码：统一转 sRGB、应用 EXIF 方向、不预乘 alpha（预乘会在半透明像素上丢精度） */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, {
    imageOrientation: "from-image",
    premultiplyAlpha: "none",
    colorSpaceConversion: "default",
  })
}

export function bitmapToRGBA(bitmap: ImageBitmap): RGBAImage {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = c.getContext("2d", { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
}

const MIME: Record<ExportConfig["format"], string> = {
  png: "image/png",
  "webp-lossless": "image/webp",
  webp: "image/webp",
  jpeg: "image/jpeg",
}

export const EXT: Record<ExportConfig["format"], string> = {
  png: "png",
  "webp-lossless": "webp",
  webp: "webp",
  jpeg: "jpg",
}

/**
 * 编码导出：
 * - PNG：浏览器原生编码即无损；
 * - 无损 WebP：浏览器 convertToBlob 的 WebP 即使 quality=1 也是有损的，
 *   因此懒加载 @jsquash/webp（libwebp WASM）以 lossless 模式编码；
 * - 有损格式仅用于分享场景，UI 会提示高频伪隐性层失效。
 */
export async function encodeImage(img: RGBAImage, cfg: ExportConfig): Promise<Blob> {
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
  if (cfg.format === "webp-lossless") {
    const { encode } = await import("@jsquash/webp")
    const buf = await encode(data, { lossless: 1, quality: 100, exact: 1 })
    return new Blob([buf], { type: "image/webp" })
  }
  const c = new OffscreenCanvas(img.width, img.height)
  c.getContext("2d")!.putImageData(data, 0, 0)
  return c.convertToBlob({ type: MIME[cfg.format], quality: cfg.format === "png" ? undefined : cfg.quality })
}

/**
 * Image preprocessing for the second OCR pass.
 *
 * Polarity normalisation maps every pixel to its distance from mid-grey:
 * dark-on-light and light-on-dark text both become dark-on-light, so labels
 * printed in white on a coloured button are readable by the OCR engine. Pure
 * function over RGBA bytes so the browser (ImageData) and Node (pngjs) share it.
 */

export function polarizeRgba(data: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = Math.min(255, Math.abs(gray - 128) * 2);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    // alpha unchanged
  }
}

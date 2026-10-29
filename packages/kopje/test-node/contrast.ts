// WCAG 2.2's relative luminance of an sRGB colour, by its channels (0 to 255), and the contrast ratio of two colours.
// Each caller decodes its own notation into channels (the stylesheet's hex, the browser's rgb() strings).

function luminance([r = 0, g = 0, b = 0]: readonly number[]): number {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
}

export function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

interface GlowAttitude { readonly color: string; readonly strength: number }
export interface MarkerGlowLayer { readonly filter: string; readonly clipPath: string }

export function attitudeRing(attitudes: readonly GlowAttitude[]): string | undefined {
  const layers = attitudes.flatMap(attitude => glowLayers(attitude, 10)
    .map(({ blur, color }) => `0 0 ${blur}px 1px ${color}`));
  return layers.length ? layers.join(", ") : undefined;
}

export function attitudeFilter(attitudes: readonly GlowAttitude[], blur = 10): string | undefined {
  const layers = attitudes.flatMap(attitude => glowLayers(attitude, blur)
    .map(({ blur, color }) => `drop-shadow(0 0 ${blur}px ${color})`));
  return layers.length ? layers.join(" ") : undefined;
}

export function markerGlowLayers(attitudes: readonly GlowAttitude[], size: number, artwork: boolean): readonly MarkerGlowLayer[] {
  const active = attitudes.filter(attitude => attitude.strength > 0);
  const outline = artwork ? "drop-shadow(0 0 1px rgba(0,0,0,0.95)) drop-shadow(0 0 1px rgba(0,0,0,0.95))" : "";
  const blur = Math.max(5, Math.round(size * .22));
  if (active.length === 0) return [{ filter: outline, clipPath: "" }];
  return active.map((attitude, index) => ({
    filter: [outline, attitudeFilter([attitude], blur)].filter(Boolean).join(" "),
    clipPath: stripeClipPath(index, active.length),
  }));
}

function stripeClipPath(index: number, count: number): string {
  if (count <= 1) return "";
  // Extend each diagonal band past the icon so outer shadows can bloom freely.
  const shear = 3 * .65 / count;
  const left = index / count, right = (index + 1) / count;
  const percent = (value: number) => (value * 100).toFixed(2);
  return `polygon(${percent(index === 0 ? -1 : left + shear)}% -100%, ${percent(index === count - 1 ? 2 : right + shear)}% -100%, ${percent(index === count - 1 ? 2 : right - shear)}% 200%, ${percent(index === 0 ? -1 : left - shear)}% 200%)`;
}

function glowLayers(attitude: GlowAttitude, blur: number): readonly { readonly blur: number; readonly color: string }[] {
  if (attitude.strength <= 0) return [];
  let hex = attitude.color.slice(1);
  if (hex.length === 3) hex = [...hex].map(part => `${part}${part}`).join("");
  const value = Number.parseInt(hex, 16);
  const color = `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${attitude.strength})`;
  return [{ blur, color }, { blur: Math.max(2, Math.round(blur * .4)), color }];
}

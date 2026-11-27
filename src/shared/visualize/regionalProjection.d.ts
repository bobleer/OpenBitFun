export type RegionalAtlasLayer = "borders" | "lakes" | "land" | "places" | "provinces" | "rivers" | "seas";

export function projectAtlasMap(
  spec: unknown,
  load: (layer: RegionalAtlasLayer) => Promise<unknown>,
  language: string,
  labels: { north: string; km: string; m: string; formatNumber: (value: number) => string },
  request?: typeof fetch,
): Promise<string>;

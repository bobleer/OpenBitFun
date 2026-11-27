import { signal, type ImageAsset } from "nsh";

/** Each app registers an import from inside its own NSH asset directory. */
export const poolStrategyArtwork = signal<ImageAsset | null>(null);

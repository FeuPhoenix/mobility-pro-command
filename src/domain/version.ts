/**
 * The seed version, in its own tiny module.
 *
 * The browser needs to compare the version of a saved demo document against the
 * current one, and importing it from `seed.ts` would pull the whole 42 KB
 * dataset into the client bundle. Keeping it here costs a few bytes instead.
 *
 * Bump this whenever the shape or the figures of the seed change: any demo
 * document saved under an older version is discarded and re-seeded.
 */
export const SEED_VERSION = '1.3.0-EG';

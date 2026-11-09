/** A zero customization slot keeps the corresponding color from the native
 * IMG remap. An identity map overrides it with the master's debug colors. */
export const DEFAULT_AVATAR_COLORS: readonly number[] = Object.freeze(Array<number>(16).fill(0));

export function isLegacyAvatarColorMap(colors: unknown): boolean {
  return Array.isArray(colors) && colors.length === 16 && colors.every((color, index) => color === index);
}

/** Retain chosen colors when switching between physical and ghost forms. */
export function avatarColorMap(colors: unknown): number[] {
  if (!Array.isArray(colors) || colors.length !== 16 || isLegacyAvatarColorMap(colors)) return [...DEFAULT_AVATAR_COLORS];
  return [...colors];
}

/** Working product name. Change it here and everywhere follows. */
export const PRODUCT_NAME = "Lantern";

/** Shown on every stream, on every plan. Not configurable by design. */
export function disclosureText(characterName: string): string {
  return `${characterName} é uma IA`;
}

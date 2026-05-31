/** Mask helpers — use float math to stay correct for bits >= 31. */

export function idsFromMask(mask: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (Math.floor(mask / 2 ** i) % 2 === 1) ids.push(i);
  }
  return ids;
}

export function maskFromIds(ids: number[]): number {
  return ids.reduce((mask, id) => mask + 2 ** id, 0);
}

export function maskHas(mask: number, id: number): boolean {
  return Math.floor(mask / 2 ** id) % 2 === 1;
}

export function toggleBit(mask: number, id: number): number {
  return maskHas(mask, id) ? mask - 2 ** id : mask + 2 ** id;
}

export function popcount(mask: number): number {
  return idsFromMask(mask).length;
}

export const PRIORITY_LABELS: Record<number, string> = {
  0x40: "低",
  0x4000: "低于正常",
  0x20: "正常",
  0x8000: "高于正常",
  0x80: "高",
  0x100: "实时",
};

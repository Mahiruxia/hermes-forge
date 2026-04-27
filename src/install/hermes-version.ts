/**
 * Hermes CLI version parsing helpers, shared between WSL and Native install paths
 * and runtime resolvers. Pure functions — no I/O.
 */

export function parseHermesVersion(output: string): string | undefined {
  const match = output.trim().match(/(?:hermes\s+v?|v?)(\d+\.\d+(?:\.\d+(?:[-+.]?\w+)?)?)/i);
  return match?.[1];
}

export function isAtLeastVersion(version: string, min: string): boolean {
  const parse = (v: string) => v.split(/[.-]/).map((n) => {
    const int = parseInt(n, 10);
    return Number.isNaN(int) ? 0 : int;
  });
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

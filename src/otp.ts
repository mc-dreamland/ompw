export function normalizeOtp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.normalize('NFKC').replace(/\s/g, '');
  return /^[0-9]{6}$/.test(code) ? code : undefined;
}

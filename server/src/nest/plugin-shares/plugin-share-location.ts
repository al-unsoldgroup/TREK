import { getCountryFromAddress } from '../atlas/atlas-geo';
import { cityFromAddress } from '../atlas/city-from-address';

export function adviceCountry(address: string | null | undefined): string | null {
  const parts = address?.split(',').map(part => part.trim()).filter(Boolean) ?? [];
  return getCountryFromAddress(parts.at(-1) ?? null, false) || getCountryFromAddress(parts[0] ?? null, false);
}

export function adviceLocality(address: string | null | undefined, country: string | null, region: string | null): string | null {
  const knownCountry = (part: string) => getCountryFromAddress(part, false) !== null;
  if (country !== 'JP') return cityFromAddress(address, knownCountry) || region;
  if (!address) return region;
  const raw = address.normalize('NFKC').split(',').map(part => part.trim()).filter(Boolean);
  if (raw.length < 2) return region;
  const postal = /〒?\s*\d{3}-\d{4}/;
  const clean = (part: string) => part.replace(postal, '').trim();
  const parts = raw.map(clean);
  if (parts.some(part => /^Tokyo(?: Metropolis)?$/i.test(part))) return 'Tokyo';
  const ward = parts.findIndex(part => /\bWard$|-ku$/i.test(part));
  const leadingPostal = raw.findIndex(part => /^〒?\s*\d{3}-\d{4}\s+\p{L}/u.test(part));
  const forward = knownCountry(raw[0]!) || leadingPostal >= 0;
  const usable = (part: string) => !!part && /\p{L}/u.test(part) && !/\d|\bDistrict$|\bWard$|-ku$/i.test(part) && !knownCountry(part);
  if (forward) {
    if (ward > 0 && usable(parts[ward - 1]!)) return parts[ward - 1]!;
    const start = leadingPostal >= 0 ? leadingPostal : 1;
    return parts.slice(start + 1).find(usable) || (usable(parts[start] ?? '') ? parts[start]! : region);
  }
  const tail = parts.map((part, index) => ({ part, raw: raw[index]! })).filter(item => item.part && !knownCountry(item.part));
  const last = tail.at(-1);
  const before = tail.at(-2);
  const normalizedRegion = region?.replace(/ Prefecture$/i, '').toLowerCase();
  if (last && before && (last.part.toLowerCase() === normalizedRegion || /\bDistrict$/i.test(before.part) ||
      (postal.test(last.raw) && usable(before.part)))) tail.pop();
  return tail.reverse().find(item => usable(item.part))?.part || region;
}

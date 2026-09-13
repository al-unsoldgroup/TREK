import { describe, expect, it } from 'vitest';
import { adviceLocality } from '../../../src/nest/plugin-shares/plugin-share-location';

describe('native advice city inference', () => {
  it.each([
    ['1 Main Street, Shibuya, Tokyo 150-0002, Japan', null, 'Tokyo'],
    ['Japan, 〒104-0061 Tokyo, Chuo City, Ginza, 1-2-3', 'Tokyo', 'Tokyo'],
    ['1 Main Street, Chiyoda City, Tokyo', null, 'Tokyo'],
    ['Japan, 〒542-0071 Osaka, Chuo Ward, Dotonbori, 1-2-3', null, 'Osaka'],
    ['Temple, Higashiyama Ward, Kyoto, 605-0000, Japan', null, 'Kyoto'],
    ['Venue, 604-0000 Kyoto, Nakagyo Ward, Street, 123', null, 'Kyoto'],
    ['Garden, Kanazawa, Ishikawa 920-0000, Japan', null, 'Kanazawa'],
    ['Japan, 〒250-0000 Kanagawa, Ashigarashimo District, Hakone, Street, 123', 'Kanagawa', 'Hakone'],
    ['Hakone, Ashigarashimo District, Kanagawa, Japan', 'Kanagawa', 'Hakone'],
    ['Nara, Japan', 'Nara Prefecture', 'Nara'],
    ['Town, Akan District, Hokkaido, Japan', null, 'Town'],
    ['Nara, Japan', null, 'Nara'],
  ])('groups %s without manual input', (address, region, expected) => {
    expect(adviceLocality(address, 'JP', region)).toBe(expected);
  });
  it('keeps ordinary international addresses and honest unknown locations', () => {
    expect(adviceLocality('Museum, Paris, France', 'FR', null)).toBe('Paris');
    expect(adviceLocality(null, null, null)).toBeNull();
    expect(adviceLocality('Landscape garden', 'JP', null)).toBeNull();
  });
});

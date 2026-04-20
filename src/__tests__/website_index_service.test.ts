import { extractWebsiteIndexUrls } from '../main/website_index_service';

describe('extractWebsiteIndexUrls', () => {
  test('reads common URL fields from array payloads', () => {
    expect(
      extractWebsiteIndexUrls([
        { url: 'http://[200:db8::1]/' },
        { href: 'https://example.test/path' },
        { URL: 'http://[200:db8::1]/' },
      ]),
    ).toEqual(['http://[200:db8::1]/', 'https://example.test/path']);
  });

  test('reads rows and items containers', () => {
    expect(
      extractWebsiteIndexUrls({
        rows: [{ '地址': 'http://[200:db8::2]:8080/' }],
        items: [{ 链接: 'http://[200:db8::3]/' }],
      }),
    ).toEqual(['http://[200:db8::2]:8080/']);

    expect(
      extractWebsiteIndexUrls({
        items: [{ 链接: 'http://[200:db8::3]/' }],
      }),
    ).toEqual(['http://[200:db8::3]/']);
  });
});
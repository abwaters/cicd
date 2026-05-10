import { defaultContentType, defaultCacheControl } from '../src/shared/s3';

describe('defaultContentType', () => {
    it.each([
        ['index.html', 'text/html; charset=utf-8'],
        ['styles.css', 'text/css; charset=utf-8'],
        ['app.js', 'application/javascript; charset=utf-8'],
        ['module.mjs', 'application/javascript; charset=utf-8'],
        ['data.json', 'application/json; charset=utf-8'],
        ['icon.svg', 'image/svg+xml'],
        ['logo.png', 'image/png'],
        ['photo.jpg', 'image/jpeg'],
        ['photo.jpeg', 'image/jpeg'],
        ['hero.webp', 'image/webp'],
        ['hero.avif', 'image/avif'],
        ['favicon.ico', 'image/x-icon'],
        ['font.woff', 'font/woff'],
        ['font.woff2', 'font/woff2'],
        ['robots.txt', 'text/plain; charset=utf-8'],
        ['sitemap.xml', 'application/xml; charset=utf-8'],
        ['app.js.map', 'application/json; charset=utf-8'],
        ['file.pdf', 'application/pdf'],
    ])('returns correct type for %s', (key, expected) => {
        expect(defaultContentType(key)).toBe(expected);
    });

    it('falls back to application/octet-stream for unknown extensions', () => {
        expect(defaultContentType('archive.tar')).toBe('application/octet-stream');
        expect(defaultContentType('file.unknownext')).toBe('application/octet-stream');
    });

    it('uses last extension for multi-dot filenames', () => {
        expect(defaultContentType('bundle.min.js')).toBe('application/javascript; charset=utf-8');
        expect(defaultContentType('vendor.chunk.css')).toBe('text/css; charset=utf-8');
    });

    it('treats files without extension as octet-stream', () => {
        expect(defaultContentType('Dockerfile')).toBe('application/octet-stream');
    });

    it('is case-insensitive on extensions', () => {
        expect(defaultContentType('IMAGE.PNG')).toBe('image/png');
        expect(defaultContentType('Page.HTML')).toBe('text/html; charset=utf-8');
    });
});

describe('defaultCacheControl', () => {
    it('returns no-cache for HTML', () => {
        expect(defaultCacheControl('index.html')).toBe('no-cache, no-store, must-revalidate');
        expect(defaultCacheControl('nested/page.html')).toBe('no-cache, no-store, must-revalidate');
    });

    it('returns immutable for hashed assets', () => {
        const immutable = 'public, max-age=31536000, immutable';
        expect(defaultCacheControl('app.abc123.js')).toBe(immutable);
        expect(defaultCacheControl('styles.deadbe.css')).toBe(immutable);
        expect(defaultCacheControl('logo.png')).toBe(immutable);
        expect(defaultCacheControl('font.woff2')).toBe(immutable);
    });

    it('treats unknown extensions as immutable assets', () => {
        // Default policy: anything not html gets the long-lived cache header.
        expect(defaultCacheControl('archive.tar')).toBe('public, max-age=31536000, immutable');
    });
});

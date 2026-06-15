const mockSend = jest.fn();

jest.mock('../src/shared/aws-context', () => ({
    getRegion: jest.fn(async () => 'us-east-1'),
}));

jest.mock('@aws-sdk/client-s3', () => {
    const makeCmd = (cmdType: string) => class {
        input: any;
        type: string;
        constructor(input: any) { this.input = input; this.type = cmdType; }
    };
    return {
        S3Client: jest.fn(() => ({ send: mockSend })),
        PutObjectCommand: makeCmd('put'),
        GetObjectCommand: makeCmd('get'),
        CopyObjectCommand: makeCmd('copy'),
        ListObjectsV2Command: makeCmd('list'),
        DeleteObjectsCommand: makeCmd('delete'),
    };
});

import { defaultContentType, defaultCacheControl, makeCacheControl, syncPrefix, getObjectText, getJson } from '../src/shared/s3';

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

describe('makeCacheControl', () => {
    it('falls back to the defaults when no overrides are given', () => {
        const cc = makeCacheControl();
        expect(cc('index.html')).toBe('no-cache, no-store, must-revalidate');
        expect(cc('assets/app.abc123.js')).toBe('public, max-age=31536000, immutable');
    });

    it('applies an html override (e.g. edge-cacheable via s-maxage) and keeps the asset default', () => {
        const cc = makeCacheControl({ html: 'public, max-age=3600, s-maxage=86400' });
        expect(cc('index.html')).toBe('public, max-age=3600, s-maxage=86400');
        expect(cc('nested/page.html')).toBe('public, max-age=3600, s-maxage=86400');
        expect(cc('assets/app.abc123.js')).toBe('public, max-age=31536000, immutable');
    });

    it('applies an assets override independently of html', () => {
        const cc = makeCacheControl({ assets: 'public, max-age=600' });
        expect(cc('index.html')).toBe('no-cache, no-store, must-revalidate');
        expect(cc('logo.png')).toBe('public, max-age=600');
    });
});

describe('syncPrefix', () => {
    beforeEach(() => mockSend.mockReset());

    function setupListing(srcKeys: string[], destKeys: string[]) {
        mockSend.mockImplementation(async (command: any) => {
            if (command.type === 'list') {
                if (command.input.Prefix === 'dev/abc/') {
                    return { Contents: srcKeys.map(Key => ({ Key })), IsTruncated: false };
                }
                if (command.input.Prefix === 'dev/live/') {
                    return { Contents: destKeys.map(Key => ({ Key })), IsTruncated: false };
                }
                return { Contents: [], IsTruncated: false };
            }
            if (command.type === 'copy') return {};
            if (command.type === 'delete') return { Errors: [] };
            return {};
        });
    }

    it('copies every source object into dest preserving relative paths', async () => {
        setupListing(['dev/abc/index.html', 'dev/abc/assets/app.js'], []);

        const count = await syncPrefix('bucket', 'dev/abc/', 'dev/live/');

        expect(count).toBe(2);
        const copies = mockSend.mock.calls.map(c => c[0]).filter(c => c.type === 'copy');
        expect(copies.map(c => ({ Key: c.input.Key, CopySource: c.input.CopySource }))).toEqual([
            { Key: 'dev/live/index.html', CopySource: 'bucket/dev/abc/index.html' },
            { Key: 'dev/live/assets/app.js', CopySource: 'bucket/dev/abc/assets/app.js' },
        ]);
    });

    it('prunes only dest objects absent from the source, after copying', async () => {
        setupListing(
            ['dev/abc/index.html'],
            ['dev/live/index.html', 'dev/live/stale.js'],
        );

        await syncPrefix('bucket', 'dev/abc/', 'dev/live/');

        const calls = mockSend.mock.calls.map(c => c[0]);
        const deletes = calls.filter(c => c.type === 'delete');
        expect(deletes).toHaveLength(1);
        expect(deletes[0].input.Delete.Objects).toEqual([{ Key: 'dev/live/stale.js' }]);

        // Every copy must happen before the (single) delete — never an empty window.
        const lastCopyIdx = calls.map(c => c.type).lastIndexOf('copy');
        const deleteIdx = calls.map(c => c.type).indexOf('delete');
        expect(lastCopyIdx).toBeLessThan(deleteIdx);
    });

    it('issues no delete when dest has no stale objects', async () => {
        setupListing(['dev/abc/index.html'], ['dev/live/index.html']);
        await syncPrefix('bucket', 'dev/abc/', 'dev/live/');
        expect(mockSend.mock.calls.map(c => c[0]).some(c => c.type === 'delete')).toBe(false);
    });

    it('throws when the source prefix is empty', async () => {
        setupListing([], []);
        await expect(syncPrefix('bucket', 'dev/abc/', 'dev/live/')).rejects.toThrow(/source prefix .* is empty/);
    });

    it('retains preserved-prefix objects but still prunes other stale objects', async () => {
        setupListing(
            ['dev/abc/index.html', 'dev/abc/assets/new.js'],
            ['dev/live/index.html', 'dev/live/assets/old.js', 'dev/live/stale.html'],
        );

        await syncPrefix('bucket', 'dev/abc/', 'dev/live/', ['assets/']);

        const deletes = mockSend.mock.calls.map(c => c[0]).filter(c => c.type === 'delete');
        expect(deletes).toHaveLength(1);
        // assets/old.js is retained; only the non-asset stale file is pruned.
        expect(deletes[0].input.Delete.Objects).toEqual([{ Key: 'dev/live/stale.html' }]);
    });

    it('still prunes everything stale when no prefixes are preserved (default)', async () => {
        setupListing(
            ['dev/abc/index.html'],
            ['dev/live/index.html', 'dev/live/assets/old.js'],
        );

        await syncPrefix('bucket', 'dev/abc/', 'dev/live/');

        const deletes = mockSend.mock.calls.map(c => c[0]).filter(c => c.type === 'delete');
        expect(deletes[0].input.Delete.Objects).toEqual([{ Key: 'dev/live/assets/old.js' }]);
    });
});

describe('getObjectText / getJson', () => {
    beforeEach(() => mockSend.mockReset());

    it('returns the body text', async () => {
        mockSend.mockResolvedValue({ Body: { transformToString: async () => 'hello' } });
        expect(await getObjectText('b', 'k')).toBe('hello');
    });

    it('returns null when the object is missing (NoSuchKey)', async () => {
        mockSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
        expect(await getObjectText('b', 'k')).toBeNull();
    });

    it('returns null on a 404 metadata status', async () => {
        mockSend.mockRejectedValue(Object.assign(new Error('nope'), { $metadata: { httpStatusCode: 404 } }));
        expect(await getObjectText('b', 'k')).toBeNull();
    });

    it('parses JSON, and returns null for a missing marker', async () => {
        mockSend.mockResolvedValueOnce({ Body: { transformToString: async () => '{"commit":"abc123"}' } });
        expect(await getJson<{ commit: string }>('b', 'k')).toEqual({ commit: 'abc123' });

        mockSend.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
        expect(await getJson('b', 'k')).toBeNull();
    });
});

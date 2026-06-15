import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    CopyObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand
} from "@aws-sdk/client-s3";
import * as fs from 'fs';
import * as path from 'path';

import * as awsContext from './aws-context';
import { awsRetry } from './utils';

let client: S3Client | null = null;

async function getClient(): Promise<S3Client> {
    if (!client) {
        const region = await awsContext.getRegion();
        client = new S3Client({ region });
    }
    return client;
}

const CONTENT_TYPES: Record<string, string> = {
    html:  'text/html; charset=utf-8',
    css:   'text/css; charset=utf-8',
    js:    'application/javascript; charset=utf-8',
    mjs:   'application/javascript; charset=utf-8',
    json:  'application/json; charset=utf-8',
    svg:   'image/svg+xml',
    png:   'image/png',
    jpg:   'image/jpeg',
    jpeg:  'image/jpeg',
    gif:   'image/gif',
    webp:  'image/webp',
    avif:  'image/avif',
    ico:   'image/x-icon',
    woff:  'font/woff',
    woff2: 'font/woff2',
    txt:   'text/plain; charset=utf-8',
    xml:   'application/xml; charset=utf-8',
    map:   'application/json; charset=utf-8',
    pdf:   'application/pdf'
};

const HTML_CACHE = 'no-cache, no-store, must-revalidate';
const ASSET_CACHE = 'public, max-age=31536000, immutable';

function defaultContentType(key: string): string {
    const ext = path.extname(key).slice(1).toLowerCase();
    return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function defaultCacheControl(key: string): string {
    const ext = path.extname(key).slice(1).toLowerCase();
    return ext === 'html' ? HTML_CACHE : ASSET_CACHE;
}

// Build a cache-control resolver, optionally overriding the html / non-html
// defaults (e.g. from a web export's `cacheControl` config). An override that
// uses `s-maxage` lets CloudFront edge-cache HTML while a short `max-age` keeps
// the browser copy fresh.
function makeCacheControl(overrides?: { html?: string; assets?: string }): (key: string) => string {
    const html = overrides?.html ?? HTML_CACHE;
    const assets = overrides?.assets ?? ASSET_CACHE;
    return (key: string) =>
        path.extname(key).slice(1).toLowerCase() === 'html' ? html : assets;
}

interface UploadDirectoryResult {
    fileCount: number;
    totalBytes: number;
}

async function uploadDirectory(
    bucket: string,
    keyPrefix: string,
    localDir: string,
    contentTypeFor?: (key: string) => string,
    cacheControlFor?: (key: string) => string
): Promise<UploadDirectoryResult> {
    const ctFn = contentTypeFor ?? defaultContentType;
    const ccFn = cacheControlFor ?? defaultCacheControl;
    const normalizedPrefix = keyPrefix.endsWith('/') ? keyPrefix.slice(0, -1) : keyPrefix;

    const files = walkFiles(localDir);
    if (files.length === 0) {
        throw new Error(`uploadDirectory: source directory '${localDir}' is empty`);
    }

    let totalBytes = 0;
    const s3 = await getClient();

    for (const absPath of files) {
        const relPath = path.relative(localDir, absPath).split(path.sep).join('/');
        const key = `${normalizedPrefix}/${relPath}`;
        const body = fs.readFileSync(absPath);
        totalBytes += body.length;

        await awsRetry(() => s3.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: ctFn(key),
            CacheControl: ccFn(key)
        })));
    }

    return { fileCount: files.length, totalBytes };
}

function walkFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`uploadDirectory: source directory '${dir}' does not exist`);
    }
    const out: string[] = [];
    function walk(current: string): void {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                out.push(full);
            }
        }
    }
    walk(dir);
    return out;
}

async function putObject(
    bucket: string,
    key: string,
    body: string | Buffer,
    contentType: string,
    cacheControl?: string
): Promise<void> {
    const s3 = await getClient();
    await awsRetry(() => s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl
    })));
}

async function listObjectsByPrefix(bucket: string, prefix: string): Promise<string[]> {
    const s3 = await getClient();
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
        const resp = await awsRetry(() => s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken
        })));
        for (const obj of (resp.Contents ?? [])) {
            if (obj.Key) keys.push(obj.Key);
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
}

async function listCommonPrefixes(bucket: string, prefix: string, delimiter: string = '/'): Promise<string[]> {
    const s3 = await getClient();
    const prefixes: string[] = [];
    let continuationToken: string | undefined;
    do {
        const resp = await awsRetry(() => s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: delimiter,
            ContinuationToken: continuationToken
        })));
        for (const cp of (resp.CommonPrefixes ?? [])) {
            if (cp.Prefix) prefixes.push(cp.Prefix);
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return prefixes;
}

async function deleteObjects(bucket: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const s3 = await getClient();
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const resp = await awsRetry(() => s3.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true }
        })));
        deleted += batch.length - (resp.Errors?.length ?? 0);
        if (resp.Errors && resp.Errors.length > 0) {
            for (const err of resp.Errors) {
                console.error(`s3 delete error: ${err.Key} (${err.Code}): ${err.Message}`);
            }
        }
    }
    return deleted;
}

// Make destPrefix an exact mirror of srcPrefix with no window where it is empty
// or partial: every source object is copied (overwriting) first, then any dest
// object whose relative path is absent from the source is pruned. Server-side
// copy with MetadataDirective defaulting to COPY preserves the source object's
// ContentType and CacheControl (set by uploadDirectory). Returns the source
// object count. Throws if the source prefix is empty (nothing to mirror).
async function syncPrefix(bucket: string, srcPrefix: string, destPrefix: string): Promise<number> {
    const src = srcPrefix.endsWith('/') ? srcPrefix : `${srcPrefix}/`;
    const dest = destPrefix.endsWith('/') ? destPrefix : `${destPrefix}/`;

    const srcKeys = await listObjectsByPrefix(bucket, src);
    if (srcKeys.length === 0) {
        throw new Error(`syncPrefix: source prefix 's3://${bucket}/${src}' is empty`);
    }

    const s3 = await getClient();
    const newRel = new Set<string>();
    for (const srcKey of srcKeys) {
        const rel = srcKey.slice(src.length);
        newRel.add(rel);
        await awsRetry(() => s3.send(new CopyObjectCommand({
            Bucket: bucket,
            Key: `${dest}${rel}`,
            CopySource: encodeURI(`${bucket}/${srcKey}`)
        })));
    }

    const liveKeys = await listObjectsByPrefix(bucket, dest);
    const stale = liveKeys.filter(k => !newRel.has(k.slice(dest.length)));
    await deleteObjects(bucket, stale);

    return srcKeys.length;
}

// Read an object body as UTF-8 text. Returns null when the object does not exist
// (so callers treat a missing marker as "not deployed" rather than an error).
async function getObjectText(bucket: string, key: string): Promise<string | null> {
    const s3 = await getClient();
    try {
        const resp = await awsRetry(() => s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
        if (!resp.Body) return null;
        return await (resp.Body as any).transformToString('utf-8');
    } catch (e: any) {
        if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
        throw e;
    }
}

async function getJson<T>(bucket: string, key: string): Promise<T | null> {
    const text = await getObjectText(bucket, key);
    return text === null ? null : (JSON.parse(text) as T);
}

export {
    uploadDirectory,
    putObject,
    listObjectsByPrefix,
    listCommonPrefixes,
    deleteObjects,
    syncPrefix,
    getObjectText,
    getJson,
    defaultContentType,
    defaultCacheControl,
    makeCacheControl
};

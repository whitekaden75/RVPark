const clean = value => String(value || '').trim();

export function bookkeepingStorageConfig(env = process.env) {
  // Railway's BUCKET is the S3 API name. RAILWAY_BUCKET_NAME can be only
  // a display name; retain it last for existing manually configured services.
  const bucket = clean(env.RAILWAY_BUCKET) || clean(env.BUCKET) || clean(env.RAILWAY_BUCKET_NAME);
  const endpoint = clean(env.RAILWAY_BUCKET_ENDPOINT) || clean(env.ENDPOINT);
  const accessKeyId = clean(env.RAILWAY_BUCKET_ACCESS_KEY) || clean(env.ACCESS_KEY_ID);
  const secretAccessKey = clean(env.RAILWAY_BUCKET_SECRET_KEY) || clean(env.SECRET_ACCESS_KEY);
  const region = clean(env.RAILWAY_BUCKET_REGION) || clean(env.REGION) || 'auto';
  const missing = [!bucket && 'BUCKET', !endpoint && 'ENDPOINT', !accessKeyId && 'ACCESS_KEY_ID', !secretAccessKey && 'SECRET_ACCESS_KEY'].filter(Boolean);
  if (missing.length) return { bucket, options: null, error: `Railway Bucket storage is not configured. Missing: ${missing.join(', ')}.` };
  let url;
  try { url = new URL(endpoint); } catch {
    return { bucket, options: null, error: 'Railway Bucket endpoint must be the S3 base URL from the bucket Credentials tab.' };
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    return { bucket, options: null, error: 'Railway Bucket endpoint must be the S3 base URL, without a bucket path, credentials, or query parameters.' };
  }
  const style = clean(env.RAILWAY_BUCKET_FORCE_PATH_STYLE).toLowerCase();
  if (style && !['true', 'false'].includes(style)) {
    return { bucket, options: null, error: 'RAILWAY_BUCKET_FORCE_PATH_STYLE must be true or false, as specified in the bucket Credentials tab.' };
  }
  const railwayEndpoint = url.hostname === 'storageapi.dev' || url.hostname.endsWith('.storageapi.dev');
  return { bucket, error: null, options: {
    endpoint: url.origin, region,
    // Current Railway buckets use virtual hosts. Older buckets can opt into
    // path style explicitly; other endpoints retain the previous default.
    forcePathStyle: style ? style === 'true' : !railwayEndpoint,
    credentials: { accessKeyId, secretAccessKey }
  } };
}

export function storageCopySource(bucket, key) {
  return [bucket, ...key.split('/')].map(encodeURIComponent).join('/');
}

export function bookkeepingStorageErrorMessage(error, operation) {
  const signatureError = [error?.name, error?.code, error?.Code].includes('SignatureDoesNotMatch') ||
    /request signature we calculated does not match/i.test(error?.message || '');
  if (!signatureError) return error?.message || 'Document storage request failed.';
  const step = operation === 'copy' ? 'renaming the document after AI extraction' : 'downloading the document for AI';
  return `Document storage rejected the request signature while ${step}. Check the backend's Railway Bucket access key/secret pair, S3 API bucket name (BUCKET), endpoint, region, and URL style in the bucket Credentials tab. This is a storage configuration issue.`;
}

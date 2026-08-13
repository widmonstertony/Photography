import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PHOTO_LIMITS = Object.freeze({
  originalBytes: 50 * 1024 * 1024,
  previewBytes: 5 * 1024 * 1024,
  jsonBytes: 32 * 1024,
  galleryItems: 500,
  uploadsPerHour: 24,
});

export const PHOTO_TYPES = Object.freeze({
  original: new Map([['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp']]),
  preview: new Map([['jpg', 'image/jpeg'], ['webp', 'image/webp']]),
});
export const PHOTO_RELEASE_TAG = 'photography-originals-v1';

export function normalizeInstagramUsername(value) {
  const username = typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  if (!username) return '';
  if (!/^[a-z0-9._]{1,30}$/.test(username)) throw new Error('INVALID_INSTAGRAM_USERNAME');
  return username;
}

export function instagramProfileUrl(value) {
  const username = normalizeInstagramUsername(value);
  return username ? `https://www.instagram.com/${username}/` : null;
}

export function parseCookies(header = '') {
  const result = {};
  for (const item of String(header).split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    const key = item.slice(0, index).trim();
    try { result[key] = decodeURIComponent(item.slice(index + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function hmac(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function issueSignedValue(payload, secret, lifetimeSeconds) {
  const body = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds }));
  return `${body}.${hmac(body, secret)}`;
}

export function readSignedValue(value, secret) {
  if (!value || typeof value !== 'string') return null;
  const [body, signature, extra] = value.split('.');
  if (!body || !signature || extra) return null;
  const expected = hmac(body, secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

export function newOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function csrfForSession(sessionValue, secret) {
  return hmac(`csrf:${sessionValue}`, secret);
}

export function validPhotoMagic(contentType, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return false;
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function text(value, max, required = false) {
  const result = typeof value === 'string' ? value.trim().slice(0, max) : '';
  if (required && !result) throw new Error('INVALID_METADATA');
  return result;
}

function localized(value, max, required = false) {
  return { en: text(value?.en, max, required), zh: text(value?.zh, max, required) };
}

export function normalizePublishedPhoto(value) {
  const id = text(value?.id, 64, true);
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) throw new Error('INVALID_ID');
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width < 1 || width > 30_000 || !Number.isInteger(height) || height < 1 || height > 30_000) throw new Error('INVALID_DIMENSIONS');
  return { id, ...normalizePhotoMetadata(value), width, height };
}

export function normalizePhotoMetadata(value) {
  const capturedAt = value.capturedAt ? text(value.capturedAt, 32) : null;
  if (capturedAt && !/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:+.-]+)?$/.test(capturedAt)) throw new Error('INVALID_DATE');
  return {
    title: localized(value.title, 120, true),
    alt: localized(value.alt, 180, true),
    location: localized(value.location, 100),
    vehicle: localized(value.vehicle, 100),
    capturedAt,
    camera: text(value.camera, 100),
    lens: text(value.lens, 100),
    featured: value.featured === true,
  };
}

export function updateGalleryEntryMetadata(entry, value) {
  if (!entry || typeof entry !== 'object') throw new Error('PHOTO_NOT_FOUND');
  return { ...entry, ...normalizePhotoMetadata(value) };
}

export function mediaPath(kind, id, extension, year = new Date().getUTCFullYear()) {
  if (!['original', 'preview'].includes(kind)) throw new Error('INVALID_KIND');
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) throw new Error('INVALID_ID');
  if (!PHOTO_TYPES[kind].has(extension)) throw new Error('INVALID_EXTENSION');
  return `${kind === 'original' ? 'originals' : 'previews'}/${year}/${id}.${extension}`;
}

export function originalAssetName(id, extension) {
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) throw new Error('INVALID_ID');
  if (!PHOTO_TYPES.original.has(extension)) throw new Error('INVALID_EXTENSION');
  return `${id}.${extension}`;
}

export function buildGalleryEntry(photo, originalLocation, previewPath, owner, repository) {
  const raw = `https://raw.githubusercontent.com/${owner}/${repository}/media/`;
  const release = `https://github.com/${owner}/${repository}/releases/download/${PHOTO_RELEASE_TAG}/`;
  const original = originalLocation.startsWith('https://') ? originalLocation : `${raw}${originalLocation}`;
  if (!original.startsWith(raw) && !original.startsWith(release)) throw new Error('INVALID_MEDIA_URL');
  return {
    id: photo.id,
    publishedAt: new Date().toISOString(),
    capturedAt: photo.capturedAt,
    title: photo.title,
    alt: photo.alt,
    location: photo.location,
    vehicle: photo.vehicle,
    camera: photo.camera,
    lens: photo.lens,
    width: photo.width,
    height: photo.height,
    original,
    preview: `${raw}${previewPath}`,
    featured: photo.featured,
  };
}

function urlSegments(value, hostname) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_MEDIA_REFERENCE'); }
  if (url.protocol !== 'https:' || url.hostname !== hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('INVALID_MEDIA_REFERENCE');
  }
  try { return url.pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { throw new Error('INVALID_MEDIA_REFERENCE'); }
}

function repositoryMediaPath(value, kind, id, owner, repository, branch) {
  const segments = urlSegments(value, 'raw.githubusercontent.com');
  if (segments[0] !== owner || segments[1] !== repository || segments[2] !== branch) throw new Error('INVALID_MEDIA_REFERENCE');
  const path = segments.slice(3).join('/');
  const extensions = [...PHOTO_TYPES[kind].keys()].join('|');
  if (!new RegExp(`^${kind === 'original' ? 'originals' : 'previews'}/\\d{4}/${id}\\.(${extensions})$`).test(path)) {
    throw new Error('INVALID_MEDIA_REFERENCE');
  }
  return path;
}

function releaseOriginalName(value, id, owner, repository) {
  const segments = urlSegments(value, 'github.com');
  const prefix = [owner, repository, 'releases', 'download', PHOTO_RELEASE_TAG];
  if (segments.length !== prefix.length + 1 || prefix.some((part, index) => segments[index] !== part)) {
    throw new Error('INVALID_MEDIA_REFERENCE');
  }
  const name = segments.at(-1);
  const extension = name.split('.').at(-1);
  if (originalAssetName(id, extension) !== name) throw new Error('INVALID_MEDIA_REFERENCE');
  return name;
}

export function galleryMediaTargets(entry, owner, repository, branch = 'media') {
  if (!entry || typeof entry !== 'object' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(entry.id)) {
    throw new Error('INVALID_MEDIA_REFERENCE');
  }
  const previewPath = repositoryMediaPath(entry.preview, 'preview', entry.id, owner, repository, branch);
  if (String(entry.original).startsWith('https://raw.githubusercontent.com/')) {
    return {
      previewPath,
      repositoryOriginalPath: repositoryMediaPath(entry.original, 'original', entry.id, owner, repository, branch),
      releaseOriginalName: null,
    };
  }
  return {
    previewPath,
    repositoryOriginalPath: null,
    releaseOriginalName: releaseOriginalName(entry.original, entry.id, owner, repository),
  };
}

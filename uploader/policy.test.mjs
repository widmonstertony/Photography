import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGalleryEntry, csrfForSession, galleryMediaTargets, instagramProfileUrl, issueSignedValue, mediaPath, normalizeInstagramUsername, normalizePublishedPhoto, originalAssetName, readSignedValue, updateGalleryEntryMetadata, validPhotoMagic } from './policy.mjs';

test('signs and verifies bounded session values', () => {
  const secret = Buffer.alloc(32, 7);
  const token = issueSignedValue({ login: 'widmonstertony' }, secret, 60);
  assert.equal(readSignedValue(token, secret).login, 'widmonstertony');
  assert.equal(readSignedValue(`${token}x`, secret), null);
  assert.match(csrfForSession(token, secret), /^[A-Za-z0-9_-]{40,}$/);
});

test('validates displayable image magic bytes', () => {
  assert.equal(validPhotoMagic('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), true);
  assert.equal(validPhotoMagic('image/webp', Buffer.from('RIFF0000WEBP')), true);
  assert.equal(validPhotoMagic('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), true);
  assert.equal(validPhotoMagic('image/jpeg', Buffer.from('not an image')), false);
});

test('builds an Instagram profile URL only from a bounded username', () => {
  assert.equal(normalizeInstagramUsername('@Tony.Cars_2'), 'tony.cars_2');
  assert.equal(instagramProfileUrl('Tony.Cars_2'), 'https://www.instagram.com/tony.cars_2/');
  assert.equal(instagramProfileUrl(''), null);
  assert.throws(() => instagramProfileUrl('tony/cars'), /INVALID_INSTAGRAM_USERNAME/);
  assert.throws(() => instagramProfileUrl('https://instagram.com/tony'), /INVALID_INSTAGRAM_USERNAME/);
});

test('normalizes publication metadata and immutable media paths', () => {
  const photo = normalizePublishedPhoto({
    id: 'porsche-911-sunset', title: { en: 'Sunset', zh: '落日' }, alt: { en: 'A Porsche', zh: '一辆保时捷' },
    location: { en: 'Monterey', zh: '蒙特雷' }, vehicle: { en: 'Porsche 911', zh: '保时捷 911' }, capturedAt: '2026-08-11', width: 6000, height: 4000, featured: true,
  });
  const original = mediaPath('original', photo.id, 'jpg', 2026);
  const preview = mediaPath('preview', photo.id, 'webp', 2026);
  const jpegPreview = mediaPath('preview', photo.id, 'jpg', 2026);
  const entry = buildGalleryEntry(photo, original, preview, 'widmonstertony', 'Photography');
  assert.equal(original, 'originals/2026/porsche-911-sunset.jpg');
  assert.equal(jpegPreview, 'previews/2026/porsche-911-sunset.jpg');
  assert.equal(entry.original, 'https://raw.githubusercontent.com/widmonstertony/Photography/media/originals/2026/porsche-911-sunset.jpg');
  assert.equal(entry.featured, true);

  const asset = originalAssetName(photo.id, 'jpg');
  const releaseEntry = buildGalleryEntry(photo, `https://github.com/widmonstertony/Photography/releases/download/photography-originals-v1/${asset}`, preview, 'widmonstertony', 'Photography');
  assert.equal(asset, 'porsche-911-sunset.jpg');
  assert.match(releaseEntry.original, /\/releases\/download\/photography-originals-v1\/porsche-911-sunset\.jpg$/);
});

test('rejects malformed ids and incomplete bilingual accessibility copy', () => {
  assert.throws(() => mediaPath('original', '../escape', 'jpg', 2026), /INVALID_ID/);
  assert.throws(() => originalAssetName('../escape', 'jpg'), /INVALID_ID/);
  assert.throws(() => buildGalleryEntry({ id: 'valid-photo-id' }, 'https://attacker.example/photo.jpg', 'preview.webp', 'widmonstertony', 'Photography'), /INVALID_MEDIA_URL/);
  assert.throws(() => normalizePublishedPhoto({ id: 'valid-photo-id', title: { en: '', zh: '' }, alt: { en: 'x', zh: 'x' }, width: 1, height: 1 }), /INVALID_METADATA/);
});

test('updates display metadata without changing immutable media fields', () => {
  const existing = {
    id: 'porsche-911-sunset', publishedAt: '2026-08-11T00:00:00.000Z', width: 6000, height: 4000,
    original: 'https://raw.githubusercontent.com/widmonstertony/Photography/media/originals/2026/porsche.jpg',
    preview: 'https://raw.githubusercontent.com/widmonstertony/Photography/media/previews/2026/porsche.webp',
  };
  const edited = updateGalleryEntryMetadata(existing, {
    title: { en: ' Evening Light ', zh: ' 暮色 ' }, alt: { en: 'A complete Porsche portrait', zh: '完整的保时捷肖像' },
    vehicle: { en: 'Porsche 911', zh: '保时捷 911' }, location: { en: 'Monterey', zh: '蒙特雷' },
    capturedAt: '2026-08-12', camera: 'Sony A7 IV', lens: '35mm', featured: true,
  });

  assert.equal(edited.title.en, 'Evening Light');
  assert.equal(edited.original, existing.original);
  assert.equal(edited.preview, existing.preview);
  assert.equal(edited.publishedAt, existing.publishedAt);
  assert.equal(edited.width, existing.width);
  assert.equal(edited.featured, true);
});

test('resolves only this repository media when permanently deleting a photograph', () => {
  const release = {
    id: 'porsche-911-sunset',
    preview: 'https://raw.githubusercontent.com/widmonstertony/Photography/media/previews/2026/porsche-911-sunset.jpg',
    original: 'https://github.com/widmonstertony/Photography/releases/download/photography-originals-v1/porsche-911-sunset.jpg',
  };
  assert.deepEqual(galleryMediaTargets(release, 'widmonstertony', 'Photography'), {
    previewPath: 'previews/2026/porsche-911-sunset.jpg',
    repositoryOriginalPath: null,
    releaseOriginalName: 'porsche-911-sunset.jpg',
  });

  const legacy = { ...release, original: 'https://raw.githubusercontent.com/widmonstertony/Photography/media/originals/2025/porsche-911-sunset.webp' };
  assert.deepEqual(galleryMediaTargets(legacy, 'widmonstertony', 'Photography'), {
    previewPath: 'previews/2026/porsche-911-sunset.jpg',
    repositoryOriginalPath: 'originals/2025/porsche-911-sunset.webp',
    releaseOriginalName: null,
  });
});

test('refuses to delete media outside the exact Photography paths', () => {
  const item = {
    id: 'porsche-911-sunset',
    preview: 'https://raw.githubusercontent.com/attacker/Photography/media/previews/2026/porsche-911-sunset.jpg',
    original: 'https://github.com/widmonstertony/Photography/releases/download/photography-originals-v1/porsche-911-sunset.jpg',
  };
  assert.throws(() => galleryMediaTargets(item, 'widmonstertony', 'Photography'), /INVALID_MEDIA_REFERENCE/);
  assert.throws(() => galleryMediaTargets({ ...item, preview: item.preview.replace('attacker', 'widmonstertony'), original: 'https://github.com/widmonstertony/Other/releases/download/photography-originals-v1/porsche-911-sunset.jpg' }, 'widmonstertony', 'Photography'), /INVALID_MEDIA_REFERENCE/);
});

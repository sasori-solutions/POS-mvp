import { readFileSync } from 'node:fs';

/** A decoded one-pixel synthetic JPEG with a bounded, harmless comment segment.
 * The comment permits exercising multipart upload without human image data.
 */
export function profileJpeg(commentBytes = 0) {
  const image = readFileSync('tests/fixtures/profile-pixel.jpg');
  if (!commentBytes) return image.toString('base64');
  const header = Buffer.from([0xff, 0xfe, (commentBytes + 2) >> 8, (commentBytes + 2) & 0xff]);
  return Buffer.concat([image.subarray(0, 2), header, Buffer.alloc(commentBytes), image.subarray(2)]).toString('base64');
}

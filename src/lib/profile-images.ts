import { accountRequest } from './account';
import type { BusinessContext } from './contracts';

export type ProfileImageSubject = 'business' | 'account';
export interface ProfileImageUpload {
  imageId: string; data: string; operations: string[]; nextPart: number; preview: string;
}

/** Convert photos to bounded, static JPEG. Raw files and EXIF never enter the profile. */
export async function prepareProfileImage(file: File): Promise<ProfileImageUpload> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024)
    throw new Error('Elige una imagen JPG, PNG o WebP de hasta 8 MB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('No pudimos leer la imagen. Elige otra.'); }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('No pudimos leer la imagen. Elige otra.');
    const ratio = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No pudimos preparar la imagen.');
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let preview = canvas.toDataURL('image/jpeg', .8);
    if (preview.length > 245783) preview = canvas.toDataURL('image/jpeg', .5);
    if (preview.length > 245783 || !preview.startsWith('data:image/jpeg;base64,'))
      throw new Error('La imagen es demasiado grande. Elige otra.');
    const data = preview.split(',')[1];
    return { imageId: crypto.randomUUID(), data, preview, nextPart: 0, operations: Array.from({ length: Math.ceil(data.length / 4096) }, () => crypto.randomUUID()) };
  } finally { bitmap.close(); }
}

/** Resume at the same part and operation UUID after response loss. */
export async function sendProfileImage(access: { businessId: string; operatorToken: string }, subject: ProfileImageSubject, upload: ProfileImageUpload): Promise<BusinessContext> {
  let business: BusinessContext | undefined;
  while (upload.nextPart < upload.operations.length) {
    const part = upload.nextPart;
    const result = await accountRequest({ action: 'upload_profile_image', ...access, subject, imageId: upload.imageId,
      operationId: upload.operations[part], part, parts: upload.operations.length, data: upload.data.slice(part * 4096, (part + 1) * 4096) });
    if (part === upload.operations.length - 1) {
      if (!result.complete || !result.business) throw new Error('La imagen no se guardó. Intenta de nuevo.');
      business = result.business;
    }
    upload.nextPart += 1;
  }
  if (!business) throw new Error('La imagen no se guardó. Intenta de nuevo.');
  return business;
}

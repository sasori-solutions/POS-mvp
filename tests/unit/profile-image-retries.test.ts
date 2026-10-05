import { expect, test, vi, afterEach } from 'vitest';
import { accountRequest } from '../../src/lib/account';
import { prepareProfileImage, sendProfileImage, type ProfileImageUpload } from '../../src/lib/profile-images';
import type { BusinessContext } from '../../src/lib/contracts';

vi.mock('../../src/lib/account', () => ({ accountRequest: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

test('image decode failures show a brief Spanish error without browser internals', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new DOMException('The source image could not be decoded.', 'InvalidStateError')));
  await expect(prepareProfileImage(new File(['invalid'], 'synthetic.jpg', { type: 'image/jpeg' }))).rejects.toThrow('No pudimos leer la imagen. Elige otra.');
});

test('upload retries reuse the exact part, image ID and operation UUID after response loss', async () => {
  const business = { id: 'business', logoUrl: 'data:image/jpeg;base64,image' } as BusinessContext;
  const upload: ProfileImageUpload = { imageId: 'image-id', data: 'A'.repeat(4096) + 'BBBB', preview: '', operations: ['part-0', 'part-1'], nextPart: 0 };
  vi.mocked(accountRequest)
    .mockResolvedValueOnce({ imageId: upload.imageId, complete: false } as never)
    .mockRejectedValueOnce(new Error('Respuesta perdida'))
    .mockResolvedValueOnce({ imageId: upload.imageId, complete: true, business } as never);
  const access = { businessId: 'business', operatorToken: 'a'.repeat(64) };
  await expect(sendProfileImage(access, 'business', upload)).rejects.toThrow('Respuesta perdida');
  expect(upload.nextPart).toBe(1);
  expect(await sendProfileImage(access, 'business', upload)).toBe(business);
  expect(vi.mocked(accountRequest).mock.calls[1][0]).toEqual(vi.mocked(accountRequest).mock.calls[2][0]);
  expect(vi.mocked(accountRequest).mock.calls.map(([request]) => 'part' in request ? request.part : undefined)).toEqual([0, 1, 1]);
  expect(upload.nextPart).toBe(2);
});

test('the last part is not accepted client-side until the server returns a complete persisted business', async () => {
  const upload: ProfileImageUpload = { imageId: 'image-id', data: 'AAAA', preview: '', operations: ['part-0'], nextPart: 0 };
  vi.mocked(accountRequest).mockResolvedValueOnce({ imageId: upload.imageId, complete: false } as never);
  await expect(sendProfileImage({ businessId: 'business', operatorToken: 'a'.repeat(64) }, 'account', upload)).rejects.toThrow('La imagen no se guardó');
  expect(upload.nextPart).toBe(0);
});

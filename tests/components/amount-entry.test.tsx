// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import AmountEntry from '../../src/components/AmountEntry';

const originalShow = HTMLDialogElement.prototype.showModal, originalClose = HTMLDialogElement.prototype.close;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
afterAll(() => { HTMLDialogElement.prototype.showModal = originalShow; HTMLDialogElement.prototype.close = originalClose; });

test('keypad decimal entry adds exact cents and resets only after acceptance', async () => {
  const onAdd = vi.fn().mockResolvedValue(true);
  render(<AmountEntry onAdd={onAdd} onCancel={vi.fn()} />);
  expect((screen.getByRole('button', { name: 'Añadir $0.00' }) as HTMLButtonElement).disabled).toBe(true);
  const keypad = within(screen.getByRole('group', { name: 'Teclado de importe' }));
  for (const name of ['Punto decimal', '0', '1', '2']) fireEvent.click(keypad.getByRole('button', { name }));
  expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe('0.01');
  fireEvent.click(screen.getByRole('button', { name: 'Añadir $0.01' }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(1, ''));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe(''));
  expect(screen.getByRole('textbox', { name: 'Importe' }).getAttribute('inputmode')).toBe('none');
});

test('physical keyboard and an optional concept submit the maximum amount, while invalid fractional amounts stay blocked', async () => {
  const onAdd = vi.fn().mockResolvedValue(true);
  render(<AmountEntry onAdd={onAdd} onCancel={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: 'Importe' });
  fireEvent.change(input, { target: { value: '1.001' } });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').textContent).toContain('dos decimales');
  expect((screen.getByRole('button', { name: 'Añadir $0.00' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: '999999.99' } });
  fireEvent.click(screen.getByRole('button', { name: 'Añadir concepto' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Concepto (opcional)' }), { target: { value: '  Servicio especial  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith(99999999, 'Servicio especial'));
});

test('clear and cancel are distinct and failures preserve input with a visible retry error', async () => {
  const onAdd = vi.fn().mockRejectedValue(new Error('Cuenta cambiada. Reintenta.'));
  const onCancel = vi.fn();
  render(<AmountEntry onAdd={onAdd} onCancel={onCancel} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Importe' }), { target: { value: '25.50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Añadir $25.50' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe('Cuenta cambiada. Reintenta.');
  expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe('25.50');
  fireEvent.click(screen.getByRole('button', { name: 'Borrar importe' }));
  expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe('');
  expect(onCancel).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Importe' }), { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledOnce();
});

test('a pending addition disables the keypad and accepts only one submission', async () => {
  let accept!: (accepted: boolean) => void;
  const onAdd = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
  render(<AmountEntry onAdd={onAdd} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Importe' }), { target: { value: '10' } });
  const add = screen.getByRole('button', { name: 'Añadir $10.00' });
  fireEvent.click(add);
  fireEvent.click(add);
  expect(onAdd).toHaveBeenCalledOnce();
  expect((screen.getByRole('button', { name: '1' }) as HTMLButtonElement).disabled).toBe(true);
  accept(false);
  await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe('10');
});

test('short phones open an accessible dialog focused on cancel and close after accepting once', async () => {
  vi.stubGlobal('matchMedia', vi.fn(query => ({ matches: query.includes('height < 700px'), addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const onCancel = vi.fn(), onAdd = vi.fn().mockResolvedValue(true);
  render(<AmountEntry onAdd={onAdd} onCancel={onCancel} />);
  const dialog = screen.getByRole('dialog', { name: 'Importe' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancelar' }));
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
  expect(onCancel).toHaveBeenCalledOnce();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Importe' }), { target: { value: '0.01' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Añadir $0.01' }));
  await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(2));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith(1, '');
  expect((within(dialog).getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe('');
});

test('changing phone height preserves the amount and concept while removing the modal body lock', () => {
  let changed!: () => void;
  const media = { matches: true, addEventListener: vi.fn((_event: string, listener: () => void) => { changed = listener; }), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(query => query.includes('height < 700px') ? media : { matches: false }));
  render(<AmountEntry onAdd={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Importe' }), { target: { value: '25.30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Añadir concepto' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Concepto (opcional)' }), { target: { value: 'Entrega especial' } });
  act(() => { media.matches = false; changed(); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement).value).toBe('25.30');
  expect((screen.getByRole('textbox', { name: 'Concepto (opcional)' }) as HTMLInputElement).value).toBe('Entrega especial');
  expect(document.body.style.overflow).toBe('');
});

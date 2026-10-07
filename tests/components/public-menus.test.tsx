// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { randomUUID } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MenuManager from '../../src/components/MenuManager';
import PublicMenu from '../../src/components/PublicMenu';
import { AccountClientError } from '../../src/lib/account';
import { posRequest } from '../../src/lib/pos';
import { fetchPublicMenu, PublicMenuError } from '../../src/lib/menu-client';
import type { MenuConfiguration, PublicMenuDocument } from '../../src/lib/menu-contracts';
import type { Product } from '../../src/lib/pos-contracts';
vi.mock('../../src/lib/pos', async original => ({ ...(await original<typeof import('../../src/lib/pos')>()), posRequest: vi.fn() }));
vi.mock('../../src/lib/menu-client', async original => ({ ...(await original<typeof import('../../src/lib/menu-client')>()), fetchPublicMenu: vi.fn() }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const access = { businessId: randomUUID(), operatorToken: 'a'.repeat(64) }, actorId = randomUUID();
const product: Product = { id: randomUUID(), name: 'Café sintético', category: '', priceCents: 1001, active: true, version: 1 };
const document: PublicMenuDocument = { publicId: randomUUID(), businessName: 'Café del piloto', name: 'Desayunos', locationLabel: 'Barra', timezone: 'America/Hermosillo', asOf: '2026-10-07T09:00:00Z', availability: 'open', schedules: [], products: [{ id: product.id, name: product.name, category: '', priceCents: 1001, available: false, variablePrice: false, description: 'Preparado al momento', dietary: '', allergens: 'Leche', image: null, variations: [], modifierGroups: [], comboComponents: [] }] };
describe('menu publication review and public refresh', () => {
  it('shows public data disclosure, starts with a draft and retains the exact publication UUID/payload across reload after a lost response', async () => {
    vi.mocked(posRequest).mockResolvedValueOnce({ menus: [] } as never);
    const props = { access, actorId, products: [product] }; const view = render(<MenuManager {...props} />);
    await screen.findByText('Aún no tienes menús publicados. Crea uno con los productos que verá el cliente.');
    fireEvent.click(screen.getByRole('button', { name: 'Crear menú' }));
    expect(screen.getByLabelText('Publicar este menú')).not.toBeChecked(); expect(screen.getByText(/Al publicar, cualquier persona/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Nombre del menú'), { target: { value: 'Desayunos' } }); fireEvent.click(screen.getByLabelText('Café sintético')); fireEvent.click(screen.getByLabelText('Publicar este menú'));
    fireEvent.click(screen.getByRole('button', { name: 'Añadir horario' }));
    vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Se perdió la respuesta.'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar y publicar menú' })); await screen.findByText('Se perdió la respuesta.');
    expect(screen.getByRole('button', { name: 'Descartar solicitud rechazada' })).toBeDisabled();
    const original = structuredClone(vi.mocked(posRequest).mock.calls[1][1]); view.unmount();
    vi.mocked(posRequest).mockResolvedValueOnce({ menus: [] } as never);
    render(<MenuManager {...props} />); await screen.findByRole('button', { name: 'Reintentar solicitud original' });
    const command = original as Extract<typeof original, { command: 'save_menu' }>;
    const saved: MenuConfiguration = { id: command.menuId, publicId: randomUUID(), revision: 1, updatedAt: '2026-10-07T09:00:00Z', name: command.name, locationLabel: command.locationLabel, published: true, productIds: command.productIds,
      schedules: command.schedules.map(schedule => ({ endMinute: schedule.endMinute, weekdays: schedule.weekdays, startMinute: schedule.startMinute })) };
    vi.mocked(posRequest).mockResolvedValueOnce(saved as never);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud original' }));
    await screen.findByText('Menú publicado. El QR consulta los precios y la disponibilidad actuales.');
    expect(vi.mocked(posRequest).mock.calls[3][1]).toEqual(original);
    expect(screen.getByLabelText('QR del menú Desayunos')).toBeInTheDocument(); expect(localStorage.length).toBe(0);
  });

  it('shows sold-out products without checkout controls, and removes the menu when publication was revoked', async () => {
    vi.mocked(fetchPublicMenu).mockResolvedValueOnce(document);
    render(<PublicMenu menuId={document.publicId} />);
    await screen.findByRole('heading', { name: 'Café sintético' }); expect(screen.getByText('Agotado')).toBeVisible(); expect(screen.getByText(/Pide y paga con el personal/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Pagar|Añadir|Reservar/ })).not.toBeInTheDocument();
    vi.mocked(fetchPublicMenu).mockRejectedValueOnce(new PublicMenuError(true, 'Este menú ya no está disponible.'));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar menú' })); await screen.findByText('Este menú ya no está disponible.');
    expect(screen.queryByRole('heading', { name: 'Café sintético' })).not.toBeInTheDocument();
  });

  it('does not restore a late response from another public menu route', async () => {
    let finish: (value: PublicMenuDocument) => void = () => {};
    vi.mocked(fetchPublicMenu).mockImplementationOnce(async () => await new Promise<PublicMenuDocument>(resolve => { finish = resolve; }));
    const view = render(<PublicMenu menuId={document.publicId} />); const next = { ...document, publicId: randomUUID(), name: 'Menú siguiente', products: [] };
    vi.mocked(fetchPublicMenu).mockResolvedValueOnce(next); view.rerender(<PublicMenu menuId={next.publicId} />);
    await screen.findByRole('heading', { name: 'Menú siguiente' }); finish(document);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Menú siguiente' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Desayunos' })).not.toBeInTheDocument();
  });

  it('shows remaining products when automatic refresh removes the selected category', async () => {
    const coffee = { ...document.products[0], category: 'Bebidas', available: true };
    const bread = { ...coffee, id: randomUUID(), name: 'Pan sintético', category: 'Panadería' };
    const first = { ...document, products: [coffee, bread] };
    vi.mocked(fetchPublicMenu).mockResolvedValueOnce(first);
    render(<PublicMenu menuId={first.publicId} />);
    await screen.findByRole('heading', { name: coffee.name });
    fireEvent.click(screen.getByRole('button', { name: 'Bebidas' }));
    expect(screen.queryByRole('heading', { name: bread.name })).not.toBeInTheDocument();
    vi.mocked(fetchPublicMenu).mockResolvedValueOnce({ ...first, products: [bread] });
    fireEvent(globalThis.document, new Event('visibilitychange'));
    await screen.findByRole('heading', { name: bread.name });
    expect(fetchPublicMenu).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('heading', { name: coffee.name })).not.toBeInTheDocument();
  });

  it.each(['accepted', 'refused'])('preserves the new same-actor recovery when a previous session returns a late %s save', async outcome => {
    const sessionError = vi.fn(), key = `pos-menu-edit-v1:${access.businessId}:${actorId}`;
    let resolveOld: (saved: MenuConfiguration) => void = () => {}, rejectOld: (error: Error) => void = () => {};
    vi.mocked(posRequest).mockResolvedValueOnce({ menus: [] } as never);
    const previous = render(<MenuManager access={access} actorId={actorId} products={[product]} onSessionError={sessionError} />);
    await screen.findByRole('button', { name: 'Crear menú' }); fireEvent.click(screen.getByRole('button', { name: 'Crear menú' }));
    fireEvent.change(screen.getByLabelText('Nombre del menú'), { target: { value: 'Solicitud anterior' } });
    vi.mocked(posRequest).mockImplementationOnce(async () => await new Promise<never>((resolve, reject) => { resolveOld = saved => resolve(saved as never); rejectOld = reject; }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await waitFor(() => expect(posRequest).toHaveBeenCalledTimes(2));
    const original = JSON.parse(localStorage.getItem(key)!).command as Extract<MenuConfigurationCommand, { command: 'save_menu' }>;
    previous.unmount();
    vi.mocked(posRequest).mockResolvedValueOnce({ menus: [] } as never);
    render(<MenuManager access={{ ...access, operatorToken: 'b'.repeat(64) }} actorId={actorId} products={[product]} />);
    await screen.findByRole('button', { name: 'Reintentar solicitud original' });
    vi.mocked(posRequest).mockResolvedValueOnce(savedMenu(original) as never);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud original' }));
    await screen.findByText('Borrador guardado. Su enlace público está desactivado.');
    expect(vi.mocked(posRequest).mock.calls[3][1]).toEqual(original);
    fireEvent.click(screen.getByRole('button', { name: 'Crear menú' }));
    fireEvent.change(screen.getByLabelText('Nombre del menú'), { target: { value: 'Solicitud vigente' } });
    vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('NETWORK_ERROR', 'Respuesta vigente pendiente'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' })); await screen.findByText('Respuesta vigente pendiente');
    const currentLedger = localStorage.getItem(key)!, current = JSON.parse(currentLedger).command as Extract<MenuConfigurationCommand, { command: 'save_menu' }>;
    expect(current.operationId).not.toBe(original.operationId);
    await act(async () => { if (outcome === 'accepted') resolveOld(savedMenu(original)); else rejectOld(new AccountClientError('PERMISSION_DENIED', 'Respuesta de la sesión anterior')); });
    expect(localStorage.getItem(key)).toBe(currentLedger); expect(sessionError).not.toHaveBeenCalled();
    expect(screen.getByText('Respuesta vigente pendiente')).toBeVisible();
    vi.mocked(posRequest).mockResolvedValueOnce(savedMenu(current) as never);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar solicitud original' }));
    await screen.findByText('Borrador guardado. Su enlace público está desactivado.');
    expect(vi.mocked(posRequest).mock.calls[5][1]).toEqual(current); expect(localStorage.getItem(key)).toBeNull();
  });

  it('preserves an uncertain menu save when authorization fails before replay', async () => {
    const sessionError = vi.fn(); vi.mocked(posRequest).mockResolvedValueOnce({ menus: [] } as never);
    render(<MenuManager access={access} actorId={actorId} products={[product]} onSessionError={sessionError} />);
    await screen.findByRole('button', { name: 'Crear menú' }); fireEvent.click(screen.getByRole('button', { name: 'Crear menú' }));
    fireEvent.change(screen.getByLabelText('Nombre del menú'), { target: { value: 'Resultado pendiente' } });
    vi.mocked(posRequest).mockRejectedValueOnce(new AccountClientError('SESSION_INVALID', 'Sesión terminada'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar borrador' }));
    await screen.findByText('Sesión terminada');
    expect(JSON.parse(localStorage.getItem(`pos-menu-edit-v1:${access.businessId}:${actorId}`)!)).toMatchObject({ uncertain: true });
    expect(sessionError).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: 'Descartar solicitud rechazada' })).not.toBeInTheDocument();
  });
});

type MenuConfigurationCommand = import('../../src/lib/menu-contracts').MenuCommand;
function savedMenu(command: Extract<MenuConfigurationCommand, { command: 'save_menu' }>): MenuConfiguration { return { id: command.menuId, publicId: randomUUID(), revision: (command.expectedRevision ?? 0) + 1, name: command.name, locationLabel: command.locationLabel, productIds: command.productIds, schedules: command.schedules, published: command.published, updatedAt: '2026-10-07T12:00:00Z' }; }

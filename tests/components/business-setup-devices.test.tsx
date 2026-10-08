// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BusinessSetup, { type BusinessDraft } from '../../src/components/BusinessSetup';
import TeamPanel from '../../src/components/TeamPanel';
import { newBusinessProfile } from '../../src/lib/business-profile';
import { accountRequest, AccountClientError } from '../../src/lib/account';
import type { BusinessContext, DeviceSummary } from '../../src/lib/contracts';

vi.mock('../../src/lib/account', async importOriginal => ({ ...(await importOriginal<typeof import('../../src/lib/account')>()), accountRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('business creation decisions and device visibility', () => {
  it('uses a subordinate heading when the workspace already owns the page title', async () => {
    vi.mocked(accountRequest).mockResolvedValue({ employees: [], invitations: [], devices: [] } as never);
    const view = render(<TeamPanel business={business} operatorToken={'a'.repeat(64)} section="devices" embeddedTitle onBack={() => {}} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Dispositivos' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    view.rerender(<TeamPanel business={business} operatorToken={'a'.repeat(64)} section="devices" onBack={() => {}} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dispositivos' })).toBeInTheDocument();
    await waitFor(() => expect(accountRequest).toHaveBeenCalled());
  });
  it('hides device data and informs the workspace when this browser was revoked elsewhere', async () => {
    vi.mocked(accountRequest).mockRejectedValueOnce(new AccountClientError('DEVICE_REVOKED', 'Navegador revocado.'));
    const sessionError = vi.fn();
    render(<TeamPanel business={business} operatorToken={'a'.repeat(64)} section="devices" onBack={() => {}} onSessionError={sessionError} />);
    await waitFor(() => expect(sessionError).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEVICE_REVOKED' })));
    expect(screen.queryByRole('button', { name: /Desvincular/ })).not.toBeInTheDocument();
  });
  it('requires an explicit initial tax decision and places timezone correction out of the main choices', () => {
    const submitted = vi.fn();
    render(<Setup submitted={submitted} />);
    expect(screen.getByText(/Usaremos la hora de este dispositivo/)).toHaveTextContent('Hermosillo');
    expect(screen.getByText('Mi local está en otro horario').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    const tax = screen.getByLabelText('¿Qué IVA usas en tus precios?') as HTMLSelectElement;
    expect(tax.value).toBe(''); expect(tax.checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: /Cuentas abiertas/ }));
    expect(tax.value).toBe('');
    fireEvent.submit(screen.getByRole('button', { name: 'Continuar' }).closest('form')!);
    expect(submitted).not.toHaveBeenCalled();
    fireEvent.change(tax, { target: { value: 'unconfigured' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continuar' }).closest('form')!);
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/Hermosillo', profile: expect.objectContaining({ defaultVatTreatment: 'unconfigured', accountsEnabled: true }) }));
  });

  it('keeps transfer setup optional, validates receiving details and can remove them', () => {
    const submitted = vi.fn(); render(<Setup submitted={submitted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    fireEvent.change(screen.getByLabelText('¿Qué IVA usas en tus precios?'), { target: { value: 'vat_16' } });
    fireEvent.click(screen.getByLabelText('Transferencia'));
    fireEvent.click(screen.getByRole('button', { name: 'Añadir cuenta bancaria' }));
    fireEvent.change(screen.getByLabelText('Beneficiario'), { target: { value: 'Comercio sintético' } });
    fireEvent.change(screen.getByLabelText('Banco'), { target: { value: 'Banco sintético' } });
    fireEvent.change(screen.getByLabelText('CLABE'), { target: { value: '000000000000000001' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continuar' }).closest('form')!);
    expect(submitted).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('CLABE');
    fireEvent.change(screen.getByLabelText('CLABE'), { target: { value: '000000000000000000' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Continuar' }).closest('form')!);
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ transferAccount: { beneficiary: 'Comercio sintético', bank: 'Banco sintético', clabe: '000000000000000000' } }) }));
    submitted.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Quitar cuenta bancaria' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Continuar' }).closest('form')!);
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ transferAccount: null }) }));
  });

  it.each([true, false])('distinguishes the current browser and closes only self-revocation (current=%s)', async current => {
    const devices: DeviceSummary[] = [{ id: 'device-1', name: 'Navegador sintético', registerName: '', active: true, kind: 'owner_browser', current, employeeName: 'Dueño sintético', lastSeenAt: '2026-10-07T08:00:00Z' }];
    let finishRevoke: ((value: never) => void) | undefined;
    vi.mocked(accountRequest).mockImplementation(async request => request.action === 'team' ? { employees: [], invitations: [], devices } as never : current ? await new Promise<never>(resolve => { finishRevoke = resolve; }) : { revoked: true } as never);
    const sessionError = vi.fn();
    render(<TeamPanel business={business} operatorToken={'a'.repeat(64)} section="devices" onBack={() => {}} onSessionError={sessionError} />);
    await screen.findByRole('button', { name: 'Desvincular Navegador sintético' });
    expect(screen.getByText(/Última actividad:/)).toBeVisible();
    expect(Boolean(screen.queryByText(/· Este dispositivo/))).toBe(current);
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular Navegador sintético' }));
    expect(screen.getByText(/Se cerrarán las sesiones/)).toHaveTextContent(current ? 'Este es el navegador que estás usando' : 'administrar el negocio desde otro navegador');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar desvinculación' }));
    await waitFor(() => expect(accountRequest).toHaveBeenCalledWith(expect.objectContaining({ action: 'revoke_device', deviceId: 'device-1' })));
    if (current) {
      await waitFor(() => expect(sessionError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_INVALID' })));
      expect(screen.queryByRole('button', { name: 'Desvincular Navegador sintético' })).not.toBeInTheDocument();
      expect(accountRequest).toHaveBeenCalledTimes(2);
      finishRevoke?.({ revoked: true } as never);
    } else {
      await screen.findByText('Dispositivo desvinculado. Ya no permite entrar al negocio.'); expect(sessionError).not.toHaveBeenCalled();
    }
  });
});

function Setup({ submitted }: { submitted: (draft: BusinessDraft) => void }) {
  const [draft, setDraft] = useState<BusinessDraft>({ name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Hermosillo', profile: newBusinessProfile() });
  return <BusinessSetup draft={draft} onChange={setDraft} error="" onSubmit={event => { event.preventDefault(); submitted(draft); }} />;
}
const business: BusinessContext = { id: 'business-1', name: 'Negocio sintético', businessType: 'cafe', timezone: 'America/Hermosillo', currency: 'MXN', role: 'owner', createdAt: '2026-10-07T08:00:00Z', profile: newBusinessProfile() };

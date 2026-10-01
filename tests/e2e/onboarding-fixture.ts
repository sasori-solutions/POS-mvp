import type { Page } from '@playwright/test';
import type { AccountRequest, BusinessContext, BusinessRole, DeviceSummary, EmployeeSummary, InvitationSummary } from '../../src/lib/contracts';
import { fixtureBusiness, fixtureOperatorToken, fixturePin, mockAccount } from './account-fixture';

export const fixtureInvitation = 'c1'.repeat(32);
export const fixturePairingCode = 'b2'.repeat(32);
export const fixtureDeviceToken = 'd3'.repeat(32);
export const fixtureKitchen = { id: '84c75082-4633-4f53-8f34-a2ed0c7b2e66', name: 'Cocina de prueba', role: 'kitchen' as const, active: true };
export const fixtureCashier = { id: 'b1041684-c36b-4360-a98b-ce41c821cf41', name: 'Caja de prueba', role: 'cashier' as const, active: true };
export const fixtureCashierPin = '014682';
export const fixtureDeviceId = '20b56f6a-080d-4f03-99eb-545edb79a548';

/** Network boundary only. The browser runs the production React/Auth code. */
export async function mockOnboarding(page: Page, options: {
  existingBusiness?: boolean;
  authenticated?: boolean;
  role?: BusinessRole;
  requirePinReauth?: boolean;
} = {}) {
  await mockAccount(page, { existingBusiness: options.existingBusiness, authenticated: options.authenticated });
  const calls: AccountRequest[] = [];
  const authorizations: { action: string; authorization: string | undefined }[] = [];
  let hasBusiness = options.existingBusiness ?? false;
  let business: BusinessContext = structuredClone(fixtureBusiness) as BusinessContext;
  let googleRole: BusinessRole = options.role ?? 'owner';
  let currentPin = fixturePin;
  let locked = true;
  let paired = false;
  let deviceRevoked = false;
  let operatorGeneration = 0;
  let currentDeviceOperator = '';
  let currentDeviceEmployee: EmployeeSummary = fixtureCashier;
  const employees: EmployeeSummary[] = [
    { id: '5f9bf172-13ae-4df5-84be-3975d90e1f65', name: 'Persona de prueba', role: 'owner', active: true },
    { ...fixtureCashier }, { ...fixtureKitchen },
  ];
  const invitations: InvitationSummary[] = [];
  const devices: DeviceSummary[] = [];
  const expiresAt = () => new Date(Date.now() + 8 * 3_600_000).toISOString();
  const summary = () => ({ id: business.id, name: business.name, businessType: business.businessType });
  const projection = (role = googleRole, employee: EmployeeSummary = role === 'kitchen' ? fixtureKitchen : fixtureCashier): BusinessContext => role === 'owner'
    ? { ...business, role }
    : { ...business, role, employee: { id: employee.id, name: employee.name, role }, profile: {
      branchName: '', registerName: '', address: '', city: '', state: '', contactPhone: '', paymentMethods: [],
    } };
  const unlocked = () => ({ business: projection(), operatorToken: fixtureOperatorToken, expiresAt: expiresAt() });

  await page.route('http://127.0.0.1:54321/functions/v1/account', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    const body = route.request().postDataJSON() as AccountRequest;
    calls.push(body);
    authorizations.push({ action: body.action, authorization: route.request().headers().authorization });
    const reply = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    const reject = (status: number, code: string, message: string) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message } }) });
    if (body.action.startsWith('device_') && body.action !== 'device_pair' && deviceRevoked) {
      return reject(401, 'DEVICE_REVOKED', 'El dispositivo fue revocado.');
    }
    switch (body.action) {
      case 'status': return reply({ businesses: hasBusiness ? [summary()] : [] });
      case 'create_business':
        if (!body.profile?.branchName || !body.profile.registerName) return reject(400, 'VALIDATION_ERROR', 'Completa sucursal y caja.');
        business = { ...business, name: body.name, businessType: body.businessType, timezone: body.timezone, profile: body.profile };
        currentPin = body.pin;
        hasBusiness = true;
        googleRole = 'owner';
        locked = false;
        return reply(unlocked());
      case 'unlock':
        if (body.pin !== currentPin) return reject(401, 'PIN_INVALID', 'PIN incorrecto.');
        locked = false;
        return reply(unlocked());
      case 'context': return locked ? reject(401, 'SESSION_INVALID', 'La sesión está bloqueada.') : reply({ business: projection(), expiresAt: expiresAt() });
      case 'lock': case 'revoke_sessions':
        locked = true;
        return reply(body.action === 'lock' ? { locked: true } : { revoked: true });
      case 'update_business':
        if (locked || googleRole !== 'owner') return reject(403, 'PERMISSION_DENIED', 'Acceso restringido.');
        business = { ...business, name: body.name, businessType: body.businessType, timezone: body.timezone, profile: body.profile };
        return reply(projection());
      case 'accept_invitation':
        if (body.invitationCode !== fixtureInvitation) return reject(400, 'INVITATION_INVALID', 'Invitación inválida o vencida.');
        if (body.pin.length !== 6 || !body.name.trim()) return reject(400, 'VALIDATION_ERROR', 'Completa nombre y PIN.');
        hasBusiness = true;
        googleRole = 'kitchen';
        currentPin = body.pin;
        locked = false;
        return reply({ ...unlocked(), business: { ...projection(), employee: { id: fixtureKitchen.id, name: body.name, role: 'kitchen' } } });
      case 'reset_pin':
        if (options.requirePinReauth && calls.filter((call) => call.action === 'status').length < 2) return reject(401, 'REAUTH_REQUIRED', 'Vuelve a verificar tu cuenta de Google.');
        currentPin = body.pin;
        locked = false;
        return reply(unlocked());
      case 'team':
        if (locked || googleRole !== 'owner') return reject(403, 'PERMISSION_DENIED', 'Acceso restringido.');
        return reply({ employees, invitations, devices });
      case 'create_employee': {
        const employee = { id: '6bfa7b67-f54b-49a1-89f7-0f2d8f9e876e', name: body.name, role: body.role, active: true };
        employees.push(employee);
        return reply(employee);
      }
      case 'update_employee': {
        const employee = employees.find((item) => item.id === body.employeeId);
        if (!employee) return reject(404, 'EMPLOYEE_INACTIVE', 'Empleado no disponible.');
        Object.assign(employee, { name: body.name, role: body.role, active: body.active });
        return reply(employee);
      }
      case 'create_invitation': {
        const invitationId = 'c61b6b8c-9392-461a-a499-28ae107030c1';
        const expiration = expiresAt();
        invitations.push({ id: invitationId, name: body.name, role: body.role, active: true, expiresAt: expiration });
        return reply({ invitationCode: fixtureInvitation, invitationId, expiresAt: expiration });
      }
      case 'revoke_invitation': {
        const invitation = invitations.find((item) => item.id === body.invitationId);
        if (invitation) invitation.active = false;
        return reply({ revoked: true });
      }
      case 'create_pairing_code': return reply({ pairingCode: fixturePairingCode, expiresAt: expiresAt() });
      case 'device_pair':
        if (body.pairingCode !== fixturePairingCode) return reject(400, 'PAIRING_INVALID', 'Código inválido o vencido.');
        paired = true;
        deviceRevoked = false;
        devices.push({ id: fixtureDeviceId, name: body.deviceName, registerName: business.profile.registerName, active: true });
        return reply({ deviceId: fixtureDeviceId, deviceToken: fixtureDeviceToken, business: summary(), registerName: business.profile.registerName });
      case 'device_status': return paired && body.deviceToken === fixtureDeviceToken
        ? reply({ business: summary(), registerName: business.profile.registerName, employees: employees.filter((employee) => employee.active) })
        : reject(401, 'DEVICE_REVOKED', 'El dispositivo fue revocado.');
      case 'device_unlock':
        currentDeviceEmployee = employees.find((employee) => employee.id === body.employeeId) ?? fixtureCashier;
        if (body.pin !== (body.employeeId === fixtureCashier.id ? fixtureCashierPin : fixturePin)) return reject(401, 'PIN_INVALID', 'PIN incorrecto.');
        operatorGeneration += 1;
        currentDeviceOperator = operatorGeneration.toString(16).padStart(64, '0');
        return reply({ business: projection(currentDeviceEmployee.role, currentDeviceEmployee), operatorToken: currentDeviceOperator, expiresAt: expiresAt() });
      case 'device_context': return body.operatorToken === currentDeviceOperator && currentDeviceOperator
        ? reply({ business: projection(currentDeviceEmployee.role, currentDeviceEmployee), expiresAt: expiresAt() })
        : reject(401, 'SESSION_INVALID', 'La sesión está bloqueada.');
      case 'device_lock':
        currentDeviceOperator = '';
        return reply({ locked: true });
      case 'device_forget': case 'revoke_device':
        deviceRevoked = true;
        currentDeviceOperator = '';
        return reply({ revoked: true });
      default: return reject(400, 'VALIDATION_ERROR', 'Acción inválida.');
    }
  });
  return { calls, authorizations, revokeDevice: () => { deviceRevoked = true; }, deviceOperator: () => currentDeviceOperator,
    setRole: (role: BusinessRole) => { googleRole = role; } };
}

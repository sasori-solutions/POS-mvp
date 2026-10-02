import type { Page } from '@playwright/test';
import type { AccountRequest, BusinessContext, BusinessRole, DeviceSummary, EmployeeSummary, InvitationSummary } from '../../src/lib/contracts';
import { fixtureBusiness, fixtureOperatorToken, fixturePin, mockAccount } from './account-fixture';

export const fixtureInvitation = 'c1'.repeat(32);
export const fixturePinSetup = 'e4'.repeat(32);
export const fixturePairingCode = 'b2'.repeat(32);
export const fixtureDeviceToken = 'd3'.repeat(32);
export const fixtureKitchen = { id: '84c75082-4633-4f53-8f34-a2ed0c7b2e66', name: 'Cocina de prueba', role: 'kitchen' as const, active: true, googleLinked: false, pinReady: true };
export const fixtureCashier = { id: 'b1041684-c36b-4360-a98b-ce41c821cf41', name: 'Caja de prueba', role: 'cashier' as const, active: true, googleLinked: false, pinReady: true };
export const fixtureCashierPin = '014682';
export const fixtureDeviceId = '20b56f6a-080d-4f03-99eb-545edb79a548';

/** Network boundary only. The browser runs the production React/Auth code. */
export async function mockOnboarding(page: Page, options: {
  existingBusiness?: boolean;
  authenticated?: boolean;
  role?: BusinessRole;
  createEmployeeResponseLosses?: number;
  invitations?: InvitationSummary[];
  employees?: EmployeeSummary[];
  devices?: DeviceSummary[];
  recoveryReady?: boolean;
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
  const employees: EmployeeSummary[] = structuredClone(options.employees ?? [
    { id: '5f9bf172-13ae-4df5-84be-3975d90e1f65', name: 'Persona de prueba', role: 'owner', active: true, googleLinked: true, pinReady: true },
    { ...fixtureCashier }, { ...fixtureKitchen },
  ]);
  const invitations: InvitationSummary[] = structuredClone(options.invitations ?? []);
  let pinSetupEmployeeId: string = fixtureCashier.id;
  const employeePins = new Map<string, string>([[fixtureCashier.id, fixtureCashierPin], [fixtureKitchen.id, fixturePin]]);
  const devices: DeviceSummary[] = structuredClone(options.devices ?? []);
  const employeeOperations = new Map<string, unknown>();
  const invitationOperations = new Map<string, unknown>();
  let createEmployeeResponseLosses = options.createEmployeeResponseLosses ?? 0;
  function deleteEmployee(employeeId: string) {
    const index = employees.findIndex((item) => item.id === employeeId);
    if (index < 0) return;
    const [employee] = employees.splice(index, 1);
    employee.active = false;
    employeePins.delete(employee.id);
    invitations.filter((item) => item.employeeId === employee.id && item.active).forEach((item) => Object.assign(item, { active: false, status: 'revoked', revokedAt: new Date().toISOString(), revokeReason: 'employee_deleted' }));
    currentDeviceOperator = '';
  }
  const expiresAt = () => new Date(Date.now() + 8 * 3_600_000).toISOString();
  const summary = () => ({ id: business.id, name: business.name, businessType: business.businessType, role: googleRole, canRecoverPin: googleRole === 'owner', recoveryReady: options.recoveryReady ?? true });
  const projection = (role = googleRole, employee: EmployeeSummary = role === 'kitchen' ? fixtureKitchen : fixtureCashier): BusinessContext => role === 'owner'
    ? { ...business, role, canRecoverPin: undefined, recoveryReady: undefined }
    : { ...business, role, canRecoverPin: undefined, recoveryReady: undefined, employee: { id: employee.id, name: employee.name, role }, profile: {
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
      case 'notifications': return reply({ notifications: [], unreadCount: 0 });
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
      case 'accept_invitation': {
        if (body.invitationCode !== fixtureInvitation) return reject(400, 'INVITATION_INVALID', 'Invitación inválida o vencida.');
        if (body.pin.length !== 6) return reject(400, 'VALIDATION_ERROR', 'Completa el PIN.');
        const invitation = [...invitations].reverse().find((item) => item.active);
        const employee = employees.find((item) => item.id === invitation?.employeeId) ?? employees.find((item) => item.id === fixtureKitchen.id)!;
        employee.googleLinked = true;
        employee.pinReady = true;
        if (invitation) Object.assign(invitation, { active: false, status: 'accepted', acceptedAt: new Date().toISOString() });
        hasBusiness = true;
        googleRole = employee.role;
        currentPin = body.pin;
        locked = false;
        currentDeviceOperator = '';
        return reply({ ...unlocked(), business: { ...projection(employee.role, employee), employee: { id: employee.id, name: employee.name, role: employee.role } } });
      }
      case 'request_pin_email': case 'device_request_pin_email':
        return reply({ sent: true, retryAfterSeconds: 60 });
      case 'pin_email_details':
        return reply({ businessName: business.name, expiresAt: new Date(Date.now() + 900_000).toISOString() });
      case 'confirm_pin_email':
        currentPin = body.pin; locked = true;
        return reply({ updated: true });
      case 'change_pin':
        if (locked || body.currentPin !== currentPin) return reject(401, 'PIN_INVALID', 'PIN incorrecto.');
        currentPin = body.pin;
        return reply(unlocked());
      case 'invitation_details': {
        if (body.invitationCode !== fixtureInvitation) return reject(400, 'INVITATION_INVALID', 'Invitación no válida.');
        const invitation = [...invitations].reverse().find((item) => item.active);
        const employee = employees.find((item) => item.id === invitation?.employeeId);
        return reply({ business: summary(), employee: employee ?? { ...fixtureKitchen, pinReady: false }, expiresAt: expiresAt() });
      }
      case 'create_pin_setup':
        pinSetupEmployeeId = body.employeeId;
        return reply({ setupCode: fixturePinSetup, setupId: crypto.randomUUID(), expiresAt: expiresAt() });
      case 'employee_pin_setup_details': case 'device_pin_setup_details': {
        const employee = employees.find((item) => item.id === pinSetupEmployeeId);
        return body.setupCode === fixturePinSetup && employee
          ? reply({ business: summary(), employee, expiresAt: expiresAt() })
          : reject(400, 'PIN_SETUP_INVALID', 'Código inválido.');
      }
      case 'set_employee_pin': case 'device_set_employee_pin': {
        const employee = employees.find((item) => item.id === pinSetupEmployeeId);
        if (body.setupCode !== fixturePinSetup || !employee) return reject(400, 'PIN_SETUP_INVALID', 'Código inválido.');
        employee.pinReady = true;
        employeePins.set(employee.id, body.pin);
        if (body.action === 'set_employee_pin') { googleRole = employee.role; currentPin = body.pin; locked = false; return reply(unlocked()); }
        currentDeviceEmployee = employee; operatorGeneration += 1; currentDeviceOperator = operatorGeneration.toString(16).padStart(64, '0');
        return reply({ business: projection(employee.role, employee), operatorToken: currentDeviceOperator, expiresAt: expiresAt() });
      }
      case 'team':
        if (locked || googleRole !== 'owner') return reject(403, 'PERMISSION_DENIED', 'Acceso restringido.');
        return reply({ employees, invitations, devices });
      case 'create_employee': {
        if (employeeOperations.has(body.operationId)) return reply(employeeOperations.get(body.operationId));
        if (body.pin !== null) return reject(400, 'VALIDATION_ERROR', 'Revisa el acceso del empleado.');
        const employee: EmployeeSummary = { id: crypto.randomUUID(), name: body.name, role: body.role, active: true, pinReady: false, googleLinked: false };
        employees.push(employee);
        const invitation = body.inviteWithGoogle ? { invitationCode: fixtureInvitation, invitationId: crypto.randomUUID(), expiresAt: expiresAt() } : undefined;
        if (invitation) invitations.push({ id: invitation.invitationId, employeeId: employee.id, name: employee.name, role: body.role, active: true, expiresAt: invitation.expiresAt, status: 'pending', acceptedAt: null, revokedAt: null, revokeReason: null });
        const pinSetup = invitation ? undefined : { setupCode: fixturePinSetup, setupId: crypto.randomUUID(), expiresAt: expiresAt() };
        if (pinSetup) pinSetupEmployeeId = employee.id;
        const result = { ...employee, ...(invitation ? { invitation } : {}), ...(pinSetup ? { pinSetup } : {}) };
        employeeOperations.set(body.operationId, result);
        if (createEmployeeResponseLosses > 0) { createEmployeeResponseLosses -= 1; return route.abort('failed'); }
        return reply(result);
      }
      case 'update_employee': {
        const employee = employees.find((item) => item.id === body.employeeId);
        if (!employee) return reject(404, 'EMPLOYEE_INACTIVE', 'Empleado no disponible.');
        Object.assign(employee, { name: body.name, role: body.role, active: body.active });
        if (body.pin) employee.pinReady = true;
        return reply(employee);
      }
      case 'create_invitation': {
        if (invitationOperations.has(body.operationId)) return reply(invitationOperations.get(body.operationId));
        const employee = 'employeeId' in body ? employees.find((item) => item.id === body.employeeId) : undefined;
        if ('employeeId' in body && (!employee || !employee.active || employee.googleLinked)) return reject(400, 'INVITATION_INVALID', 'Empleado no disponible para vincular Google.');
        const invitationId = crypto.randomUUID();
        const expiration = expiresAt();
        invitations.filter((item) => item.employeeId === employee?.id && item.active).forEach((item) => Object.assign(item, { active: false, status: 'revoked', revokedAt: new Date().toISOString(), revokeReason: 'replaced' }));
        invitations.push({ id: invitationId, ...(employee ? { employeeId: employee.id } : {}), name: employee?.name ?? ('name' in body ? body.name : ''), role: employee && employee.role !== 'owner' ? employee.role : 'role' in body ? body.role : 'cashier', active: true, expiresAt: expiration, status: 'pending', acceptedAt: null, revokedAt: null, revokeReason: null });
        const result = { invitationCode: fixtureInvitation, invitationId, expiresAt: expiration };
        invitationOperations.set(body.operationId, result);
        return reply(result);
      }
      case 'revoke_invitation': {
        const invitation = invitations.find((item) => item.id === body.invitationId);
        if (invitation) Object.assign(invitation, { active: false, status: 'revoked', revokedAt: new Date().toISOString(), revokeReason: 'user_cancelled' });
        return reply({ revoked: true });
      }
      case 'delete_employee': {
        deleteEmployee(body.employeeId);
        return reply({ id: body.employeeId, deleted: true });
      }
      case 'create_pairing_code': return reply({ pairingCode: fixturePairingCode, expiresAt: expiresAt() });
      case 'device_pair':
        if (body.pairingCode !== fixturePairingCode) return reject(400, 'PAIRING_INVALID', 'Código inválido o vencido.');
        paired = true;
        deviceRevoked = false;
        devices.push({ id: fixtureDeviceId, name: body.deviceName, registerName: business.profile.registerName, active: true });
        return reply({ deviceId: fixtureDeviceId, deviceToken: fixtureDeviceToken, business: summary(), registerName: business.profile.registerName });
      case 'device_status': return paired && body.deviceToken === fixtureDeviceToken
        ? reply({ business: summary(), registerName: business.profile.registerName, employees: employees.filter((employee) => employee.active && employee.pinReady) })
        : reject(401, 'DEVICE_REVOKED', 'El dispositivo fue revocado.');
      case 'device_unlock':
        currentDeviceEmployee = employees.find((employee) => employee.id === body.employeeId) ?? fixtureCashier;
        if (body.pin !== employeePins.get(body.employeeId)) return reject(401, 'PIN_INVALID', 'PIN incorrecto.');
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
        if (body.action === 'revoke_device') devices.filter((item) => item.id === body.deviceId).forEach((item) => { item.active = false; });
        deviceRevoked = true;
        currentDeviceOperator = '';
        return reply({ revoked: true });
      default: return reject(400, 'VALIDATION_ERROR', 'Acción inválida.');
    }
  });
  return { calls, authorizations, revokeDevice: () => { deviceRevoked = true; }, deviceOperator: () => currentDeviceOperator,
    deleteEmployeeElsewhere: deleteEmployee,
    acceptLatestInvitation: (employeeId: string) => {
      const invitation = [...invitations].reverse().find((item) => item.employeeId === employeeId && item.active);
      const employee = employees.find((item) => item.id === employeeId);
      if (invitation) Object.assign(invitation, { active: false, status: 'accepted', acceptedAt: new Date().toISOString() });
      if (employee) Object.assign(employee, { googleLinked: true, pinReady: true });
    },
    setRole: (role: BusinessRole) => { googleRole = role; } };
}

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import TeamPanel from "../../src/components/TeamPanel";
import NotificationsPanel from "../../src/components/NotificationsPanel";
import EmailRecovery from "../../src/components/EmailRecovery";
import { AccessButtonContent } from "../../src/components/AccessBusy";
import { accountRequest, recoveryRequest } from "../../src/lib/account";
import type { BusinessContext, TeamContext } from "../../src/lib/contracts";

vi.mock("../../src/lib/account", async original => ({
  ...await original<object>(),
  accountRequest: vi.fn(),
  recoveryRequest: vi.fn(),
}));

const business = {
  id: "synthetic-business", name: "Café de prueba", businessType: "cafe", role: "owner",
  timezone: "America/Mexico_City", currency: "MXN", createdAt: "2026-10-03T12:00:00Z",
  profile: { branchName: "Principal", registerName: "Caja", address: "", city: "", state: "", contactPhone: "", paymentMethods: ["cash"] },
} satisfies BusinessContext;
const team: TeamContext = {
  employees: [{ id: "synthetic-employee", name: "Empleado de prueba", role: "cashier", active: true, googleLinked: true, pinReady: true, permissions: ["catalog.read"] }],
  devices: [], invitations: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function renderTeam(override?: BusinessContext) {
  return render(<TeamPanel business={override ?? business} operatorToken="synthetic-memory-only" section="employees" onBack={vi.fn()} onSessionError={vi.fn()} />);
}

beforeEach(() => {
  vi.mocked(accountRequest).mockReset();
  vi.mocked(recoveryRequest).mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  window.history.replaceState({}, "", "/");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("employee loading is a placeholder; a failed first request exposes a retry", async () => {
  const pending = deferred<TeamContext>();
  vi.mocked(accountRequest).mockReturnValueOnce(pending.promise);
  renderTeam();
  expect(screen.getByRole("status", { name: "Cargando empleados" }).textContent).toBe("");
  expect(screen.queryByRole("button", { name: "Volver" })).toBeNull();
  await act(async () => pending.reject(new Error("Sin conexión")));
  expect(screen.queryByRole("status", { name: "Cargando empleados" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Sin conexión");
  vi.mocked(accountRequest).mockResolvedValueOnce(team);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reintentar" })));
  expect(screen.getByText("Empleado de prueba")).toBeTruthy();
});

test("team refresh keeps valid rows and preserves the form escape", async () => {
  vi.mocked(accountRequest).mockResolvedValueOnce(team);
  renderTeam();
  await screen.findByText("Empleado de prueba");
  const refresh = deferred<TeamContext>();
  vi.mocked(accountRequest).mockReturnValueOnce(refresh.promise);
  fireEvent(window, new Event("focus"));
  expect(screen.getByText("Empleado de prueba")).toBeTruthy();
  expect(screen.queryByRole("status", { name: "Cargando empleados" })).toBeNull();
  await act(async () => refresh.resolve(team));
  fireEvent.click(screen.getByRole("button", { name: "Administrar Empleado de prueba" }));
  expect(screen.getByRole("button", { name: "Volver a empleados" })).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText("Nombre del empleado"), { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Volver a empleados" })).toBeNull();
});

test("employee sessions never render owner team controls or placeholders", () => {
  renderTeam({ ...business, role: "cashier" });
  expect(screen.queryByRole("status", { name: "Cargando empleados" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Agregar empleado" })).toBeNull();
  expect(accountRequest).not.toHaveBeenCalled();
});

test("notifications load without text and recover from an error without redundant navigation", async () => {
  const pending = deferred<{ notifications: []; unreadCount: number }>();
  vi.mocked(accountRequest).mockReturnValueOnce(pending.promise);
  render(<NotificationsPanel businessId={business.id} operatorToken="synthetic-memory-only" onBack={vi.fn()} onSessionError={vi.fn()} onUnreadCount={vi.fn()} />);
  expect(screen.getByRole("status", { name: "Cargando notificaciones" }).textContent).toBe("");
  expect(screen.queryByRole("button", { name: "Actualizar notificaciones" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Volver a Más" })).toBeNull();
  await act(async () => pending.reject(new Error("Sin conexión")));
  expect(screen.queryByRole("status", { name: "Cargando notificaciones" })).toBeNull();
  vi.mocked(accountRequest).mockResolvedValueOnce({ notifications: [], unreadCount: 0 });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reintentar" })));
  expect(screen.getByRole("heading", { name: "Estás al día" })).toBeTruthy();
});

test("email recovery leaves its placeholder on a failed request and keeps its retry", async () => {
  window.history.replaceState({}, "", `/recover-pin#recovery=${"a".repeat(64)}`);
  const pending = deferred<{ businessName: string; expiresAt: string }>();
  vi.mocked(recoveryRequest).mockReturnValueOnce(pending.promise);
  render(<EmailRecovery />);
  expect(screen.getByRole("status", { name: "Revisando enlace de recuperación" }).textContent).toBe("");
  await act(async () => pending.reject(new Error("Sin conexión")));
  expect(screen.queryByRole("status", { name: "Revisando enlace de recuperación" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Sin conexión");
  expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeTruthy();
});

test("a pending button keeps its label and footprint while the visible feedback is an icon", () => {
  const { container } = render(<button aria-busy="true"><AccessButtonContent busy>Guardar cambios</AccessButtonContent></button>);
  expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeTruthy();
  expect(container.querySelector(".access-button-content.is-pending .access-button-spinner")).toBeTruthy();
});

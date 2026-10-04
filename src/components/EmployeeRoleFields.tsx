import { useId } from "react";
import { businessPermissions, permissionPrerequisites, type BusinessPermission } from "../lib/contracts";

const permissionGroups: { name: string; choices: [BusinessPermission, string][] }[] = [
  { name: "Catálogo", choices: [["catalog.read", "Consultar productos"], ["catalog.manage", "Crear y editar productos"], ["catalog.availability", "Cambiar disponibilidad"]] },
  { name: "Ventas", choices: [["sales.create", "Cobrar ventas"], ["sales.read_own", "Consultar sus ventas"], ["sales.read_all", "Consultar todas las ventas"], ["sales.discount", "Aplicar descuentos"], ["sales.reverse", "Anular ventas"]] },
  { name: "Órdenes", choices: [["orders.read", "Consultar cuentas"], ["orders.manage", "Crear y editar cuentas"], ["orders.cancel", "Cancelar cuentas"], ["tables.manage", "Administrar mesas"]] },
  { name: "Comandas", choices: [["kitchen.read", "Consultar comandas"], ["kitchen.operate", "Actualizar preparación"]] },
  { name: "Caja", choices: [["cash.read", "Consultar caja"], ["cash.open", "Abrir caja"], ["cash.move", "Registrar entradas y salidas"], ["cash.close", "Cerrar caja"]] },
  { name: "Reportes", choices: [["reports.read", "Consultar reportes"]] },
];

export default function EmployeeRoleFields({
  permissions,
  onChange,
  disabled,
}: {
  permissions: BusinessPermission[];
  onChange: (permissions: BusinessPermission[]) => void;
  disabled: boolean;
}) {
  const id = useId();
  function toggle(permission: BusinessPermission, selected: boolean) {
    const next = new Set(permissions);
    if (selected) {
      next.add(permission);
      let prerequisite = permissionPrerequisites[permission];
      while (prerequisite) { next.add(prerequisite); prerequisite = permissionPrerequisites[prerequisite]; }
    } else {
      next.delete(permission);
      for (const value of businessPermissions) {
        let prerequisite = permissionPrerequisites[value];
        while (prerequisite) {
          if (!next.has(prerequisite)) { next.delete(value); break; }
          prerequisite = permissionPrerequisites[prerequisite];
        }
      }
    }
    onChange(businessPermissions.filter(value => next.has(value)));
  }
  return (
    <fieldset className="employee-permission-fields" disabled={disabled}>
      <legend className="text-base font-medium">Permisos</legend>
      <p className="mt-2 text-sm text-muted">Selecciona las acciones que puede realizar. Administrar empleados y el negocio corresponde al dueño.</p>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 max-compact:grid-cols-1">
        {permissionGroups.map(group => (
          <fieldset key={group.name} className="min-w-0">
            <legend className="mb-1 text-sm font-medium">{group.name}</legend>
            {group.choices.map(([permission, label]) => (
              <label key={permission} htmlFor={`${id}-${permission}`} className="flex min-h-12 cursor-pointer items-center gap-3 py-2 text-sm">
                <input id={`${id}-${permission}`} type="checkbox" checked={permissions.includes(permission)} onChange={event => toggle(permission, event.target.checked)} className="h-5 w-5 shrink-0 accent-brand" />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </fieldset>
  );
}

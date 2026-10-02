import { Check, LockKeyhole } from "lucide-react";
import type { BusinessRole } from "../lib/contracts";
import { roleSections, workSections } from "../lib/navigation";

type EmployeeRole = Exclude<BusinessRole, "owner">;
const choices = [
  { value: "cashier", name: "Cajero" },
  { value: "kitchen", name: "Cocina" },
  { value: "manager", name: "Encargado" },
] as const;

export default function EmployeeRoleFields({
  role,
  onChange,
  disabled,
}: {
  role: EmployeeRole;
  onChange: (role: EmployeeRole) => void;
  disabled: boolean;
}) {
  const included = roleSections[role];
  const restricted = [
    ...workSections.filter((section) => !included.includes(section)),
    "Datos del negocio",
    "Empleados y dispositivos",
  ];

  return (
    <fieldset className="employee-role-fields" disabled={disabled}>
      <legend>Puesto y permisos</legend>
      <div className="employee-role-choices grid grid-cols-3 gap-2">
        {choices.map((choice) => (
          <label key={choice.value}>
            <input
              type="radio"
              name="employee-role"
              value={choice.value}
              checked={role === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.name}</span>
          </label>
        ))}
      </div>
      <div
        className="employee-permissions grid grid-cols-2 gap-5 pt-5 max-[22.5rem]:grid-cols-1"
        aria-live="polite"
        aria-atomic="true"
      >
        <section aria-labelledby="employee-included-title">
          <h2 id="employee-included-title">Puede abrir</h2>
          <ul>
            {included.map((section) => (
              <li key={section}>
                <Check size={16} aria-hidden="true" />
                <span>{section}</span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="employee-restricted-title">
          <h2 id="employee-restricted-title">Sin acceso</h2>
          <ul>
            {restricted.map((section) => (
              <li key={section}>
                <LockKeyhole size={15} aria-hidden="true" />
                <span>{section}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </fieldset>
  );
}

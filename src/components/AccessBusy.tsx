import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

/** Preserve the button's size and name while a real request is pending. */
export function AccessButtonContent({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`access-button-content${busy ? " is-pending" : ""}`}>
      <span className="access-button-label">{children}</span>
      {busy && <LoaderCircle className="access-button-spinner" size={20} aria-hidden="true" />}
    </span>
  );
}

export default function AccessBusy({ label = "Verificando" }: { label?: string }) {
  return (
    <span className="access-busy" role="status" aria-label={label}>
      <LoaderCircle size={20} aria-hidden="true" />
    </span>
  );
}

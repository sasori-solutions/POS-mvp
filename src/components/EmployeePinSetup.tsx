import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { accountRequest, deviceRequest } from "../lib/account";
import type {
  EmployeePinSetupDetails,
  OperatorSession,
} from "../lib/contracts";

interface Props {
  deviceToken?: string;
  accessToken?: string;
  onBack: () => void;
  onBeforeConsume?: () => void;
  onDone: (session: OperatorSession) => void;
}

/** The authorization code and employee-chosen PIN live only in this mounted flow. */
export default function EmployeePinSetup({
  deviceToken,
  accessToken,
  onBack,
  onBeforeConsume,
  onDone,
}: Props) {
  const [code, setCode] = useState("");
  const [details, setDetails] = useState<EmployeePinSetupDetails | null>(null);
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  const pending = useRef(false);
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    setCode("");
    setDetails(null);
    setPin("");
    setConfirmation("");
    setError("");
    return () => {
      mounted.current = false;
      generation.current += 1;
      operation.current = null;
    };
  }, [deviceToken, accessToken]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (!/^[a-f0-9]{64}$/i.test(code.trim())) {
      setError("Revisa el código que te compartió el dueño.");
      return;
    }
    if (details && (!/^[0-9]{6}$/.test(pin) || pin !== confirmation)) {
      setError("Escribe y confirma el mismo PIN de seis dígitos.");
      return;
    }
    const current = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!details) {
        const result = deviceToken
          ? await deviceRequest({
              action: "device_pin_setup_details",
              deviceToken,
              setupCode: code.trim(),
            })
          : await accountRequest(
              { action: "employee_pin_setup_details", setupCode: code.trim() },
              accessToken,
            );
        if (mounted.current && current === generation.current)
          setDetails(result);
      } else {
        onBeforeConsume?.();
        const fingerprint = JSON.stringify({ code: code.trim(), pin });
        if (operation.current?.fingerprint !== fingerprint)
          operation.current = { fingerprint, id: crypto.randomUUID() };
        const result = deviceToken
          ? await deviceRequest({
              action: "device_set_employee_pin",
              deviceToken,
              setupCode: code.trim(),
              pin,
              operationId: operation.current.id,
            })
          : await accountRequest(
              {
                action: "set_employee_pin",
                setupCode: code.trim(),
                pin,
                operationId: operation.current.id,
              },
              accessToken,
            );
        if (!mounted.current || current !== generation.current) {
          if (deviceToken)
            await deviceRequest({
              action: "device_lock",
              deviceToken,
              operatorToken: result.operatorToken,
            }).catch(() => undefined);
          else
            await accountRequest(
              {
                action: "lock",
                businessId: result.business.id,
                operatorToken: result.operatorToken,
              },
              accessToken,
            ).catch(() => undefined);
          return;
        }
        setCode("");
        setPin("");
        setConfirmation("");
        operation.current = null;
        onDone(result);
      }
    } catch (caught) {
      if (mounted.current && current === generation.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "No pudimos guardar tu PIN. Intenta de nuevo.",
        );
    } finally {
      if (mounted.current && current === generation.current) {
        pending.current = false;
        setBusy(false);
        setPin("");
        setConfirmation("");
      }
    }
  }

  return (
    <section className="screen flex flex-col max-compact:flex-1 employee-screen flex flex-1 flex-col [&_.screen-actions]:mt-8 [&>.error-message]:mt-5">
      <button
        type="button"
        className="back-button -mt-4 mb-4 flex min-h-12 items-center gap-2 self-start border-0 bg-transparent pt-0 pb-4 text-sm text-muted hover:text-ink"
        onClick={onBack}
      >
        <ArrowLeft size={18} aria-hidden="true" />
        Volver
      </button>
      <h1>{details ? "Elige tu PIN" : "Crear o restablecer mi PIN"}</h1>
      <p>
        {details
          ? `${details.employee.name}, para ${details.business.name}.`
          : "Pide al dueño un código de autorización. Tú eliges tu PIN; el dueño no lo necesita."}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        {!details ? (
          <div className="field">
            <label htmlFor="employee-setup-code">Código de autorización</label>
            <input
              id="employee-setup-code"
              value={code}
              onChange={(event) => setCode(event.target.value.trim())}
              maxLength={64}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
              required
            />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="employee-setup-pin">Nuevo PIN</label>
              <input
                id="employee-setup-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(event) =>
                  setPin(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))
                }
                disabled={busy}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="employee-setup-confirmation">
                Confirmar nuevo PIN
              </label>
              <input
                id="employee-setup-confirmation"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={confirmation}
                onChange={(event) =>
                  setConfirmation(
                    event.target.value.replace(/[^0-9]/g, "").slice(0, 6),
                  )
                }
                disabled={busy}
                required
              />
            </div>
          </>
        )}
        {error && (
          <p
            className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="screen-actions mt-10 flex flex-col gap-3">
          <button
            type="submit"
            className="button primary"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Un momento…" : details ? "Guardar mi PIN" : "Continuar"}
          </button>
        </div>
      </form>
    </section>
  );
}

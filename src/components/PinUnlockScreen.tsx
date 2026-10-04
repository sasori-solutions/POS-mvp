import { useEffect, useRef, useState } from "react";
import { Delete } from "lucide-react";
import PinScreenEntrance from "./PinScreenEntrance";
import AccessBusy from "./AccessBusy";

interface Props {
  businessName: string;
  busy: boolean;
  error: string;
  secondsLeft: number;
  onUnlock: (pin: string) => Promise<void>;
  onRecover: () => void;
  onLogout: () => void;
  onChangeBusiness?: () => void;
}

export default function PinUnlockScreen({
  businessName,
  busy,
  error,
  secondsLeft,
  onUnlock,
  onRecover,
  onLogout,
  onChangeBusiness,
}: Props) {
  const root = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef("");
  const pending = useRef(false);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = busy || submitting || secondsLeft > 0;

  useEffect(() => {
    if (!disabled) input.current?.focus({ preventScroll: true });
  }, [disabled]);

  function updatePin(next: string) {
    if (disabled || pending.current) return;
    const digits = next.replace(/[^0-9]/g, "").slice(0, 6);
    valueRef.current = digits;
    setValue(digits);
    if (digits.length !== 6) return;

    // Lock synchronously: rapid taps or input events must submit only once.
    pending.current = true;
    setSubmitting(true);
    void unlock(digits);
  }

  async function unlock(digits: string) {
    try {
      await onUnlock(digits);
    } finally {
      valueRef.current = "";
      setValue("");
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section ref={root} className="pin-unlock-screen" aria-labelledby="pin-title">
      <PinScreenEntrance target={root} />
      <div className="pin-unlock-content">
        <div className="pin-unlock-heading" data-pin-reveal>
          <p className="pin-business-name">{businessName}</p>
          <h1 id="pin-title">Ingresa tu PIN</h1>
        </div>

        <div className="pin-entry" data-pin-reveal>
          <label className="sr-only" htmlFor="pin-input">PIN de 6 dígitos</label>
          <input
            ref={input}
            id="pin-input"
            data-testid="pin-input"
            type="password"
            inputMode="none"
            autoComplete="off"
            maxLength={6}
            value={value}
            disabled={disabled}
            onChange={(event) => updatePin(event.target.value)}
            aria-describedby="pin-status"
            aria-invalid={!!error}
          />
          <div className="pin-dots" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className={index < value.length ? "filled" : ""} />
            ))}
          </div>
        </div>

        <div id="pin-status" className="pin-unlock-status" aria-busy={busy || submitting}>
          {busy || submitting ? (
            <AccessBusy label="Verificando PIN" />
          ) : secondsLeft > 0 ? (
            <p role="timer" aria-live="off">
              Intenta de nuevo en {Math.floor(secondsLeft / 60)}:
              {String(secondsLeft % 60).padStart(2, "0")}
            </p>
          ) : error ? (
            <p className="pin-unlock-error" role="alert">{error}</p>
          ) : null}
        </div>

        <div className="pin-keypad" role="group" aria-label="Teclado del PIN" data-pin-reveal>
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
            <button
              key={digit}
              type="button"
              disabled={disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => updatePin(valueRef.current + digit)}
            >
              {digit}
            </button>
          ))}
          <span aria-hidden="true" />
          <button
            type="button"
            disabled={disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => updatePin(valueRef.current + "0")}
          >0</button>
          <button
            type="button"
            aria-label="Borrar último dígito"
            disabled={disabled || !value.length}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => updatePin(valueRef.current.slice(0, -1))}
          >
            <Delete size={24} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>

        <div className="pin-unlock-utilities">
          <button type="button" disabled={busy || submitting} onClick={onRecover}>Olvidé mi PIN</button>
          {onChangeBusiness && (
            <button type="button" disabled={busy || submitting} onClick={onChangeBusiness}>Cambiar negocio</button>
          )}
        </div>
      </div>
      <footer className="pin-unlock-footer">
        <button type="button" disabled={busy || submitting} onClick={onLogout}>Cerrar sesión</button>
      </footer>
    </section>
  );
}

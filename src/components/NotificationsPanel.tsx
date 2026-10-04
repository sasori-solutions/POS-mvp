import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check } from "lucide-react";
import LoadingPlaceholder from "./LoadingPlaceholder";
import { AccessButtonContent } from "./AccessBusy";
import { accountRequest, AccountClientError } from "../lib/account";
import type { AccountResponses } from "../lib/contracts";

type Notice = AccountResponses["notifications"]["notifications"][number];
interface Props {
  businessId: string;
  operatorToken: string;
  onBack: () => void;
  onSessionError: (error: unknown) => void;
  onUnreadCount: (count: number) => void;
}
const statuses = {
  pending: "Pendiente",
  approved: "Autorizado",
  rejected: "Rechazado",
  info: "Dispositivo vinculado",
};
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}
export default function NotificationsPanel({
  businessId,
  operatorToken,
  onSessionError,
  onUnreadCount,
}: Props) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const pending = useRef(false);
  const mutationBusy = useRef(false);
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const callbacks = useRef({ onSessionError, onUnreadCount });
  callbacks.current = { onSessionError, onUnreadCount };
  const fail = useCallback((problem: unknown) => {
    if (
      problem instanceof AccountClientError &&
      [
        "AUTH_REQUIRED",
        "GOOGLE_REQUIRED",
        "SESSION_INVALID",
        "SESSION_EXPIRED",
        "BUSINESS_ACCESS_DENIED",
      ].includes(problem.code)
    )
      callbacks.current.onSessionError(problem);
    else
      setError(
        problem instanceof Error
          ? problem.message
          : "No pudimos cargar las notificaciones.",
      );
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      if (pending.current && !force) return;
      const current = generation.current;
      const sequence = ++requestSequence.current;
      pending.current = true;
      setRefreshing(true);
      try {
        const data = await accountRequest({
          action: "notifications",
          businessId,
          operatorToken,
        });
        if (
          !alive.current ||
          current !== generation.current ||
          sequence !== requestSequence.current ||
          mutationBusy.current
        )
          return;
        setNotices(data.notifications);
        callbacks.current.onUnreadCount(data.unreadCount);
        setError("");
      } catch (problem) {
        if (
          alive.current &&
          current === generation.current &&
          sequence === requestSequence.current &&
          !mutationBusy.current
        )
          fail(problem);
      } finally {
        if (
          alive.current &&
          current === generation.current &&
          sequence === requestSequence.current
        ) {
          pending.current = false;
          setRefreshing(false);
          setLoading(false);
        }
      }
    },
    [businessId, operatorToken, fail],
  );
  useEffect(() => {
    alive.current = true;
    generation.current += 1;
    pending.current = false;
    mutationBusy.current = false;
    setNotices([]);
    setLoading(true);
    setBusy("");
    setConfirm(null);
    setMessage("");
    setError("");
    void refresh();
    const update = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      alive.current = false;
      generation.current += 1;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);
  async function act(notice: Notice, decision?: "approve" | "reject") {
    if (mutationBusy.current || pending.current) return;
    const current = generation.current;
    mutationBusy.current = true;
    setBusy(notice.id);
    setMessage("");
    setError("");
    try {
      if (decision)
        await accountRequest({
          action: "review_employee_device",
          businessId,
          operatorToken,
          notificationId: notice.id,
          decision,
        });
      else
        await accountRequest({
          action: "mark_notification_read",
          businessId,
          operatorToken,
          notificationId: notice.id,
        });
      if (!alive.current || current !== generation.current) return;
      mutationBusy.current = false;
      setConfirm(null);
      setMessage(
        decision === "approve"
          ? "Cambio autorizado. El dispositivo anterior perdió el acceso."
          : decision === "reject"
            ? "Solicitud rechazada. El dispositivo anterior conserva el acceso."
            : "Notificación marcada como leída.",
      );
      // Supersede any read begun before this decision committed.
      await refresh(true);
    } catch (problem) {
      if (alive.current && current === generation.current) {
        requestSequence.current += 1;
        pending.current = false;
        setRefreshing(false);
        fail(problem);
      }
    } finally {
      if (alive.current && current === generation.current) {
        mutationBusy.current = false;
        setBusy("");
      }
    }
  }
  const actionsDisabled = loading || refreshing || Boolean(busy);
  return (
    <section className="screen management-polish notifications-screen">
      <h1 className="sr-only">Notificaciones</h1>
      {error && (
        <div className="access-error-retry">
          <p role="alert" className="error-message">{error}</p>
          <button className="button secondary" disabled={actionsDisabled} onClick={() => void refresh()}>Reintentar</button>
        </div>
      )}
      {message && (
        <p
          role="status"
          className="notice-success flex items-start gap-2 bg-success-soft p-4 text-success [&_p]:text-inherit"
        >
          <Check size={18} aria-hidden="true" />
          {message}
        </p>
      )}
      {loading ? (
        <LoadingPlaceholder variant="list" rows={3} label="Cargando notificaciones" />
      ) : notices.length === 0 && !error ? (
        <div className="notifications-empty mt-6 rounded-xl bg-surface px-4 py-12 text-center [&_h2]:text-xl">
          <Bell size={28} aria-hidden="true" />
          <h2>Estás al día</h2>
          <p>No hay solicitudes pendientes.</p>
        </div>
      ) : (
        <ul className="notification-list mt-6 grid list-none gap-4 p-0">
          {notices.map((notice) => (
            <li
              key={notice.id}
              className={`notification-card ${notice.readAt ? "" : "unread"}`}
            >
              <div className="notification-meta flex flex-wrap justify-between gap-2 text-[13px] text-muted">
                <span className={`notification-status notification-status-${notice.status}`}>{statuses[notice.status]}</span>
                <time dateTime={notice.createdAt}>
                  {dateLabel(notice.createdAt)}
                </time>
              </div>
              <h2>
                {notice.type === "employee_device_requested"
                  ? "Cambiar dispositivo"
                  : "Dispositivo vinculado"}
              </h2>
              <p>
                <strong>{notice.employeeName}</strong> · {notice.deviceName}
              </p>
              {notice.type === "employee_device_requested" &&
                notice.status === "pending" && (
                  <p>
                    Acceso bloqueado. Confirma que el empleado reconoce este dispositivo.
                  </p>
                )}
              {!notice.readAt && (
                <span className="notification-unread my-3 block text-[13px] font-semibold text-brand">
                  Sin leer
                </span>
              )}
              {notice.status === "pending" ? (
                confirm === notice.id ? (
                  <div className="notification-confirm mt-5 grid gap-3">
                    <p>
                      Al reemplazar el dispositivo, se cerrarán las sesiones
                      anteriores de {notice.employeeName}.
                    </p>
                    <button
                      className="button primary"
                      disabled={actionsDisabled}
                      aria-busy={busy === notice.id}
                      onClick={() => void act(notice, "approve")}
                    >
                      <AccessButtonContent busy={busy === notice.id}>Reemplazar dispositivo</AccessButtonContent>
                    </button>
                    <button
                      className="button secondary"
                      disabled={actionsDisabled}
                      onClick={() => setConfirm(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <div className="notification-actions mt-5 grid gap-3 min-[32.5rem]:grid-cols-2">
                    <button
                      className="button primary"
                      disabled={actionsDisabled}
                      onClick={() => setConfirm(notice.id)}
                    >
                      Autorizar cambio
                    </button>
                    <button
                      className="button secondary"
                      disabled={actionsDisabled}
                      aria-busy={busy === notice.id}
                      onClick={() => void act(notice, "reject")}
                    >
                      <AccessButtonContent busy={busy === notice.id}>Rechazar</AccessButtonContent>
                    </button>
                  </div>
                )
              ) : null}
              {!notice.readAt && (
                <button
                  className="text-button min-h-12 cursor-pointer border-0 bg-transparent text-ink underline underline-offset-4 hover:text-brand"
                  disabled={actionsDisabled}
                  aria-busy={busy === notice.id}
                  onClick={() => void act(notice)}
                >
                  <AccessButtonContent busy={busy === notice.id}>Marcar como leída</AccessButtonContent>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

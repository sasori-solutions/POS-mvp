import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Coffee,
  LockKeyhole,
  LogOut,
  Store,
} from "lucide-react";
import { accountRequest, AccountClientError, accountErrorMessages } from "./lib/account";
import type {
  AccountErrorCode,
  BusinessContext,
  BusinessSummary,
  InvitationDetails,
  OperatorSession,
} from "./lib/contracts";
import {
  allowIdentitySignIn,
  closeIdentity,
  hasCurrentStoredIdentity,
  initializeIdentity,
  supabase,
} from "./lib/supabase";
import { developmentLoginEnabled } from "./lib/development";
import {
  employeeEntryKey,
  invitationFromLink,
  preferredBusiness,
  rememberBusiness,
} from "./lib/business-access";
const InvitationScanner = lazy(() => import("./components/InvitationScanner"));
import type { Destination } from "./components/HomeScreen";
import BusinessSetup, { type BusinessDraft } from "./components/BusinessSetup";
import { detectedBusinessTimezone, newBusinessProfile } from "./lib/business-profile";
// Capture/scrub the Point return before Auth initialization and PIN entry, including lazy Home loading.
import "./lib/point-client";
const HomeScreen = lazy(() => import("./components/HomeScreen"));
const PublicMenu = lazy(() => import("./components/PublicMenu"));
import PinField from "./components/PinField";
import LoadingPlaceholder, { Skeleton } from "./components/LoadingPlaceholder";
import { AccessButtonContent } from "./components/AccessBusy";
import "./access-polish.css";
import RequestPinRecovery from "./components/RequestPinRecovery";
const TeamPanel = lazy(() => import("./components/TeamPanel"));
const BusinessSettings = lazy(() => import("./components/BusinessSettings"));
const AccountProfileSettings = lazy(() => import("./components/AccountProfileSettings"));
const NotificationsPanel = lazy(
  () => import("./components/NotificationsPanel"),
);
const DeviceLogin = lazy(() => import("./components/DeviceLogin"));
const PinUnlockScreen = lazy(() => import("./components/PinUnlockScreen"));
function LoadingScreen({ dark = false }: { dark?: boolean }) {
  return (
    <section
      className={`loading-screen access-loading${dark ? " access-loading-dark" : ""}`}
      role="status"
      aria-label="Preparando acceso"
      aria-busy="true"
    >
      <div className={dark ? "ui-placeholder-dark access-loading-content" : "access-loading-content"}>
        <Skeleton width="42%" height={18} />
        <Skeleton width="68%" height={30} />
        <div className="access-loading-dots">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} width={12} height={12} />)}</div>
        <div className="access-loading-keypad">{Array.from({ length: 12 }, (_, index) => <Skeleton key={index} width={44} height={44} />)}</div>
      </div>
    </section>
  );
}
const loadingView = <LoadingScreen dark />;
const DevelopmentLogin =
  import.meta.env.DEV && developmentLoginEnabled
    ? lazy(() => import("./development/DevelopmentLogin"))
    : null;

type Screen =
  | "loading"
  | "login"
  | "choice"
  | "join"
  | "business"
  | "create-pin"
  | "choose"
  | "unlock"
  | "ready"
  | "home"
  | "retry"
  | "team"
  | "devices"
  | "settings"
  | "recover-email"
  | "employee"
  | "employee-entry"
  | "notifications"
  | "change-pin"
  | "account-profile";
const initialDraft: BusinessDraft = {
  name: "", businessType: "cafe", timezone: detectedBusinessTimezone(), profile: newBusinessProfile('cafe'),
};
const invitationKey = "pos-mexico-pending-invitation";
function identitySessionKey(identity: Session | null | undefined) {
  if (!identity) return "";
  try {
    const payload = JSON.parse(
      atob(
        identity.access_token
          .split(".")[1]
          .replace(/-/g, "+")
          .replace(/_/g, "/"),
      ),
    ) as { session_id?: unknown };
    if (typeof payload.session_id === "string")
      return `${identity.user.id}:${payload.session_id}`;
  } catch {
    /* An unfamiliar SDK token is treated as a distinct identity generation. */
  }
  return `${identity.user.id}:${identity.access_token}`;
}
function entryIntent() {
  const url = new URL(window.location.href);
  const invitation = new URLSearchParams(url.hash.slice(1)).get("invite");
  if (invitation && /^[a-f0-9]{64}$/i.test(invitation)) {
    sessionStorage.setItem(invitationKey, invitation);
    window.history.replaceState({}, "", "/join");
  }
  if (url.pathname === "/employee")
    sessionStorage.setItem(employeeEntryKey, "true");
  return {
    device:
      url.pathname === "/register" ||
      (url.pathname === "/employee" &&
        new URLSearchParams(url.hash.slice(1)).has("pair")),
    employee:
      url.pathname === "/employee" ||
      sessionStorage.getItem(employeeEntryKey) === "true",
    create: url.pathname === "/business/new",
    join: url.pathname === "/join" || Boolean(invitation),
  };
}
const accountMessages: Record<AccountErrorCode | "NETWORK_ERROR", string> = {
  ...accountErrorMessages,
  PRODUCT_CHANGED: "El producto cambió. Revisa la cuenta antes de cobrar.",
  PRODUCT_UNAVAILABLE: "Un producto ya no está disponible. Revisa la venta.",
  SALE_NOT_FOUND: "No encontramos esta venta.",
  PAYMENT_METHOD_DISABLED: "Este método de pago está desactivado. Elige otro.",
  AUTH_REQUIRED: "Tu sesión venció. Vuelve a entrar con Google.",
  GOOGLE_REQUIRED: "Entra con tu cuenta de Google para continuar.",
  VALIDATION_ERROR: "Revisa los datos e intenta de nuevo.",
  BUSINESS_ACCESS_DENIED:
    "No tienes acceso a este negocio. Elige otro o vuelve a entrar con Google.",
  PERMISSION_DENIED: "No tienes permiso para esta acción. Solicita ayuda al dueño.",
  INVITATION_INVALID:
    "La invitación no es válida, venció o fue revocada. Pide una nueva al dueño.",
  PAIRING_INVALID:
    "El código de conexión no es válido o venció. Pide uno nuevo al dueño.",
  DEVICE_LINK_REQUIRED:
    "No pudimos vincular este navegador. Permite el almacenamiento de la app e intenta de nuevo.",
  DEVICE_APPROVAL_REQUIRED:
    "Este dispositivo no está autorizado. Revisa la solicitud con el dueño. Si fue rechazada, espera 10 minutos antes de intentar de nuevo.",
  DEVICE_PROOF_INVALID:
    "No pudimos verificar este dispositivo. Revisa la fecha y hora del equipo e intenta de nuevo.",
  DEVICE_REVOKED:
    "Este dispositivo fue desvinculado. Vuelve a conectarlo con el dueño.",
  REAUTH_REQUIRED:
    "Vuelve a verificar tu cuenta con Google para cambiar el PIN.",
  EMPLOYEE_INACTIVE:
    "Tu acceso fue desactivado. Contacta al dueño del negocio.",
  PIN_INVALID: "PIN incorrecto. Intenta de nuevo.",
  PIN_LOCKED: "Demasiados intentos. Espera antes de volver a ingresar tu PIN.",
  SESSION_INVALID: "La app está bloqueada. Ingresa tu PIN para continuar.",
  SESSION_EXPIRED:
    "Tu sesión de trabajo venció. Ingresa tu PIN para continuar.",
  OPERATION_CONFLICT:
    "Esta solicitud cambió. Vuelve a los datos del negocio e intenta de nuevo.",
  ORIGIN_FORBIDDEN: "Abre el enlace oficial de POS México para entrar.",
  METHOD_NOT_ALLOWED: "No pudimos completar la solicitud. Intenta de nuevo.",
  PAYLOAD_TOO_LARGE: "Revisa los datos e intenta de nuevo.",
  SERVER_ERROR: "No pudimos completar la solicitud. Intenta de nuevo.",
  PIN_SETUP_INVALID:
    "El código de autorización no es válido o venció. Pide otro al dueño.",
  PIN_SETUP_ACCOUNT_MISMATCH:
    "Entra con la cuenta de Google vinculada a este empleado.",
  RECOVERY_INVALID: "El enlace venció o ya fue utilizado. Solicita uno nuevo.",
  RECOVERY_LOCKED: "Demasiados intentos. Espera antes de volver a intentar.",
  RECOVERY_UNAVAILABLE:
    "No se puede recuperar el PIN de esta cuenta por correo.",
  EMAIL_UNAVAILABLE: "No pudimos enviar el correo. Intenta de nuevo más tarde.",
  NETWORK_ERROR: "No pudimos conectar. Revisa tu conexión e intenta de nuevo.",
};
function GoogleMark() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M21.8 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.5a4.7 4.7 0 0 1-2 3.1v2.6h3.3c1.9-1.8 3-4.4 3-7.6ZM12 22c2.7 0 4.9-.9 6.6-2.3l-3.3-2.6c-.9.6-2 .9-3.3.9-2.6 0-4.8-1.7-5.6-4H3v2.7A10 10 0 0 0 12 22ZM6.4 14a6 6 0 0 1 0-4V7.3H3a10 10 0 0 0 0 9.4L6.4 14ZM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.3L6.4 10A6 6 0 0 1 12 6Z"
      />
    </svg>
  );
}

export default function App() {
  const publicMenu = /^\/menu\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(window.location.pathname);
  if (publicMenu)
    return <Suspense fallback={loadingView}><PublicMenu menuId={publicMenu[1]} /></Suspense>;
  if (DevelopmentLogin && window.location.pathname === "/dev-login")
    return (
      <Suspense fallback={loadingView}>
        <DevelopmentLogin />
      </Suspense>
    );
  return <AccountApp />;
}

function AccountApp() {
  const [intent] = useState(entryIntent);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>(
    intent.device ? "employee" : "loading",
  );
  const [homeDestination, setHomeDestination] = useState<
    Destination | undefined
  >();
  const [moreReturn, setMoreReturn] = useState("");
  const [homeNotice, setHomeNotice] = useState("");
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  const [selected, setSelected] = useState<BusinessSummary | null>(null);
  const [operator, setOperator] = useState<OperatorSession | null>(null);
  const [draft, setDraft] = useState<BusinessDraft>(initialDraft);
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [invitationCode, setInvitationCode] = useState(
    () => sessionStorage.getItem(invitationKey) ?? "",
  );
  const [joinDetails, setJoinDetails] = useState<InvitationDetails | null>(
    null,
  );
  const [joinLoading, setJoinLoading] = useState(false);
  const [invitationConflict, setInvitationConflict] = useState(false);
  const [invitationLink, setInvitationLink] = useState("");
  const [deviceName, setDeviceName] = useState("Mi dispositivo");
  const [unreadCount, setUnreadCount] = useState(0);
  const [currentPin, setCurrentPin] = useState("");
  const pinChangeOperation = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const mutationPending = useRef(false);
  const joinOperationId = useRef(crypto.randomUUID());
  const joinPayload = useRef("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const operationId = useRef(crypto.randomUUID());
  const operationDraft = useRef<BusinessDraft | null>(null);
  const epoch = useRef(0);
  const endingIdentity = useRef(false);
  const closingPending = useRef(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const operatorRef = useRef(operator);
  const selectedRef = useRef(selected);
  const initialEntry = useRef(true);
  const businessesRef = useRef(businesses);
  const sessionRef = useRef(session);
  operatorRef.current = operator;
  selectedRef.current = selected;
  businessesRef.current = businesses;
  sessionRef.current = session;

  function navigate(next: Screen) {
    setScreen(next);
    window.scrollTo(0, 0);
    const path =
      next === "login"
        ? "/login"
        : next === "business" || next === "create-pin"
          ? "/business/new"
          : next === "join"
            ? "/join"
            : next === "employee"
              ? "/register"
              : next === "employee-entry"
                ? "/employee"
                : next === "unlock"
                  ? "/unlock"
                  : next === "ready"
                    ? "/business/ready"
                    : "/";
    window.history.replaceState({}, "", path);
  }

  function pinChangeOperationId(payload: unknown) {
    const fingerprint = JSON.stringify(payload);
    if (pinChangeOperation.current?.fingerprint !== fingerprint)
      pinChangeOperation.current = { fingerprint, id: crypto.randomUUID() };
    return pinChangeOperation.current.id;
  }

  function clearSensitive() {
    operatorRef.current = null;
    setOperator(null);
    setHomeDestination(undefined);
    setMoreReturn("");
    setHomeNotice("");
    setPin("");
    setConfirmation("");
    setCurrentPin("");
    setJoinDetails(null);
    setInvitationConflict(false);
    pinChangeOperation.current = null;
    mutationPending.current = false;
    sessionStorage.removeItem("pos-mexico-pin-recovery");
    joinPayload.current = "";
    joinOperationId.current = crypto.randomUUID();
    setRetryAt(0);
    setBusy(false);
  }

  function lockedScreen() {
    const business = operatorRef.current?.business ?? selectedRef.current;
    clearSensitive();
    if (!sessionRef.current) navigate("login");
    else if (business) {
      const summary = businessesRef.current.find(
        (entry) => entry.id === business.id,
      );
      setSelected({
        ...business,
        canRecoverPin:
          "role" in business
            ? business.role === "owner"
            : summary?.canRecoverPin,
        recoveryReady: summary?.recoveryReady ?? business.recoveryReady,
      });
      navigate("unlock");
    } else if (businessesRef.current.length) navigate("choose");
    else navigate("choice");
  }

  function summaryForContext(business: BusinessContext): BusinessSummary {
    const previous =
      businessesRef.current.find((entry) => entry.id === business.id) ??
      (selectedRef.current?.id === business.id ? selectedRef.current : null);
    return {
      ...business,
      canRecoverPin: business.role === "owner",
      recoveryReady: business.recoveryReady ?? previous?.recoveryReady,
    };
  }

  async function expireIdentity(
    message = "Tu sesión venció. Vuelve a entrar con Google.",
  ) {
    epoch.current += 1;
    const requestEpoch = epoch.current;
    endingIdentity.current = true;
    closingPending.current = true;
    const identityClose = closeIdentity(sessionRef.current?.access_token);
    clearSensitive();
    setBusy(true);
    setBusinesses([]);
    setSelected(null);
    setDraft(initialDraft);
    operationDraft.current = null;
    setSession(null);
    navigate("login");
    setError(message);
    const confirmed = await identityClose;
    if (requestEpoch === epoch.current) {
      if (!confirmed)
        setError(
          "Saliste de este dispositivo. No pudimos confirmar el cierre en el servidor; vuelve a conectar para revocar las sesiones.",
        );
      closingPending.current = false;
      setBusy(false);
    }
  }

  function showFailure(problem: unknown) {
    if (problem instanceof AccountClientError) {
      if (
        problem.code === "AUTH_REQUIRED" ||
        problem.code === "GOOGLE_REQUIRED"
      ) {
        void expireIdentity(accountMessages[problem.code]);
        return;
      }
      const deviceChangedDuringSession =
        Boolean(operatorRef.current) &&
        problem.code === "DEVICE_APPROVAL_REQUIRED";
      if (
        [
          "SESSION_INVALID",
          "SESSION_EXPIRED",
          "DEVICE_REVOKED",
          "EMPLOYEE_INACTIVE",
          "BUSINESS_ACCESS_DENIED",
          "PERMISSION_DENIED",
        ].includes(problem.code)
      )
        lockedScreen();
      if (
        [
          "DEVICE_APPROVAL_REQUIRED",
          "DEVICE_LINK_REQUIRED",
          "DEVICE_PROOF_INVALID",
        ].includes(problem.code)
      ) {
        if (operatorRef.current) lockedScreen();
        else setPin("");
      }
      if (problem.code === "PIN_LOCKED" || problem.code === "RECOVERY_LOCKED")
        setRetryAt(
          Date.now() + Math.max(1, problem.retryAfterSeconds ?? 900) * 1_000,
        );
      setError(
        deviceChangedDuringSession
          ? "Este navegador ya no tiene acceso. Ingresa tu PIN para solicitar al dueño un cambio de dispositivo."
          : (accountMessages[problem.code] ?? accountMessages.SERVER_ERROR),
      );
      return;
    }
    setError("No pudimos completar la solicitud. Intenta de nuevo.");
  }

  function showInvitationFailure(problem: unknown) {
    if (
      problem instanceof AccountClientError &&
      problem.code === "BUSINESS_ACCESS_DENIED"
    ) {
      setPin("");
      setConfirmation("");
      setJoinDetails(null);
      setInvitationConflict(true);
      setError(
        "Esta cuenta de Google ya está vinculada a otra persona de este negocio. Entra con otra cuenta o pide al dueño revisar tu acceso.",
      );
      return;
    }
    showFailure(problem);
  }

  async function loadBusinesses(choose = false) {
    const requestEpoch = epoch.current;
    const identity = sessionRef.current;
    if (!identity) return;
    setError("");
    setScreen("loading");
    try {
      const data = await accountRequest(
        { action: "status" },
        identity.access_token,
      );
      if (requestEpoch !== epoch.current) return;
      setBusinesses(data.businesses);
      const employeeEntry = sessionStorage.getItem(employeeEntryKey) === "true";
      const firstEntry = initialEntry.current;
      initialEntry.current = false;
      sessionStorage.removeItem(employeeEntryKey);
      const preferred = preferredBusiness(
        data.businesses,
        identity.user.id,
        employeeEntry,
      );
      if (choose) navigate("choose");
      else if (
        sessionStorage.getItem(invitationKey) ||
        (firstEntry && intent.join)
      )
        navigate("join");
      else if (firstEntry && intent.create) navigate("business");
      else if (!data.businesses.length) navigate("choice");
      else if (preferred) {
        setSelected(preferred);
        navigate("unlock");
      } else navigate("choose");
    } catch (problem) {
      if (requestEpoch !== epoch.current) return;
      navigate("retry");
      showFailure(problem);
    }
  }

  useEffect(() => {
    if (!supabase || intent.device) return;
    let alive = true;
    const initialEpoch = epoch.current;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, identity) => {
      if (!alive) return;
      if (event === "SIGNED_OUT") {
        if (!endingIdentity.current && hasCurrentStoredIdentity()) return;
        if (!endingIdentity.current) epoch.current += 1;
        clearSensitive();
        if (closingPending.current) setBusy(true);
        setBusinesses([]);
        setSelected(null);
        setDraft(initialDraft);
        operationDraft.current = null;
        sessionRef.current = null;
        setSession(null);
        navigate("login");
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        // SDK broadcasts can belong to a newer login in another document.
        // Cancelled requests are revoked by this document's generation guard.
        if (
          endingIdentity.current ||
          !identity ||
          !hasCurrentStoredIdentity(identity.access_token)
        )
          return;
        if (
          sessionRef.current &&
          identitySessionKey(sessionRef.current) !==
            identitySessionKey(identity)
        ) {
          epoch.current += 1;
          clearSensitive();
          setSelected(null);
          setBusinesses([]);
        }
        sessionRef.current = identity;
        setSession(identity);
      }
    });
    initializeIdentity()
      .then((identity) => {
        if (alive && !endingIdentity.current && initialEpoch === epoch.current)
          setSession(identity);
      })
      .catch((problem: unknown) => {
        if (!alive || endingIdentity.current || initialEpoch !== epoch.current)
          return;
        setSession(null);
        setError(
          problem instanceof Error
            ? problem.message
            : "Vuelve a entrar con Google.",
        );
      });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (session === undefined || !supabase || intent.device) return;
    if (!session) {
      navigate(intent.employee ? "employee-entry" : "login");
      return;
    }
    void loadBusinesses();
    // Refreshing the owner's JWT must not silently unlock or replace the operator session.
  }, [identitySessionKey(session), session === undefined]);

  useEffect(() => {
    if (!("BroadcastChannel" in window)) return;
    const bus = new BroadcastChannel("pos-mexico-session");
    channel.current = bus;
    bus.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== "lock" && event.data !== "logout") return;
      setError("");
      if (event.data === "logout") void expireIdentity("");
      else if (!endingIdentity.current) {
        epoch.current += 1;
        lockedScreen();
      }
    };
    return () => {
      bus.close();
      channel.current = null;
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  useEffect(() => {
    if (!retryAt) {
      setSecondsLeft(0);
      return;
    }
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
      setSecondsLeft(remaining);
      if (!remaining) {
        setRetryAt(0);
        setError("");
      }
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [retryAt]);

  useEffect(() => {
    if (!operator) return;
    const remaining = new Date(operator.expiresAt).getTime() - Date.now();
    const timeout = window.setTimeout(
      () => {
        epoch.current += 1;
        lockedScreen();
        setError("Tu sesión de trabajo venció. Ingresa tu PIN para continuar.");
      },
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(timeout);
  }, [operator]);

  useEffect(() => {
    if (!operator) return;
    const current = operator;
    const requestEpoch = epoch.current;
    let alive = true;
    let pending = false;
    async function checkAccess() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const data = await accountRequest({
          action: "context",
          businessId: current.business.id,
          operatorToken: current.operatorToken,
        });
        if (alive && requestEpoch === epoch.current)
          setOperator((latest) =>
            latest?.operatorToken === current.operatorToken
              ? {
                  ...latest,
                  business: data.business,
                  expiresAt: data.expiresAt,
                }
              : latest,
          );
      } catch (problem) {
        if (alive && requestEpoch === epoch.current) showFailure(problem);
      } finally {
        pending = false;
      }
    }
    const timer = window.setInterval(() => void checkAccess(), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkAccess();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [operator?.operatorToken]);

  useEffect(() => {
    setUnreadCount(0);
    if (operator?.business.role !== "owner" || screen === "notifications")
      return;
    let alive = true;
    let pending = false;
    const current = operator;
    async function refreshNotifications() {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const data = await accountRequest({
          action: "notifications",
          businessId: current.business.id,
          operatorToken: current.operatorToken,
        });
        if (alive) setUnreadCount(data.unreadCount);
      } catch {
        /* The inbox exposes retry/errors; access checks own session invalidation. */
      } finally {
        pending = false;
      }
    }
    void refreshNotifications();
    const visible = () => {
      void refreshNotifications();
    };
    const timer = window.setInterval(visible, 30_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [operator?.operatorToken, screen]);

  useEffect(() => {
    if (!operator) return;
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void lock();
      }, 15 * 60_000);
    };
    reset();
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    for (const event of events)
      window.addEventListener(event, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [operator?.operatorToken]);

  useEffect(() => {
    setJoinDetails(null);
    if (
      screen !== "join" ||
      !/^[a-f0-9]{64}$/i.test(invitationCode.trim()) ||
      !sessionRef.current
    ) {
      setJoinLoading(false);
      return;
    }
    const identity = sessionRef.current;
    const requestEpoch = epoch.current;
    let alive = true;
    setJoinLoading(true);
    setPin("");
    setConfirmation("");
    setError("");
    setInvitationConflict(false);
    void accountRequest(
      { action: "invitation_details", invitationCode: invitationCode.trim() },
      identity.access_token,
    )
      .then((result) => {
        if (
          alive &&
          requestEpoch === epoch.current &&
          identitySessionKey(sessionRef.current) ===
            identitySessionKey(identity)
        )
          setJoinDetails(result);
      })
      .catch((problem) => {
        if (alive && requestEpoch === epoch.current)
          showInvitationFailure(problem);
      })
      .finally(() => {
        if (alive && requestEpoch === epoch.current) setJoinLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [screen === "join", invitationCode, identitySessionKey(session)]);

  function useInvitationLink(link = invitationLink) {
    const code = invitationFromLink(link);
    if (!code) {
      setError(
        "Pega el enlace de invitación de POS México que te compartió el dueño.",
      );
      return;
    }
    sessionStorage.setItem(invitationKey, code);
    setInvitationCode(code);
    setError("");
    setInvitationLink("");
    setInvitationConflict(false);
    navigate(session ? "join" : "login");
  }

  async function googleLogin() {
    if (!supabase || busy) return;
    const requestEpoch = epoch.current;
    allowIdentitySignIn();
    setBusy(true);
    setError("");
    try {
      if (requestEpoch !== epoch.current) return;
      const { error: problem } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          scopes: "openid email profile",
          queryParams: { prompt: "select_account" },
        },
      });
      if (problem) throw problem;
    } catch {
      if (requestEpoch !== epoch.current) return;
      closingPending.current = false;
      setError(
        "No pudimos abrir Google. Revisa tu conexión e intenta de nuevo.",
      );
      setBusy(false);
    }
  }

  function nextBusiness(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim().replace(/\s+/g, " ");
    if (Array.from(name).length < 2 || Array.from(name).length > 100) {
      setError("Escribe un nombre de entre 2 y 100 caracteres.");
      return;
    }
    const profile = {
      ...draft.profile,
      branchName: draft.profile.branchName.trim(),
      registerName: draft.profile.registerName.trim(),
      address: draft.profile.address.trim(),
      city: draft.profile.city.trim(),
      state: draft.profile.state.trim(),
      contactPhone: draft.profile.contactPhone.trim(),
    };
    if (!profile.branchName || !profile.registerName) {
      setError("Escribe el nombre de la sucursal y la caja.");
      return;
    }
    if (!profile.paymentMethods.length) {
      setError("Elige al menos un método de pago.");
      return;
    }
    if (
      profile.contactPhone &&
      !/^[+0-9() -]{5,30}$/.test(profile.contactPhone)
    ) {
      setError(
        "Revisa el teléfono del negocio. Usa números y, si hace falta, el código de país.",
      );
      return;
    }
    const nextDraft = { ...draft, name, profile };
    setDraft(nextDraft);
    setError("");
    setPin("");
    setConfirmation("");
    if (
      !operationDraft.current ||
      JSON.stringify(operationDraft.current) !== JSON.stringify(nextDraft)
    ) {
      operationId.current = crypto.randomUUID();
      operationDraft.current = nextDraft;
    }
    navigate("create-pin");
  }

  async function joinBusiness(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^[a-f0-9]{64}$/i.test(invitationCode.trim())) {
      setError("Revisa el código de invitación.");
      return;
    }
    if (
      !joinDetails ||
      !/^[0-9]{6}$/.test(pin) ||
      (!joinDetails.employee.pinReady && pin !== confirmation)
    ) {
      setError(
        joinDetails?.employee.pinReady
          ? "Escribe tu PIN actual de seis dígitos."
          : "Escribe y confirma el mismo PIN de 6 dígitos.",
      );
      return;
    }
    const requestEpoch = epoch.current;
    const identity = sessionRef.current;
    if (!identity) return;
    const payload = JSON.stringify({
      invitationCode: invitationCode.trim(),
      pin,
    });
    if (joinPayload.current !== payload) {
      joinOperationId.current = crypto.randomUUID();
      joinPayload.current = payload;
    }
    setBusy(true);
    setError("");
    try {
      const data = await accountRequest(
        {
          action: "accept_invitation",
          invitationCode: invitationCode.trim(),
          pin,
          deviceName,
          operationId: joinOperationId.current,
        },
        identity.access_token,
      );
      if (
        requestEpoch !== epoch.current ||
        identitySessionKey(sessionRef.current) !== identitySessionKey(identity)
      ) {
        await accountRequest(
          {
            action: "lock",
            businessId: data.business.id,
            operatorToken: data.operatorToken,
          },
          identity.access_token,
        ).catch(() => undefined);
        return;
      }
      sessionStorage.removeItem(invitationKey);
      rememberBusiness(identity.user.id, data.business.id);
      setOperator(data);
      setSelected(summaryForContext(data.business));
      setBusinesses((current) =>
        current.some((business) => business.id === data.business.id)
          ? current
          : [...current, data.business],
      );
      setPin("");
      setConfirmation("");
      setInvitationCode("");
      navigate("home");
      joinPayload.current = "";
    } catch (problem) {
      if (
        requestEpoch !== epoch.current ||
        identitySessionKey(sessionRef.current) !== identitySessionKey(identity)
      )
        return;
      if (
        problem instanceof AccountClientError &&
        problem.code === "DEVICE_APPROVAL_REQUIRED"
      ) {
        // This denial follows a valid PIN and committed invitation acceptance; no operator was issued.
        const joinedBusiness = joinDetails.business;
        sessionStorage.removeItem(invitationKey);
        setInvitationCode("");
        setJoinDetails(null);
        setInvitationConflict(false);
        setBusinesses((current) =>
          current.some((business) => business.id === joinedBusiness.id)
            ? current
            : [...current, joinedBusiness],
        );
        setSelected(joinedBusiness);
        setPin("");
        setConfirmation("");
        joinPayload.current = "";
        navigate("unlock");
        void accountRequest({ action: "status" }, identity.access_token)
          .then((status) => {
            if (
              requestEpoch !== epoch.current ||
              identitySessionKey(sessionRef.current) !==
                identitySessionKey(identity)
            )
              return;
            setBusinesses(status.businesses);
            const summary = status.businesses.find(
              (business) => business.id === joinedBusiness.id,
            );
            if (
              summary &&
              selectedRef.current?.id === joinedBusiness.id &&
              !operatorRef.current
            )
              setSelected(summary);
          })
          .catch(() => {
            /* The known business still allows a PIN retry if this refresh fails. */
          });
      }
      if (
        requestEpoch === epoch.current &&
        identitySessionKey(sessionRef.current) === identitySessionKey(identity)
      )
        showInvitationFailure(problem);
    } finally {
      if (requestEpoch === epoch.current) setBusy(false);
    }
  }

  async function saveChangedPin(event: FormEvent) {
    event.preventDefault();
    const current = operatorRef.current;
    const identity = sessionRef.current;
    if (
      !current ||
      !identity ||
      busy ||
      mutationPending.current ||
      retryAt > Date.now()
    )
      return;
    if (
      !/^[0-9]{6}$/.test(currentPin) ||
      !/^[0-9]{6}$/.test(pin) ||
      pin !== confirmation
    ) {
      setError(
        "Escribe el PIN actual y confirma el nuevo PIN de seis dígitos.",
      );
      return;
    }
    const requestEpoch = epoch.current;
    mutationPending.current = true;
    setBusy(true);
    setError("");
    try {
      const payload = {
        action: "change_pin" as const,
        businessId: current.business.id,
        operatorToken: current.operatorToken,
        currentPin,
        pin,
      };
      const data = await accountRequest(
        { ...payload, operationId: pinChangeOperationId(payload) },
        identity.access_token,
      );
      if (
        requestEpoch !== epoch.current ||
        identitySessionKey(sessionRef.current) !== identitySessionKey(identity)
      ) {
        await accountRequest(
          {
            action: "lock",
            businessId: data.business.id,
            operatorToken: data.operatorToken,
          },
          identity.access_token,
        ).catch(() => undefined);
        return;
      }
      rememberBusiness(identity.user.id, data.business.id);
      setOperator(data);
      setSelected(summaryForContext(data.business));
      setPin("");
      setConfirmation("");
      setCurrentPin("");
      pinChangeOperation.current = null;
      setHomeNotice("PIN actualizado.");
      navigate("home");
    } catch (problem) {
      if (requestEpoch === epoch.current) showFailure(problem);
    } finally {
      if (requestEpoch === epoch.current) {
        mutationPending.current = false;
        setBusy(false);
      }
    }
  }

  function changeBusiness() {
    if (operatorRef.current) {
      void switchBusiness();
      return;
    }
    clearSensitive();
    setError("");
    setSelected(null);
    void loadBusinesses(true);
  }

  async function switchBusiness() {
    const current = operatorRef.current;
    if (!current || busy) return;
    const requestEpoch = ++epoch.current;
    clearSensitive();
    setSelected(null);
    setBusy(true);
    setError("");
    navigate("choose");
    channel.current?.postMessage("lock");
    try {
      await accountRequest({
        action: "lock",
        businessId: current.business.id,
        operatorToken: current.operatorToken,
      });
      const identity = sessionRef.current;
      if (identity && requestEpoch === epoch.current) {
        const status = await accountRequest(
          { action: "status" },
          identity.access_token,
        );
        if (requestEpoch === epoch.current) setBusinesses(status.businesses);
      }
    } catch (problem) {
      if (requestEpoch === epoch.current) showFailure(problem);
    } finally {
      if (requestEpoch === epoch.current) setBusy(false);
    }
  }

  function savedBusiness(business: BusinessContext) {
    if (
      !operatorRef.current ||
      operatorRef.current.business.id !== business.id ||
      endingIdentity.current
    )
      return;
    setOperator((current) => (current ? { ...current, business } : current));
    const summary = summaryForContext(business);
    setSelected(summary);
    setBusinesses((current) =>
      current.map((entry) => (entry.id === business.id ? summary : entry)),
    );
  }

  async function submitPin(event?: FormEvent, submittedPin = pin) {
    event?.preventDefault();
    if (busy || retryAt > Date.now()) return;
    setError("");
    if (!/^[0-9]{6}$/.test(submittedPin)) {
      setError("Ingresa un PIN de 6 dígitos.");
      return;
    }
    if (screen === "create-pin" && confirmation !== submittedPin) {
      setError("Los PIN no coinciden. Revísalos e intenta de nuevo.");
      return;
    }
    const requestEpoch = epoch.current;
    const creatingBusiness = screen === "create-pin";
    const identity = sessionRef.current;
    if (!identity) return;
    setBusy(true);
    try {
      const data = creatingBusiness
        ? await accountRequest(
            {
              action: "create_business",
              ...draft,
              operationId: operationId.current,
              pin: submittedPin,
            },
            identity.access_token,
          )
        : await accountRequest(
            { action: "unlock", businessId: selected!.id, pin: submittedPin, deviceName },
            identity.access_token,
          );
      if (
        requestEpoch !== epoch.current ||
        identitySessionKey(sessionRef.current) !== identitySessionKey(identity)
      ) {
        await accountRequest(
          {
            action: "lock",
            businessId: data.business.id,
            operatorToken: data.operatorToken,
          },
          identity.access_token,
        ).catch(() => undefined);
        return;
      }
      rememberBusiness(identity.user.id, data.business.id);
      setOperator(data);
      setSelected(summaryForContext(data.business));
      setBusinesses((current) =>
        current.some((business) => business.id === data.business.id)
          ? current
          : [...current, data.business],
      );
      setPin("");
      setConfirmation("");
      setDraft(initialDraft);
      operationDraft.current = null;
      navigate("home");
    } catch (problem) {
      if (requestEpoch === epoch.current) showFailure(problem);
    } finally {
      if (requestEpoch === epoch.current) setBusy(false);
    }
  }

  async function lock() {
    if (!operator || busy) return;
    setBusy(true);
    setError("");
    const revocation = accountRequest(
      {
        action: "lock",
        businessId: operator.business.id,
        operatorToken: operator.operatorToken,
      },
      sessionRef.current?.access_token,
    );
    epoch.current += 1;
    const requestEpoch = epoch.current;
    lockedScreen();
    setBusy(true);
    channel.current?.postMessage("lock");
    try {
      await revocation;
    } catch (problem) {
      if (requestEpoch === epoch.current) showFailure(problem);
    } finally {
      if (requestEpoch === epoch.current) setBusy(false);
    }
  }

  function openMoreScreen(next: Screen, focus: string) {
    setHomeNotice("");
    setMoreReturn(focus);
    navigate(next);
  }

  function changePin(returnFocus = "pin") {
    if (!operatorRef.current || busy) return;
    setCurrentPin("");
    setPin("");
    setConfirmation("");
    setError("");
    pinChangeOperation.current = null;
    openMoreScreen("change-pin", returnFocus);
  }

  async function logout() {
    if (busy) return;
    const accessToken = sessionRef.current?.access_token;
    const revocation = accountRequest(
      { action: "revoke_sessions" },
      accessToken,
    );
    epoch.current += 1;
    const requestEpoch = epoch.current;
    endingIdentity.current = true;
    closingPending.current = true;
    const identityClose = closeIdentity(accessToken);
    clearSensitive();
    setBusy(true);
    setBusinesses([]);
    setSelected(null);
    setDraft(initialDraft);
    operationDraft.current = null;
    setSession(null);
    navigate("login");
    setError("");
    channel.current?.postMessage("logout");
    const results = await Promise.allSettled([revocation, identityClose]);
    if (requestEpoch !== epoch.current) return;
    // Revoking the Google-backed Supabase session invalidates its operator tokens
    // even when revoke_sessions races with that revocation and returns AUTH_REQUIRED.
    const identityResult = results[1];
    const failed =
      identityResult.status === "rejected" || identityResult.value !== true;
    setError(
      failed
        ? "Saliste de este dispositivo. No pudimos confirmar el cierre en el servidor; vuelve a conectar para revocar las sesiones."
        : "",
    );
    setBusy(false);
    closingPending.current = false;
  }

  const hasIdentity = Boolean(session);
  const createPin = screen === "create-pin";
  const isManagement = [
    "settings",
    "team",
    "devices",
    "notifications",
    "account-profile",
  ].includes(screen);
  const isHome = screen === "home" && Boolean(operator);
  const isReady = screen === "ready" && Boolean(operator);
  const isWorkspace = Boolean(operator) && (isHome || isManagement || screen === 'change-pin');
  const identityName = session?.user.user_metadata.full_name ?? session?.user.user_metadata.name;
  const accountName = typeof identityName === 'string' && identityName.trim()
    ? identityName.trim()
    : session?.user.email ?? 'Mi cuenta';
  const managementContent = screen === 'account-profile' && operator ? (
    <AccountProfileSettings business={operator.business} operatorToken={operator.operatorToken} accountName={accountName} onSaved={savedBusiness} onSessionError={showFailure} />
  ) : screen === 'change-pin' && operator ? (
    <section className="screen management-polish access-pin-change">
      <h1 className="sr-only">Cambiar mi PIN</h1>
      <form onSubmit={(event) => void saveChangedPin(event)}>
        <div className="field">
          <label htmlFor="current-pin">PIN actual</label>
          <input
            id="current-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={currentPin}
            onChange={(event) =>
              setCurrentPin(
                event.target.value.replace(/[^0-9]/g, "").slice(0, 6),
              )
            }
            maxLength={6}
            disabled={busy}
            required
          />
        </div>
        <p id="pin-help" className="field-help text-sm text-muted">
          Usa seis dígitos.
        </p>
        <PinField
          label="Nuevo PIN"
          value={pin}
          onChange={setPin}
          disabled={busy}
        />
        <PinField
          label="Confirma tu PIN"
          value={confirmation}
          onChange={setConfirmation}
          confirm
          disabled={busy}
        />
        {error && (
          <p
            className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        {secondsLeft > 0 && (
          <p role="status">
            Vuelve a intentar en {Math.ceil(secondsLeft / 60)} min.
          </p>
        )}
        <div className="screen-actions mt-10 flex flex-col gap-3">
          <button
            className="button primary"
            disabled={busy || secondsLeft > 0}
            aria-busy={busy}
          >
            <AccessButtonContent busy={busy}>Guardar nuevo PIN</AccessButtonContent>
          </button>
        </div>
      </form>
    </section>
  ) : screen === 'settings' && operator?.business.role === 'owner' ? (
    <BusinessSettings embeddedTitle business={operator.business} focusPaymentMethods={moreReturn === "payment-methods"} operatorToken={operator.operatorToken} onSaved={savedBusiness} onBack={() => navigate('home')} onSessionError={showFailure} />
  ) : (screen === 'team' || screen === 'devices') && operator?.business.role === 'owner' ? (
    <TeamPanel key={screen} embeddedTitle section={screen === 'devices' ? 'devices' : 'employees'} business={operator.business} operatorToken={operator.operatorToken} onBack={() => navigate('home')} onSessionError={showFailure} />
  ) : screen === 'notifications' && operator?.business.role === 'owner' ? (
    <NotificationsPanel businessId={operator.business.id} operatorToken={operator.operatorToken} onBack={() => navigate('home')} onSessionError={showFailure} onUnreadCount={setUnreadCount} />
  ) : undefined;
  const managementTitle = ({team:'Empleados', devices:'Dispositivos', settings:'Configuración', notifications:'Notificaciones', 'change-pin':'Mi acceso', 'account-profile':'Mi cuenta'} as Record<string,string>)[screen];

  const back = () => {
    setError("");
    setPin("");
    setConfirmation("");
    navigate(createPin ? "business" : "choose");
  };

  if (intent.device || screen === "employee")
    return (
      <Suspense fallback={<LoadingScreen />}>
        <DeviceLogin onExit={() => window.location.assign("/login")} />
      </Suspense>
    );


  return (
    <div
      className={`app-shell flex min-h-dvh flex-col ${isWorkspace ? "pos-shell" : isReady ? "home-shell" : screen === "unlock" ? "pin-unlock-shell" : ""}`}
    >
      <a
        className="sr-only fixed top-3 left-3 z-50 rounded-lg bg-ink px-4 py-3 text-white focus:not-sr-only"
        href="#main-content"
      >
        Ir al contenido
      </a>
      {!isWorkspace && screen !== "unlock" && screen !== "loading" && (
        <header className="app-header flex h-22 shrink-0 items-center justify-between gap-4 px-10 max-compact:h-19 max-compact:px-6">
          <span className="wordmark inline-flex items-center gap-2.5 text-[17px] font-semibold tracking-tight max-compact:text-base">
            POS México
            <span
              className="wordmark-square size-2.5 rounded-xs bg-ink"
              aria-hidden="true"
            />
          </span>
          {hasIdentity && (
            <button
              className="header-logout flex min-h-12 items-center gap-2 border-0 bg-transparent px-1 text-sm text-muted hover:text-ink max-compact:text-[13px]"
              onClick={() => void logout()}
              disabled={busy}
            >
              <LogOut size={18} aria-hidden="true" />
              <span>Cerrar sesión</span>
            </button>
          )}
        </header>
      )}
      <main
        id="main-content"
        tabIndex={-1}
        className={
          isWorkspace
            ? "pos-home min-w-0 w-full flex-1"
            : isReady
              ? "business-home mx-auto mt-16 w-full max-w-260 flex-1 px-10 pb-16 max-compact:mt-8 max-compact:flex max-compact:px-6 max-compact:pb-10"
              : isManagement
                ? "management-main mx-auto mt-6 w-full max-w-260 flex-1 px-10 max-compact:mt-4 max-compact:px-6"
                : screen === "loading"
                  ? "loading-main flex w-full flex-1"
                  : screen === "unlock"
                    ? "pin-unlock-main flex w-full flex-1"
                    : `auth-panel mx-auto mt-8 w-full max-w-117 flex-1 px-6 pt-8 pb-12 max-compact:mt-4 max-compact:flex max-compact:flex-col max-compact:pt-6 max-compact:pb-10${screen === "business" ? " access-auth-wide" : ""}`
        }
      >
        <Suspense fallback={screen === "unlock" || screen === "loading" ? loadingView : <LoadingPlaceholder variant={isManagement ? "list" : "form"} rows={3} label="Cargando módulo" />}>
          {!supabase ? (
            <section className="access-flow screen">
              <div className="access-symbol">
                <Store aria-hidden="true" />
              </div>
              <h1>La app está en preparación</h1>
              <p>
                Falta conectar el servicio de acceso. Contacta al equipo de POS
                México para terminar la configuración.
              </p>
            </section>
          ) : screen === "loading" ? (
            loadingView
          ) : screen === "login" ? (
            <section className="access-flow screen login-screen">
              <div className="access-symbol">
                <Store size={28} strokeWidth={1.5} aria-hidden="true" />
              </div>
              <h1>
                {invitationCode ? (
                  "Acepta tu invitación"
                ) : (
                  "Inicia sesión"
                )}
              </h1>
              <p>
                {developmentLoginEnabled
                  ? "Trabaja con una cuenta de prueba y datos locales."
                  : invitationCode
                    ? "Continúa con Google y elige tu PIN personal."
                    : "Continúa con Google para entrar a tu negocio."}
              </p>
              {error && (
                <p
                  className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <div className="screen-actions mt-10 flex flex-col gap-3">
                {developmentLoginEnabled ? (
                  <a className="button primary" href="/dev-login">
                    Entrar en desarrollo
                  </a>
                ) : (
                  <button
                    className="button primary google-button"
                    onClick={() => void googleLogin()}
                    disabled={busy}
                    aria-busy={busy}
                  >
                      <AccessButtonContent busy={busy}><GoogleMark /><span>Continuar con Google</span></AccessButtonContent>
                  </button>
                )}
                {!invitationCode && (
                  <>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => window.location.assign("/employee")}
                    >
                      Entrar como empleado
                    </button>
                    <button
                      className="text-button min-h-12 cursor-pointer border-0 bg-transparent text-ink underline underline-offset-4 hover:text-brand"
                      disabled={busy}
                      onClick={() => window.location.assign("/register")}
                    >
                      Abrir caja compartida
                    </button>
                  </>
                )}
              </div>
            </section>
          ) : screen === "employee-entry" ? (
            <section className="access-flow screen">
              <button
                className="back-button -mt-4 mb-4 flex min-h-12 items-center gap-2 self-start border-0 bg-transparent pt-0 pb-4 text-sm text-muted hover:text-ink"
                onClick={() => {
                  sessionStorage.removeItem(employeeEntryKey);
                  navigate("login");
                }}
              >
                <ArrowLeft size={20} />
                Volver
              </button>
              <h1>Acceso de empleado</h1>
              <p>
                {developmentLoginEnabled
                  ? "Usa tu cuenta de prueba o una invitación."
                  : "Continúa con tu cuenta de Google."}
              </p>
              {error && (
                <p
                  className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
                  role="alert"
                >
                  {error}
                </p>
              )}
              {developmentLoginEnabled ? (
                <a className="button primary" href="/dev-login">
                  Entrar en desarrollo
                </a>
              ) : (
                <button
                  className="button primary google-button"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => void googleLogin()}
                >
                  <AccessButtonContent busy={busy}><GoogleMark /><span>Continuar con Google</span></AccessButtonContent>
                </button>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  useInvitationLink();
                }}
              >
                <h2>Tengo una invitación</h2>
                <InvitationScanner
                  onInvitation={useInvitationLink}
                  disabled={busy}
                />
                <div className="field">
                  <label htmlFor="employee-invitation-link">
                    Enlace de invitación
                  </label>
                  <input
                    id="employee-invitation-link"
                    type="url"
                    autoComplete="off"
                    required
                    value={invitationLink}
                    onChange={(event) => setInvitationLink(event.target.value)}
                  />
                </div>
                <button
                  className="button secondary"
                  type="submit"
                  disabled={busy}
                >
                  Abrir invitación
                </button>
              </form>
              <button
                className="text-button min-h-12 cursor-pointer border-0 bg-transparent text-ink underline underline-offset-4 hover:text-brand"
                onClick={() => window.location.assign("/register")}
              >
                Abrir caja compartida
              </button>
            </section>
          ) : screen === "choice" ? (
            <section className="access-flow screen">
              <h1>Tu negocio</h1>
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
                  className="button primary access-choice-button"
                  onClick={() => {
                    setError("");
                    setDraft(initialDraft);
                    navigate("business");
                  }}
                >
                  <Store size={20} aria-hidden="true" />Crear mi negocio
                  <ArrowRight size={20} />
                </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    setError("");
                    navigate("join");
                  }}
                >
                  Unirme a un negocio
                </button>
              </div>
            </section>
          ) : screen === "join" ? (
            <section className="access-flow screen">
              <button
                className="back-button -mt-4 mb-4 flex min-h-12 items-center gap-2 self-start border-0 bg-transparent pt-0 pb-4 text-sm text-muted hover:text-ink"
                disabled={busy}
                onClick={() => {
                  clearSensitive();
                  setError("");
                  navigate(businesses.length ? "choose" : "choice");
                }}
              >
                <ArrowLeft size={20} />
                Volver
              </button>
              <h1>Unirme a un negocio</h1>
              <p>
                {joinLoading ? <Skeleton width="75%" height={18} /> : invitationConflict
                  ? "Tu invitación sigue disponible. Puedes continuar con otra cuenta de Google."
                  : joinDetails
                    ? `Invitación para ${joinDetails.employee.name} en ${joinDetails.business.name}.`
                    : "Escanea el QR o pega el enlace de invitación."}
              </p>
              <form onSubmit={(event) => void joinBusiness(event)}>
                {!joinDetails && !invitationConflict && !joinLoading && (
                  <>
                    <InvitationScanner
                      onInvitation={useInvitationLink}
                      disabled={busy}
                    />
                    <div className="field">
                      <label htmlFor="invitation-link">
                        Enlace de invitación
                      </label>
                      <input
                        id="invitation-link"
                        type="url"
                        disabled={busy}
                        autoComplete="off"
                        value={invitationLink}
                        onChange={(event) =>
                          setInvitationLink(event.target.value)
                        }
                      />
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy || !invitationLink.trim()}
                        onClick={() => useInvitationLink()}
                      >
                        Abrir invitación
                      </button>
                    </div>
                  </>
                )}
                {joinLoading && <LoadingPlaceholder variant="form" rows={2} label="Revisando invitación" />}
                {joinDetails && (
                  <>
                    <p>
                      Este será tu dispositivo de acceso. El dueño debe autorizar cualquier cambio.
                    </p>
                    <div className="field">
                      <label htmlFor="join-device-name">
                        Nombre de este dispositivo
                      </label>
                      <input
                        id="join-device-name"
                        value={deviceName}
                        required
                        maxLength={100}
                        onChange={(event) => setDeviceName(event.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <p id="pin-help" className="field-help text-sm text-muted">
                      {joinDetails.employee.pinReady
                        ? "Usa el PIN que ya tienes en la caja."
                        : "Elige tu PIN personal de seis dígitos."}
                    </p>
                    <PinField
                      label={
                        joinDetails.employee.pinReady ? "PIN actual" : "PIN"
                      }
                      value={pin}
                      onChange={setPin}
                      disabled={busy}
                    />
                    {!joinDetails.employee.pinReady && (
                      <PinField
                        label="Confirma tu PIN"
                        value={confirmation}
                        onChange={setConfirmation}
                        confirm
                        disabled={busy}
                      />
                    )}
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
                  {invitationConflict ? (
                    <button
                      className="button primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void logout()}
                    >
                      Usar otra cuenta de Google
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={busy || !joinDetails}
                      aria-busy={busy}
                    >
                      <AccessButtonContent busy={busy}>Unirme</AccessButtonContent>
                    </button>
                  )}
                </div>
              </form>
            </section>
          ) : screen === "recover-email" && selected && session ? (
            <RequestPinRecovery
              businessName={selected.name}
              email={session.user.email}
              request={() =>
                accountRequest(
                  { action: "request_pin_email", businessId: selected.id },
                  session.access_token,
                )
              }
              onBack={() => {
                setError("");
                navigate("unlock");
              }}
              onSessionError={showFailure}
            />
          ) : screen === "business" ? (
            <BusinessSetup draft={draft} onChange={setDraft} onSubmit={nextBusiness} error={error} />
          ) : screen === "unlock" ? (
            <PinUnlockScreen
              businessName={selected?.name ?? ""}
              busy={busy}
              error={error}
              secondsLeft={secondsLeft}
              onUnlock={(value) => submitPin(undefined, value)}
              onRecover={() => {
                setPin("");
                setError("");
                navigate("recover-email");
              }}
              onChangeBusiness={changeBusiness}
              onLogout={() => void logout()}
            />
          ) : createPin ? (
            <section className="access-flow screen">
              <button
                className="back-button -mt-4 mb-4 flex min-h-12 items-center gap-2 self-start border-0 bg-transparent pt-0 pb-4 text-sm text-muted hover:text-ink"
                onClick={back}
                disabled={busy}
              >
                <ArrowLeft size={20} aria-hidden="true" />
                Volver
              </button>
              <ol className="business-setup-progress" aria-label="Crear negocio">
                <li className="current"><span aria-hidden="true">1</span>Negocio</li>
                <li className="current"><span aria-hidden="true">2</span>Operación</li>
                <li className="current" aria-current="step"><span aria-hidden="true">3</span>PIN</li>
              </ol>
              <h1>Crea tu PIN</h1>
              <p className="text-sm text-muted">{draft.name}</p>
              <form onSubmit={(event) => void submitPin(event)}>
                <p id="pin-help" className="field-help text-sm text-muted">
                  Seis dígitos para entrar a tu negocio.
                </p>
                <PinField label="PIN" value={pin} onChange={setPin} disabled={busy || secondsLeft > 0} />
                <PinField
                  label="Confirma tu PIN"
                  value={confirmation}
                  onChange={setConfirmation}
                  confirm
                  disabled={busy}
                />
                {error && (
                  <p className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger" role="alert">
                    {error}
                  </p>
                )}
                {secondsLeft > 0 && (
                  <p className="countdown -mt-3 text-sm" role="timer" aria-live="off">
                    Podrás intentar de nuevo en {Math.floor(secondsLeft / 60)}:
                    {String(secondsLeft % 60).padStart(2, "0")}.
                  </p>
                )}
                <div className="screen-actions mt-10 flex flex-col gap-3">
                  <button className="button primary" type="submit" disabled={busy || secondsLeft > 0} aria-busy={busy}>
                    <AccessButtonContent busy={busy}>Crear negocio<ArrowRight size={20} aria-hidden="true" /></AccessButtonContent>
                  </button>
                </div>
              </form>
            </section>
          ) : screen === "choose" ? (
            <section className="access-flow screen">
              <h1>Tus negocios</h1>
              {error && (
                <p
                  className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <div className="mt-8 mb-6 flex flex-col gap-6">
                {[
                  {
                    title: "Mis negocios",
                    entries: businesses.filter(business => business.role === "owner"),
                  },
                  {
                    title: "Como empleado",
                    entries: businesses.filter(business => business.role && business.role !== "owner"),
                  },
                  {
                    title: "Negocios disponibles",
                    entries: businesses.filter(business => !business.role),
                  },
                ].filter(group => group.entries.length).map(group => (
                  <section key={group.title} aria-label={group.title}>
                    <h2 className="mb-2 text-sm text-muted">{group.title}</h2>
                    <div className="business-list flex flex-col border-t border-line">
                      {group.entries.map(business => (
                        <button
                          className="business-choice flex min-h-21 w-full items-center gap-3.5 border-0 border-b border-line bg-white py-4 text-left hover:bg-surface"
                          disabled={busy}
                          key={business.id}
                          onClick={() => {
                            setSelected(business);
                            setError("");
                            setPin("");
                            setRetryAt(0);
                            navigate("unlock");
                          }}
                        >
                          <span className="business-icon grid size-12 shrink-0 place-items-center rounded-xl bg-surface">
                            <Coffee size={22} strokeWidth={1.5} aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                            <span className="block font-medium">{business.name}</span>
                          </span>
                          <ChevronRight size={20} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
                {!businesses.length && (
                  <p>No tienes negocios vinculados. Crea uno o abre una invitación.</p>
                )}
              </div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  operationId.current = crypto.randomUUID();
                  setDraft(initialDraft);
                  setError("");
                  navigate("business");
                }}
              >
                Crear otro negocio
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setError("");
                  navigate("join");
                }}
              >
                Unirme a un negocio
              </button>
            </section>
          ) : isReady && operator ? (
            <section className="access-flow ready-screen">
              <div className="ready-mark access-symbol">
                <Check size={28} strokeWidth={2} aria-hidden="true" />
              </div>
              <p className="business-name mb-3 font-medium text-ink">
                {operator.business.name}
              </p>
              <h1>Cuenta creada</h1>
              <p>Tu negocio y tu acceso quedaron guardados.</p>
              {error && (
                <p
                  className="error-message mt-4 border-l-3 border-danger py-0.5 pl-3 text-sm text-danger"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <div className="home-actions flex max-w-70 flex-col gap-3 max-compact:mt-auto max-compact:max-w-none max-compact:pt-4">
                <button
                  className="button primary"
                  onClick={() => navigate("home")}
                  disabled={busy}
                >
                  Abrir Dashboard
                  <ArrowRight size={20} aria-hidden="true" />
                </button>
                <button
                  className="button secondary"
                  onClick={() => void lock()}
                  disabled={busy}
                >
                  <AccessButtonContent busy={busy}><LockKeyhole size={20} aria-hidden="true" />Bloquear</AccessButtonContent>
                </button>
              </div>
            </section>
          ) : isWorkspace && operator ? (
            <HomeScreen
              key={operator.operatorToken}
              managementContent={managementContent}
              managementTitle={managementTitle}
              managementKey={managementContent ? screen : undefined}
              business={operator.business}
              accountName={accountName}
              operatorToken={operator.operatorToken}
              onSessionError={showFailure}
              onLock={() => void lock()}
              onLogout={() => void logout()}
              busy={busy}
              error={error}
              destination={homeDestination}
              onDestinationChange={(value) => {
                if (screen !== "home") navigate("home");
                setHomeDestination(value);
                setMoreReturn("");
                setHomeNotice("");
              }}
              focusOnReturn={moreReturn}
              notice={homeNotice}
              onSettings={(section) => openMoreScreen("settings", section ?? "settings")}
              onTeam={() => openMoreScreen("team", "employees")}
              onDevices={() => openMoreScreen("devices", "devices")}
              onSwitchBusiness={changeBusiness}
              onChangePin={(returnFocus = "pin") => changePin(returnFocus)}
              onAccountProfile={() => openMoreScreen("account-profile", "account")}
              onNotifications={() =>
                openMoreScreen("notifications", "notifications")
              }
              unreadCount={unreadCount}
            />
          ) : (
            <section className="access-flow screen">
              <h1>No pudimos cargar tu negocio</h1>
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
                  className="button primary"
                  onClick={() => void loadBusinesses()}
                >
                  Intentar de nuevo
                </button>
              </div>
            </section>
          )}
        </Suspense>
      </main>
    </div>
  );
}

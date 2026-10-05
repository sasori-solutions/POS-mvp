import { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { accountRequest, AccountClientError } from '../lib/account';
import type { BusinessContext } from '../lib/contracts';
import { prepareProfileImage, sendProfileImage, type ProfileImageSubject, type ProfileImageUpload } from '../lib/profile-images';
import { accessErrorCodes } from './useCatalog';
import { PendingIndicator } from './LoadingPlaceholder';
import './business-profile.css';

export default function ProfileImageEditor({ business, operatorToken, subject, name, onSaved, onSessionError, disabled = false, onBusyChange }: {
  business: BusinessContext; operatorToken: string; subject: ProfileImageSubject; name: string;
  onSaved: (business: BusinessContext) => void; onSessionError?: (error: AccountClientError) => void;
  disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hasPending, setHasPending] = useState(false);
  const pending = useRef<ProfileImageUpload | null>(null);
  const removing = useRef<string | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const identity = `${business.id}:${operatorToken}:${subject}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const image = subject === 'business' ? business.logoUrl : business.accountAvatarUrl;
  const access = { businessId: business.id, operatorToken };
  const label = subject === 'business' ? 'Logo del negocio' : 'Foto de tu cuenta';
  const controlsDisabled = busy || disabled;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'P';

  async function persist(file?: File) {
    if (running.current || disabled) return;
    const identityAtStart = identity;
    running.current = true;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      if (file) { pending.current = await prepareProfileImage(file); removing.current = null; }
      if (!pending.current) return;
      const updated = await sendProfileImage(access, subject, pending.current);
      if (!mounted.current || currentIdentity.current !== identityAtStart) return;
      pending.current = null; setHasPending(false); onSaved(updated);
    } catch (caught) {
      if (!mounted.current || currentIdentity.current !== identityAtStart) return;
      setHasPending(Boolean(pending.current));
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar la imagen. Intenta de nuevo.');
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
    } finally {
      running.current = false;
      if (mounted.current && currentIdentity.current === identityAtStart) { setBusy(false); onBusyChange?.(false); }
    }
  }
  async function remove() {
    if (running.current || disabled) return;
    const identityAtStart = identity;
    running.current = true; setBusy(true); onBusyChange?.(true); setError('');
    removing.current ??= crypto.randomUUID();
    try {
      const result = await accountRequest({ action: 'remove_profile_image', ...access, subject, operationId: removing.current });
      if (!mounted.current || currentIdentity.current !== identityAtStart) return;
      removing.current = null; pending.current = null; setHasPending(false); onSaved(result.business);
    } catch (caught) {
      if (!mounted.current || currentIdentity.current !== identityAtStart) return;
      setError(caught instanceof Error ? caught.message : 'No pudimos quitar la imagen. Intenta de nuevo.');
      if (caught instanceof AccountClientError && accessErrorCodes.includes(caught.code)) onSessionError?.(caught);
    } finally {
      running.current = false;
      if (mounted.current && currentIdentity.current === identityAtStart) { setBusy(false); onBusyChange?.(false); }
    }
  }
  return <div>
    <div className="profile-image-editor" aria-busy={busy}>
      <div className={`profile-image-preview ${subject}`}>
        {image ? <img src={image} alt={label} /> : <span aria-hidden="true">{initials}</span>}
      </div>
      <div className="profile-image-actions">
        <strong>{label}</strong>
        <div className="profile-image-buttons">
          <label className={`profile-image-upload${controlsDisabled ? ' disabled' : ''}`}>
            {busy ? <PendingIndicator label="Guardando imagen" /> : <ImagePlus size={18} aria-hidden="true" />}
            <span>{image ? 'Cambiar imagen' : 'Añadir imagen'}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" aria-label={image ? `Cambiar ${label.toLowerCase()}` : `Añadir ${label.toLowerCase()}`} disabled={controlsDisabled || hasPending} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void persist(file); }} />
          </label>
          {image && <button className="profile-image-remove" type="button" disabled={controlsDisabled || hasPending} onClick={() => void remove()}>Quitar</button>}
          {hasPending && <button className="profile-image-remove" type="button" disabled={controlsDisabled} onClick={() => void persist()}>Reintentar</button>}
        </div>
      </div>
    </div>
    {error && <p className="mb-6 text-sm text-danger" role="alert">{error}</p>}
  </div>;
}

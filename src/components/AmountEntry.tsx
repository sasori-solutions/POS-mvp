import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Delete, Plus } from 'lucide-react';
import { money } from '../lib/pos';
import { amountKey, maxAmountConceptLength, parseAmountCents } from '../lib/importe';
import { PosDialog } from './PosShared';
import './amount-entry.css';

const compactAmountQuery = '(width < 47.5rem) and (height < 700px)';

export default function AmountEntry({ disabled = false, error: externalError = '', onAdd, onCancel }: {
  disabled?: boolean;
  error?: string;
  onAdd: (amountCents: number, name: string) => boolean | Promise<boolean>;
  onCancel: () => void;
}) {
  const [input, setInput] = useState('');
  const [name, setName] = useState('');
  const [conceptOpen, setConceptOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [compact, setCompact] = useState(() => window.matchMedia?.(compactAmountQuery).matches ?? false);
  const amountInput = useRef<HTMLInputElement>(null);
  const conceptInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const cents = parseAmountCents(input);
  const locked = disabled || submitting;
  const invalid = Boolean(input) && cents === null && !/^0*(?:[.,]0{0,2})?$/.test(input);
  useEffect(() => {
    const media = window.matchMedia?.(compactAmountQuery);
    if (!media) return;
    const changed = () => setCompact(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!compact) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [compact]);
  async function add() {
    if (locked || cents === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      if (await onAdd(cents, name.trim())) {
        setInput('');
        setName('');
        setConceptOpen(false);
        if (compact) onCancel();
        else amountInput.current?.focus();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos añadir el importe. Reintenta.'); }
    finally { inFlight.current = false; setSubmitting(false); }
  }
  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (locked || event.target === conceptInput.current || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
    if (event.key === 'Enter' && event.target === amountInput.current) { event.preventDefault(); void add(); return; }
    if (event.target === amountInput.current) return;
    if (/^\d$/.test(event.key) || ['.', ',', 'Backspace', 'Delete'].includes(event.key)) {
      event.preventDefault();
      setInput(value => amountKey(value, event.key === 'Backspace' ? 'backspace' : event.key === 'Delete' ? 'clear' : event.key));
    }
  }
  const calculator = <div className={`amount-entry mx-auto flex w-full max-w-92 flex-col gap-3 py-2 ${compact ? 'amount-entry-compact' : ''}`} onKeyDown={keydown}>
    {compact && <div className="flex min-h-12 shrink-0 items-center justify-between"><strong className="text-xl font-medium">Importe</strong><button type="button" className="min-h-12 px-3 text-sm text-muted" disabled={locked} onClick={onCancel} data-dialog-autofocus>Cancelar</button></div>}
    <div className="amount-entry-body flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain">
    <label className="flex flex-col gap-2"><span className="text-sm text-muted">Importe · MXN</span>
      <span className="flex items-center gap-2 border-b border-line pb-3 text-[40px] leading-tight tabular-nums"><span aria-hidden="true">$</span><input ref={amountInput} aria-label="Importe" aria-invalid={invalid || undefined} aria-describedby={invalid ? 'amount-entry-help' : undefined} className="min-h-12 min-w-0 flex-1 border-0 bg-transparent text-right text-ink" inputMode="none" autoComplete="off" value={input} placeholder="0.00" disabled={locked} onChange={event => setInput(event.target.value)} /></span>
    </label>
    {invalid && <p id="amount-entry-help" className="text-sm text-danger" role="alert">Ingresa hasta $999,999.99, con un máximo de dos decimales.</p>}
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="Teclado de importe">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'backspace'].map(key => <button type="button" key={key} className="grid min-h-12 place-items-center rounded-lg bg-surface text-2xl text-ink enabled:hover:bg-line" disabled={locked} aria-label={key === 'backspace' ? 'Borrar último dígito' : key === '.' ? 'Punto decimal' : key} onClick={() => setInput(value => amountKey(value, key))}>{key === 'backspace' ? <Delete size={23} aria-hidden="true" /> : key}</button>)}
    </div>
    <div className="flex gap-3"><button type="button" className="min-h-12 flex-1 text-sm text-muted disabled:opacity-50" disabled={locked || !input} onClick={() => setInput('')}>Borrar importe</button>{!compact && <button type="button" className="min-h-12 flex-1 text-sm text-muted" disabled={locked} onClick={onCancel}>Cancelar</button>}</div>
    {conceptOpen ? <label className="flex flex-col gap-1 text-sm text-muted">Concepto (opcional)<input ref={conceptInput} className="min-h-12 rounded-lg border border-line bg-white px-3 text-base text-ink" maxLength={maxAmountConceptLength} value={name} disabled={locked} onChange={event => setName(event.target.value)} placeholder="Importe libre" /></label> : <button type="button" className="flex min-h-12 items-center justify-center gap-2 text-sm text-muted" disabled={locked} aria-expanded={false} onClick={() => setConceptOpen(true)}><Plus size={17} aria-hidden="true" />Añadir concepto</button>}
    {(externalError || error) && <p className="text-sm text-danger" role="alert">{externalError || error}</p>}
    </div>
    <button type="button" className="pos-button pos-primary min-h-14 shrink-0" disabled={locked || cents === null} aria-busy={submitting} onClick={() => void add()}>Añadir {money(cents ?? 0)}</button>
  </div>;
  return compact ? <PosDialog title="Importe" className="amount-entry-dialog" busy={locked} onClose={onCancel}>{calculator}</PosDialog> : calculator;
}

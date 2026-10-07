import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { PublicMenuDocument, PublicMenuProduct } from '../lib/menu-contracts';
import { fetchPublicMenu } from '../lib/menu-client';
import { scheduleLabel } from '../lib/menu-schedule';
import { money } from '../lib/format';
import './public-menu.css';

function priceLabel(product: PublicMenuProduct): string {
  if (product.variablePrice) return 'Consultar precio';
  if (!product.variations.length) return money(product.priceCents);
  const available = product.variations.filter(variation => !variation.soldOut);
  const sizes = available.length ? available : product.variations;
  return `Desde ${money(Math.min(...sizes.map(variation => variation.priceCents)))}`;
}

export default function PublicMenu({ menuId }: { menuId: string }) {
  const [menu, setMenu] = useState<PublicMenuDocument | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [category, setCategory] = useState(''), [refresh, setRefresh] = useState(0); const sequence = useRef(0);
  useEffect(() => {
    let alive = true; let controller: AbortController | undefined;
    const read = async () => {
      if (document.visibilityState === 'hidden') return;
      const ticket = ++sequence.current; controller?.abort(); controller = new AbortController(); setLoading(true);
      try { const result = await fetchPublicMenu(menuId, controller.signal); if (alive && ticket === sequence.current) { setMenu(result); setCategory(current => result.products.some(product => product.category === current) ? current : ''); setError(''); } }
      catch (caught) { if (alive && ticket === sequence.current) { setMenu(null); setError(caught instanceof Error ? caught.message : 'No pudimos consultar el menú.'); } }
      finally { if (alive && ticket === sequence.current) setLoading(false); }
    };
    setMenu(null); setError(''); setCategory(''); void read();
    const interval = window.setInterval(() => { void read(); }, 45000);
    const onVisible = () => { if (document.visibilityState === 'visible') void read(); }; document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; sequence.current++; controller?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); };
  }, [menuId, refresh]);
  const categories = [...new Set(menu?.products.map(product => product.category).filter(Boolean) ?? [])];
  return <main className="public-menu-page">
    <header className="public-menu-header"><p className="public-menu-business">{menu?.businessName ?? 'Menú'}</p><h1>{menu?.name ?? 'Consulta el menú'}</h1>{menu?.locationLabel && <p>{menu.locationLabel}</p>}
      <button type="button" className="pos-button pos-secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={18} aria-hidden="true" />{loading ? 'Consultando…' : 'Actualizar menú'}</button>
    </header>
    {error && <p className="public-menu-message" role="alert">{error}</p>}
    {loading && !menu && !error && <p role="status">Consultando precios y disponibilidad…</p>}
    {menu && <>
      <p className="public-menu-caption">Menú informativo. Pide y paga con el personal del local.</p>
      {menu.availability === 'outside_hours' ? <section className="public-menu-message"><h2>Este menú está fuera de horario</h2><p>Horario del local ({menu.timezone}):</p><ul>{menu.schedules.map((schedule, index) => <li key={index}>{scheduleLabel(schedule)}</li>)}</ul></section> : <>
        {categories.length > 1 && <nav className="public-menu-categories" aria-label="Categorías"><button type="button" aria-pressed={!category} onClick={() => setCategory('')}>Todo</button>{categories.map(name => <button type="button" key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{name}</button>)}</nav>}
        {!menu.products.length && <p className="public-menu-message">El local está actualizando los productos de este menú.</p>}
        <div className="public-menu-products">{menu.products.filter(product => !category || product.category === category).map(product => <article key={product.id} className="public-menu-product">
          {product.image && <img src={product.image} alt="" loading="lazy" decoding="async" />}
          <div className="public-menu-product-body"><div className="public-menu-product-heading"><h2>{product.name}</h2><strong>{priceLabel(product)}</strong></div>
            {!product.available && <span className="public-menu-sold-out">Agotado</span>}{product.description && <p>{product.description}</p>}
            {product.variations.length > 0 && <ul className="public-menu-options" aria-label={`Tamaños de ${product.name}`}>{product.variations.map(variation => <li key={variation.id}>{variation.name} · {money(variation.priceCents)}{variation.soldOut ? ' · Agotado' : ''}</li>)}</ul>}
            {product.comboComponents.length > 0 && <p className="public-menu-caption">Incluye: {product.comboComponents.map(item => `${item.quantity} × ${item.name}${item.selectionLabel ? ` (${item.selectionLabel})` : ''}`).join(', ')}</p>}
            {product.modifierGroups.length > 0 && <details className="public-menu-extras"><summary>Opciones y extras</summary>{product.modifierGroups.map(group => <div key={group.id}><h3>{group.name}{group.parentOptionId ? ` · al elegir ${product.modifierGroups.flatMap(parent => parent.options).find(option => option.id === group.parentOptionId)?.name ?? 'su opción principal'}` : ''}</h3><ul>{group.options.map(option => <li key={option.id}>{option.name}{option.priceCents ? ` · ${option.priceCents > 0 ? '+' : '−'}${money(Math.abs(option.priceCents))}` : ''}{option.soldOut ? ' · Agotado' : ''}{option.maxQuantity > 1 ? ` · hasta ${option.maxQuantity}` : ''}</li>)}</ul></div>)}</details>}
            {product.dietary && <p className="public-menu-caption">{product.dietary}</p>}{product.allergens && <p className="public-menu-caption">Alérgenos: {product.allergens}</p>}
          </div>
        </article>)}</div>
      </>}
    </>}
  </main>;
}

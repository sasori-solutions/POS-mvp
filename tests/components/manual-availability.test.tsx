// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import ProductSelection from '../../src/components/ProductSelection'
import { emptyDetails } from '../../src/lib/product-details'
import type { Product } from '../../src/lib/pos-contracts'

const product: Product = { id:'synthetic-product', name:'Café', category:'', priceCents:1000, active:true, version:1,
  details:{...emptyDetails(),trackStock:true,stock:0} }

const originalShowModal = HTMLDialogElement.prototype.showModal
const originalClose = HTMLDialogElement.prototype.close
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open','') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(cleanup)
afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal
  HTMLDialogElement.prototype.close = originalClose
})

test('a product with zero historical stock can be selected while manually available', () => {
  const onAdd = vi.fn()
  render(<ProductSelection product={product} onClose={vi.fn()} onAdd={onAdd} />)
  const add = screen.getByRole('button',{name:/Agregar/}) as HTMLButtonElement
  expect(add.disabled).toBe(false)
  fireEvent.click(add)
  expect(onAdd).toHaveBeenCalledOnce()
})

test('a selected size becoming unavailable disables adding even when another size is available', () => {
  const variations = [
    {id:'small',name:'Chico',priceCents:1000,sku:'',barcode:'',soldOut:false},
    {id:'large',name:'Grande',priceCents:1500,sku:'',barcode:'',soldOut:false},
  ]
  const onAdd = vi.fn(), onClose = vi.fn()
  const {rerender} = render(<ProductSelection product={{...product,details:{...product.details!,variations}}} onClose={onClose} onAdd={onAdd} />)
  rerender(<ProductSelection product={{...product,details:{...product.details!,variations:variations.map(v=>({...v,soldOut:v.id==='small'}))}}} onClose={onClose} onAdd={onAdd} />)
  expect((screen.getByRole('button',{name:/Agregar/}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio',{name:/Grande/}))
  expect((screen.getByRole('button',{name:/Agregar/}) as HTMLButtonElement).disabled).toBe(false)
  rerender(<ProductSelection product={{...product,details:{...product.details!,soldOut:true,variations}}} onClose={onClose} onAdd={onAdd} />)
  expect((screen.getByRole('button',{name:/Agregar/}) as HTMLButtonElement).disabled).toBe(true)
  expect(onAdd).not.toHaveBeenCalled()
})

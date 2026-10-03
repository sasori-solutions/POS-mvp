import { NumericFormat } from 'react-number-format'
import type { InputHTMLAttributes } from 'react'

export default function MoneyInput({ value, onValueChange, maxCents = 99_999_999, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'defaultValue'> & { value: string; onValueChange: (value: string) => void; maxCents?: number }) {
  const withinLimit = (text: string) => {
    const digits = text.match(/^(\d*)(?:\.(\d{0,2}))?$/)
    return Boolean(digits && Number(digits[1]) * 100 + Number((digits[2] ?? '').padEnd(2, '0')) <= maxCents)
  }
  return <NumericFormat {...props} onPaste={event => {
    const text = event.clipboardData.getData('text').trim()
    if (/^\d{1,8},\d{1,2}$/.test(text) && withinLimit(text.replace(',', '.'))) { event.preventDefault(); onValueChange(text.replace(',', '.')) }
  }} value={value} valueIsNumericString onValueChange={values => onValueChange(values.value)}
    thousandSeparator="," decimalSeparator="." allowedDecimalSeparators={['.', ',']} decimalScale={2} fixedDecimalScale
    allowNegative={false} prefix="$" inputMode="decimal" isAllowed={values => values.value === '' || withinLimit(values.value)} />
}

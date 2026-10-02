import { NumericFormat } from 'react-number-format'
import type { InputHTMLAttributes } from 'react'

export default function MoneyInput({ value, onValueChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'defaultValue'> & { value: string; onValueChange: (value: string) => void }) {
  return <NumericFormat {...props} onPaste={event => {
    const text = event.clipboardData.getData('text').trim()
    if (/^\d{1,6},\d{1,2}$/.test(text)) { event.preventDefault(); onValueChange(text.replace(',', '.')) }
  }} value={value} valueIsNumericString onValueChange={values => onValueChange(values.value)}
    thousandSeparator="," decimalSeparator="." allowedDecimalSeparators={['.', ',']} decimalScale={2} fixedDecimalScale
    allowNegative={false} prefix="$" inputMode="decimal" isAllowed={values => values.value === '' || Number(values.value) <= 999999.99} />
}

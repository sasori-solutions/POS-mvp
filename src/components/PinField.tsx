export default function PinField({
  label,
  value,
  onChange,
  confirm = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  confirm?: boolean;
  disabled?: boolean;
}) {
  const id = confirm ? "pin-confirm-input" : "pin-input";
  return (
    <div className="field pin-field">
      <label htmlFor={id}>{label}</label>
      <div className="pin-control relative h-14.5 rounded-lg focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-brand max-compact:h-13.5">
        <input
          id={id}
          data-testid={id}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="off"
          value={value}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value.replace(/\D/g, "").slice(0, 6))
          }
          aria-describedby="pin-help"
        />
        <div
          className="pin-slots grid h-full grid-cols-6 gap-2 max-compact:gap-1.5"
          aria-hidden="true"
        >
          {Array.from({ length: 6 }, (_, index) => (
            <span
              key={index}
              className={
                value.length > index
                  ? "filled"
                  : value.length === index
                    ? "current"
                    : ""
              }
            >
              {value.length > index ? "●" : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

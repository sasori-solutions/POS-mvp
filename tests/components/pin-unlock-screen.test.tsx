// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import PinUnlockScreen from "../../src/components/PinUnlockScreen";

afterEach(cleanup);

function fixture(overrides: Partial<Parameters<typeof PinUnlockScreen>[0]> = {}) {
  return {
    businessName: "Cafetería de prueba",
    busy: false,
    error: "",
    secondsLeft: 0,
    onUnlock: vi.fn(async () => {}),
    onRecover: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
}

function typeDigits(digits: string) {
  for (const digit of digits) fireEvent.click(screen.getByRole("button", { name: digit, exact: true }));
}

test("submits only at six digits and preserves leading zeroes", async () => {
  const props = fixture();
  render(<PinUnlockScreen {...props} />);
  typeDigits("00123");
  expect(props.onUnlock).not.toHaveBeenCalled();
  await act(async () => typeDigits("4"));
  expect(props.onUnlock).toHaveBeenCalledExactlyOnceWith("001234");
});

test("physical keyboard input and paste use the same automatic submission", async () => {
  const props = fixture();
  render(<PinUnlockScreen {...props} />);
  const input = screen.getByLabelText("PIN de 6 dígitos");
  expect(document.activeElement).toBe(input);
  await act(async () => fireEvent.change(input, { target: { value: "a0 12345" } }));
  expect(props.onUnlock).toHaveBeenCalledExactlyOnceWith("012345");
});

test("backspace corrects a partial PIN before submitting", async () => {
  const props = fixture();
  render(<PinUnlockScreen {...props} />);
  typeDigits("1239");
  fireEvent.click(screen.getByRole("button", { name: "Borrar último dígito" }));
  await act(async () => typeDigits("456"));
  expect(props.onUnlock).toHaveBeenCalledExactlyOnceWith("123456");
});

test("rapid extra events cannot duplicate a pending attempt; an unsuccessful attempt clears the PIN", async () => {
  let finish!: () => void;
  const props = fixture({ onUnlock: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
  const view = render(<PinUnlockScreen {...props} />);
  typeDigits("123456");
  typeDigits("123456");
  fireEvent.change(screen.getByLabelText("PIN de 6 dígitos"), { target: { value: "123456" } });
  expect(props.onUnlock).toHaveBeenCalledExactlyOnceWith("123456");
  view.rerender(<PinUnlockScreen {...props} error="PIN incorrecto." />);
  await act(async () => finish());
  expect((screen.getByLabelText("PIN de 6 dígitos") as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("alert").textContent).toBe("PIN incorrecto.");
  expect(props.onUnlock).toHaveBeenCalledTimes(1);
  typeDigits("654321");
  expect(props.onUnlock).toHaveBeenLastCalledWith("654321");
  expect(props.onUnlock).toHaveBeenCalledTimes(2);
  await act(async () => finish());
});

test("a server cooldown blocks the keypad and typed input until it ends", async () => {
  const props = fixture({ secondsLeft: 60 });
  const view = render(<PinUnlockScreen {...props} />);
  typeDigits("123456");
  fireEvent.change(screen.getByLabelText("PIN de 6 dígitos"), { target: { value: "123456" } });
  expect(props.onUnlock).not.toHaveBeenCalled();
  expect(screen.getByRole("timer").textContent).toContain("1:00");
  view.rerender(<PinUnlockScreen {...props} secondsLeft={0} />);
  await act(async () => typeDigits("123456"));
  expect(props.onUnlock).toHaveBeenCalledExactlyOnceWith("123456");
});

test("recovery, logout and business switching remain accessible while locked", () => {
  const props = fixture({ onChangeBusiness: vi.fn() });
  render(<PinUnlockScreen {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Olvidé mi PIN" }));
  fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
  fireEvent.click(screen.getByRole("button", { name: "Cambiar negocio" }));
  expect(props.onRecover).toHaveBeenCalledOnce();
  expect(props.onLogout).toHaveBeenCalledOnce();
  expect(props.onChangeBusiness).toHaveBeenCalledOnce();
  expect(props.onUnlock).not.toHaveBeenCalled();
});

import { type RefObject, useRef, useState } from "react";

export type Errors = Record<string, string | undefined>;

/**
 * Per-field validation on submit: errors go to the fields, the submit stops and focus
 * moves to the first invalid field. An error disappears as soon as the value is fixed.
 */
export function useFormErrors<T extends Errors = Errors>() {
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Partial<T>>({});

  function check(next: Partial<T>): boolean {
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Partial<T>;
    setErrors(clean);
    if (Object.keys(clean).length === 0) return true;
    focusFirstInvalid(form);
    return false;
  }

  function clear(key: keyof T) {
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));
  }

  return { form, errors, check, clear };
}

export function focusFirstInvalid(form: RefObject<HTMLElement | null>) {
  requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

export const isHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

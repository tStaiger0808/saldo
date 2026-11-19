import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/react.tsx";
import { matchOptions, searchIndex } from "../lib/combobox.ts";
import type { FieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";

export type ComboboxOption = { value: string; label: string };

const ANNOUNCE_DELAY_MS = 500;
const GAP = 4;
const EDGE = 8;

/**
 * Text field with a filtered list of options (WAI-ARIA 1.2 combobox with list autocomplete and automatic selection),
 * for lists too long for a select. Only choosing an option sets the value; typing clears it again.
 */
export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder,
  limit = 50,
  disabled = false,
  ...control
}: FieldControl & {
  label: string;
  options: readonly ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  limit?: number;
  disabled?: boolean;
}) {
  const t = useT();
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState("");
  const index = useMemo(() => searchIndex(options, (option) => option.label), [options]);
  // While the field shows the chosen option, the list offers all options again.
  const filter = selected && query === selected.label ? "" : query;
  const { items, total } = useMemo(() => matchOptions(index, filter, limit), [index, filter, limit]);
  const activeIndex = Math.min(active, items.length - 1);
  const expanded = open && items.length > 0;
  const optionId = (i: number) => `${listId}-${i}`;
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);

  // Fixed positioning lays the list over the dialog instead of growing it, so buttons below do not move under the pointer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list's height changes with its items.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = input.current?.getBoundingClientRect();
      const node = popup.current;
      if (!anchor || !node) return;
      // The list shrinks to the previous limit, so measure its natural height without one.
      node.style.maxHeight = "none";
      const below = window.innerHeight - anchor.bottom - GAP - EDGE;
      const above = anchor.top - GAP - EDGE;
      const height = Math.min(node.scrollHeight, Math.max(below, above));
      node.style.maxHeight = `${height}px`;
      node.style.top = `${height <= below || below >= above ? anchor.bottom + GAP : anchor.top - GAP - height}px`;
      node.style.left = `${anchor.left}px`;
      node.style.width = `${anchor.width}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, items, total]);

  useEffect(() => {
    if (selected) setQuery(selected.label);
  }, [selected]);

  useEffect(() => {
    if (expanded && activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  });

  useEffect(() => {
    if (!open) {
      setAnnouncement("");
      return;
    }
    const text =
      total === 0
        ? t("common.combobox.noMatches")
        : total > items.length
          ? t("common.combobox.matchesLimited", { count: total, shown: items.length })
          : t("common.combobox.matches", { count: total });
    const timer = setTimeout(() => setAnnouncement(text), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, total, items.length, t]);

  function openList(at: number) {
    setOpen(true);
    setActive(at);
  }

  function choose(option: ComboboxOption) {
    setQuery(option.label);
    setOpen(false);
    setActive(-1);
    if (option.value !== value) onChange(option.value);
  }

  function selectedIndex() {
    return Math.max(
      0,
      items.findIndex((option) => option.value === value),
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const last = items.length - 1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!expanded) openList(event.altKey ? -1 : selectedIndex());
        else setActive(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!expanded) openList(last);
        else setActive(activeIndex <= 0 ? last : activeIndex - 1);
        break;
      case "Home":
      case "End":
        if (!expanded) return;
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : last);
        break;
      case "Enter": {
        if (!open) return;
        event.preventDefault();
        const option = items[activeIndex];
        if (option) choose(option);
        else setOpen(false);
        break;
      }
      case "Escape":
        // Handled here, the surrounding dialog would close on Escape otherwise.
        if (open) {
          event.preventDefault();
          setOpen(false);
        } else if (query || value) {
          event.preventDefault();
          setQuery("");
          if (value) onChange("");
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  function onBlur() {
    setOpen(false);
    if (value || !query.trim()) return;
    const exact = items.filter((option) => option.label.localeCompare(query.trim(), undefined, { sensitivity: "base" }) === 0);
    if (exact.length === 1 && exact[0]) choose(exact[0]);
  }

  return (
    <div className="combobox">
      <input
        {...control}
        ref={input}
        type="text"
        role="combobox"
        className="combobox-input"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        spellCheck={false}
        placeholder={placeholder}
        disabled={disabled}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          openList(0);
          if (value) onChange("");
        }}
        onClick={() => {
          if (!open) openList(selectedIndex());
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <div ref={popup} className="combobox-popup" hidden={!open}>
        {/* Pressing an option must not move focus out of the field, or the list would close before the click lands. */}
        <div id={listId} role="listbox" aria-label={label} hidden={!expanded} onMouseDown={(event) => event.preventDefault()}>
          {items.map((option, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: options are chosen from the keyboard through the combobox field (aria-activedescendant), focus stays there.
            <div
              key={option.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              data-chosen={option.value === value || undefined}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" size={16} />}
            </div>
          ))}
        </div>
        {open && total === 0 && <p className="combobox-note">{t("common.combobox.noMatches")}</p>}
        {expanded && total > items.length && <p className="combobox-note">{t("common.combobox.more", { count: total - items.length })}</p>}
      </div>
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

import { type KeyboardEvent, useId, useState } from "react";
import { useT } from "../i18n/react.tsx";
import {
  capture,
  findConflict,
  type Problem,
  resetAllBindings,
  SHORTCUTS,
  type ShortcutId,
  type Slot,
  setBinding,
  setSingleKeysEnabled,
} from "../lib/shortcuts.ts";
import { FormDialog } from "./Dialog.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { GROUPS, Keys, SHORTCUT_LABELS, useKeyText } from "./Shortcuts.tsx";

type Proposal = { value: string; other: ShortcutId };
type Edit = { slot: Slot; id: ShortcutId; proposal?: Proposal };

const SLOTS = ["combo", "single"] as const;

/**
 * Personal shortcut settings: the single-key switch and a table of every action with its keys. "Ändern" records the
 * next key press in a dialog; keys another action has are offered for a swap. Everything is stored in this browser.
 */
export function ShortcutSettings() {
  const t = useT();
  const { keyboard, comboOf, singleOf } = useKeyText();
  const [edits, setEdits] = useState<Edit[]>([]);
  const [status, setStatus] = useState("");
  const titleId = useId();
  const singleTitleId = useId();
  const singleHintId = useId();
  const label = (id: ShortcutId) => t(SHORTCUT_LABELS[id]);
  const changed = (id: ShortcutId) => SLOTS.some((slot) => keyboard.bindings[slot][id] !== keyboard.defaults[slot][id]);

  function reset(id: ShortcutId) {
    const conflicts: Edit[] = [];
    for (const slot of SLOTS) {
      const value = keyboard.defaults[slot][id];
      if (keyboard.bindings[slot][id] === value) continue;
      const other = value ? findConflict(keyboard.bindings, slot, value, id) : null;
      if (value && other) conflicts.push({ slot, id, proposal: { value, other } });
      else setBinding(slot, id, value);
    }
    if (conflicts.length > 0) setEdits(conflicts);
    else setStatus(t("shortcuts.settings.resetDone", { action: label(id) }));
  }

  function done(message?: string) {
    setEdits((queue) => queue.slice(1));
    if (message) setStatus(message);
  }

  const edit = edits[0];
  return (
    <section className="card shortcut-settings" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("sections.personal.tastenkuerzel.label")}</h2>
      <p className="muted">{t("shortcuts.settings.intro")}</p>

      <section className="stack-sm" aria-labelledby={singleTitleId}>
        <h3 id={singleTitleId}>{t("shortcuts.singleKeysTitle")}</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={keyboard.singleKeys}
            aria-describedby={singleHintId}
            onChange={(event) => setSingleKeysEnabled(event.target.checked)}
          />
          {t("shortcuts.singleKeysLabel")}
        </label>
        <p id={singleHintId} className="muted small">
          {t("shortcuts.singleKeysHint")}
        </p>
      </section>

      {GROUPS.map((group) => (
        <table key={group} className="data-table shortcut-table shortcut-settings-table">
          <caption>{t(`shortcuts.groups.${group}`)}</caption>
          <thead>
            <tr>
              <th scope="col">{t("shortcuts.action")}</th>
              <th scope="col">{t("shortcuts.keys")}</th>
              {keyboard.singleKeys && <th scope="col">{t("shortcuts.single")}</th>}
              <th scope="col">
                <span className="visually-hidden">{t("shortcuts.settings.reset")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.filter((s) => s.group === group).map((s) => (
              <tr key={s.id}>
                <th scope="row">{label(s.id)}</th>
                <td>
                  <span className="shortcut-cell">
                    <span className="cell-label" aria-hidden="true">
                      {t("shortcuts.keys")}
                    </span>
                    <Keys>{comboOf(s.id)}</Keys>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-haspopup="dialog"
                      aria-label={t("shortcuts.settings.changeCombo", { action: label(s.id) })}
                      onClick={() => setEdits([{ slot: "combo", id: s.id }])}
                    >
                      {t("shortcuts.settings.change")}
                    </button>
                  </span>
                </td>
                {keyboard.singleKeys && (
                  <td>
                    <span className="shortcut-cell">
                      <span className="cell-label" aria-hidden="true">
                        {t("shortcuts.single")}
                      </span>
                      <Keys>{singleOf(s.id)}</Keys>
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-haspopup="dialog"
                        aria-label={t("shortcuts.settings.changeSingle", { action: label(s.id) })}
                        onClick={() => setEdits([{ slot: "single", id: s.id }])}
                      >
                        {t("shortcuts.settings.change")}
                      </button>
                    </span>
                  </td>
                )}
                <td className="row-actions">
                  {changed(s.id) && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-label={t("shortcuts.settings.resetOne", { action: label(s.id) })}
                      onClick={() => reset(s.id)}
                    >
                      <Icon name="undo" size={16} /> {t("shortcuts.settings.reset")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            resetAllBindings();
            setStatus(t("shortcuts.settings.resetAllDone"));
          }}
        >
          <Icon name="undo" size={18} /> {t("shortcuts.settings.resetAll")}
        </button>
      </div>
      <p role="status" className="small muted">
        {status}
      </p>
      {edit && <CaptureDialog key={`${edit.slot}:${edit.id}:${edits.length}`} edit={edit} onDone={done} />}
    </section>
  );
}

/**
 * Records new keys for one slot of one action. Focus stays in a read-only field that takes the key presses, so a
 * screen reader passes them on; Esc closes, Backspace removes the keys, Tab moves on to the buttons.
 */
function CaptureDialog({ edit, onDone }: { edit: Edit; onDone: (message?: string) => void }) {
  const t = useT();
  const { keyboard, combo, single, pressed: formatPressed } = useKeyText();
  const { slot, id } = edit;
  const action = t(SHORTCUT_LABELS[id]);
  const current = keyboard.bindings[slot][id];
  const show = (value: string | null) => (slot === "combo" ? combo(value) : single(value));
  const [pending, setPending] = useState<Proposal | null>(edit.proposal ?? null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [shown, setShown] = useState<string | null>(edit.proposal ? show(edit.proposal.value) : null);
  const messageId = useId();
  const modifiers = t(keyboard.mac ? "shortcuts.capture.modifiersMac" : "shortcuts.capture.modifiersOther");

  function commit(value: string | null, swapWith?: ShortcutId) {
    setBinding(slot, id, value, swapWith);
    if (value !== null) onDone(t("shortcuts.settings.saved", { action, keys: show(value) ?? "" }));
    else onDone(t(slot === "combo" ? "shortcuts.settings.removedCombo" : "shortcuts.settings.removedSingle", { action }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const result = capture(event.nativeEvent, slot, keyboard.mac);
    if (result.kind === "ignore" || result.kind === "cancel" || result.kind === "move") return;
    event.preventDefault();
    if (result.kind === "clear") return commit(null);
    if (result.kind === "problem") {
      setPending(null);
      setProblem(result.problem);
      setShown(formatPressed(result.pressed));
      return;
    }
    if (result.value === current) return onDone();
    const other = findConflict(keyboard.bindings, slot, result.value, id);
    if (!other) return commit(result.value);
    setProblem(null);
    setPending({ value: result.value, other });
    setShown(show(result.value));
  }

  const previous = show(current);
  const message = pending
    ? previous
      ? t("shortcuts.capture.conflict", { keys: show(pending.value) ?? "", other: t(SHORTCUT_LABELS[pending.other]), previous })
      : t("shortcuts.capture.conflictNone", { keys: show(pending.value) ?? "", other: t(SHORTCUT_LABELS[pending.other]) })
    : problem
      ? t(`shortcuts.capture.problems.${problem}`, { modifiers })
      : "";

  return (
    <FormDialog
      title={t(slot === "combo" ? "shortcuts.capture.titleCombo" : "shortcuts.capture.titleSingle", { action })}
      onClose={() => onDone()}
      dismissible
      className="capture-dialog"
      footer={
        <>
          {current !== null && (
            <button type="button" className="btn" onClick={() => commit(null)}>
              {t("shortcuts.capture.remove")}
            </button>
          )}
          <button type="button" className="btn" onClick={() => onDone()}>
            {t("common.cancel")}
          </button>
          {pending && (
            <button type="button" className="btn btn-primary" onClick={() => commit(pending.value, pending.other)}>
              {t("shortcuts.capture.swap")}
            </button>
          )}
        </>
      }
    >
      <div className="stack">
        <Field
          label={t(slot === "combo" ? "shortcuts.capture.fieldCombo" : "shortcuts.capture.fieldSingle")}
          hint={slot === "combo" ? t("shortcuts.capture.instructionsCombo", { modifiers }) : t("shortcuts.capture.instructionsSingle")}
        >
          {(control) => (
            <input
              {...control}
              aria-describedby={`${control["aria-describedby"]} ${messageId}`}
              type="text"
              readOnly
              className="capture-field"
              value={shown ?? previous ?? ""}
              placeholder={t("shortcuts.none")}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              spellCheck={false}
              onKeyDown={onKeyDown}
            />
          )}
        </Field>
        <div id={messageId} aria-live="assertive" aria-atomic="true">
          {message && <p className={pending ? "capture-message warning" : "capture-message field-error"}>{message}</p>}
        </div>
      </div>
    </FormDialog>
  );
}

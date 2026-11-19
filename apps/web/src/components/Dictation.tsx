import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { INTL_LOCALES } from "../i18n/index.ts";
import { useLocale, useT } from "../i18n/react.tsx";
import { Dictation, type DictationState, type RecognitionFactory, recognitionFactory } from "../lib/dictation.ts";
import { Icon } from "./Icon.tsx";
import { Banner } from "./Status.tsx";

const HINT_KEY = "fw-diktat-hinweis";
const ENDED_MS = 3_000;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts as long as the page.
  }
}

/** The browser's speech recognition, known only after the first render so server and client render alike. */
function useRecognition(): RecognitionFactory | null {
  const [factory, setFactory] = useState<RecognitionFactory | null>(null);
  useEffect(() => setFactory(() => recognitionFactory(window as never)), []);
  return factory;
}

type Layout = (parts: { mic: ReactNode; notices: ReactNode }) => ReactNode;

/**
 * Mic button for a text field: hold (pointer, or Space while focused) to talk, tap to start and stop. What is said
 * appears in the field as it is recognized (or once at the end where the browser gives no interim results) and stays
 * editable; sending stays with the person. `children` places the button and the notices; both are null where the
 * browser has no speech recognition.
 */
export function DictationControls({
  text,
  disabled,
  onText,
  children,
}: {
  text: string;
  disabled: boolean;
  onText: (text: string) => void;
  children: Layout;
}) {
  const factory = useRecognition();
  if (!factory) return children({ mic: null, notices: null });
  return <Controls factory={factory} text={text} disabled={disabled} onText={onText} layout={children} />;
}

function Controls({
  factory,
  text,
  disabled,
  onText,
  layout,
}: {
  factory: RecognitionFactory;
  text: string;
  disabled: boolean;
  onText: (text: string) => void;
  layout: Layout;
}) {
  const t = useT();
  const locale = useLocale();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const hintButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<DictationState>({ listening: false, mode: null, text: "", error: null });
  const [ended, setEnded] = useState(false);
  const [hintSeen, setHintSeen] = useState(true);
  const [hintOpen, setHintOpen] = useState(false);
  const latest = useRef({ text, onText });
  latest.current = { text, onText };
  const keyboardPress = useRef(false);

  const [dictation] = useState(
    () =>
      new Dictation(factory, {
        lang: INTL_LOCALES[locale],
        onChange: (next) => {
          setState(next);
          if (next.listening || next.text !== latest.current.text) latest.current.onText(next.text);
        },
      }),
  );

  useEffect(() => {
    setHintSeen(stored(HINT_KEY) === "1");
  }, []);

  const wasListening = useRef(false);
  useEffect(() => {
    if (state.listening) wasListening.current = true;
    if (state.listening || !wasListening.current) return setEnded(false);
    wasListening.current = false;
    setEnded(true);
    const timer = setTimeout(() => setEnded(false), ENDED_MS);
    return () => clearTimeout(timer);
  }, [state.listening]);

  useEffect(() => {
    const stop = () => dictation.stop();
    const onVisibility = () => document.visibilityState === "hidden" && stop();
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [dictation]);

  useEffect(() => {
    if (hintOpen) hintButton.current?.focus();
  }, [hintOpen]);

  /** The first use explains where the audio goes before anything is recorded. */
  function allowed(): boolean {
    if (hintSeen) return true;
    setHintOpen(true);
    return false;
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || disabled || !allowed()) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dictation.press(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === " ") {
      event.preventDefault();
      if (event.repeat || disabled || !allowed()) return;
      keyboardPress.current = true;
      dictation.press(text);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat && !disabled && allowed()) dictation.tap(text);
    }
  }

  function onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " ") return;
    event.preventDefault();
    if (!keyboardPress.current) return;
    keyboardPress.current = false;
    dictation.release();
  }

  const errorText =
    state.error === "denied"
      ? t("ai.dictation.denied")
      : state.error === "noSpeech"
        ? t("ai.dictation.noSpeech")
        : state.error === "failed"
          ? t("ai.dictation.failed")
          : null;

  const notices = (
    <>
      {hintOpen && (
        <Banner tone="info" live={false}>
          <p>{t("ai.dictation.privacy")}</p>
          <button
            ref={hintButton}
            type="button"
            className="btn btn-sm"
            onClick={() => {
              store(HINT_KEY, "1");
              setHintSeen(true);
              setHintOpen(false);
              button.current?.focus();
            }}
          >
            {t("ai.dictation.understood")}
          </button>
        </Banner>
      )}
      {errorText && <Banner tone={state.error === "noSpeech" ? "info" : "danger"}>{errorText}</Banner>}
    </>
  );

  const mic = (
    <>
      <span className="dictation-status" role="status">
        {state.listening ? (
          <>
            <span className="dictation-dot" aria-hidden="true" /> {t("ai.dictation.recording")}
          </>
        ) : ended ? (
          t("ai.dictation.stopped")
        ) : (
          ""
        )}
      </span>
      <button
        ref={button}
        type="button"
        className={state.listening ? "composer-icon dictation-on" : "composer-icon"}
        aria-pressed={state.listening}
        aria-describedby={`${id}-how`}
        title={t("ai.dictation.how")}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerUp={() => dictation.release()}
        onPointerCancel={() => dictation.release()}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => {
          if (keyboardPress.current) {
            keyboardPress.current = false;
            dictation.release();
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          // Pointers and keys are handled above; a click without either comes from an assistive technology.
          if (event.detail === 0 && !disabled && allowed()) dictation.tap(text);
        }}
      >
        <Icon name="mic" size={18} />
        <span className="visually-hidden">{t("ai.dictation.button")}</span>
      </button>
      <span id={`${id}-how`} className="visually-hidden">
        {t("ai.dictation.how")}
      </span>
    </>
  );

  return layout({ mic, notices });
}

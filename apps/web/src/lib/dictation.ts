/**
 * Dictation into a text field through the browser's speech recognition (Web Speech API). A press held longer than
 * `HOLD_MS` records until it is released (push-to-talk); a shorter press, a tap, records until the next one.
 */

/** The part of the Web Speech API `SpeechRecognition` used here. */
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

/** Every result of the session so far; the last ones may still change (`isFinal` false). */
export type RecognitionEvent = { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };

export type RecognitionFactory = () => Recognition;

type SpeechWindow = { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };

/** The browser's recognition, or null where there is none (Firefox). */
export function recognitionFactory(scope: SpeechWindow): RecognitionFactory | null {
  const Ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof Ctor === "function" ? () => new (Ctor as new () => Recognition)() : null;
}

export const HOLD_MS = 350;

export type DictationError = "denied" | "noSpeech" | "failed";
export type DictationState = {
  listening: boolean;
  /** "hold" until released, "toggle" until the next tap; null while idle. */
  mode: "hold" | "toggle" | null;
  /** The field's text before dictation with what was said so far appended. */
  text: string;
  error: DictationError | null;
};

const ERRORS: Record<string, DictationError | null> = {
  "not-allowed": "denied",
  "service-not-allowed": "denied",
  "no-speech": "noSpeech",
  aborted: null,
};

function joined(base: string, spoken: string): string {
  const said = spoken.trim().replace(/\s+/g, " ");
  if (!said) return base;
  const before = base.trimEnd();
  return before ? `${before} ${said}` : said;
}

export class Dictation {
  private recognition: Recognition | null = null;
  private base = "";
  private spoken = "";
  private pressedAt = 0;
  private held = false;
  /** The press that stopped a toggled recording; its release must not start or stop anything. */
  private swallowRelease = false;
  private state: DictationState = { listening: false, mode: null, text: "", error: null };

  constructor(
    private readonly create: RecognitionFactory,
    private readonly options: {
      lang: string;
      onChange: (state: DictationState) => void;
      /** After a recording that heard something ended normally, with the field's final text. */
      onFinish?: (text: string) => void;
      now?: () => number;
    },
  ) {}

  get current(): DictationState {
    return this.state;
  }

  /** Pointer down, or Space pressed on the button. */
  press(base: string): void {
    if (this.state.listening && this.state.mode === "toggle") {
      this.swallowRelease = true;
      this.stop();
      return;
    }
    if (this.state.listening) return;
    this.held = true;
    this.pressedAt = this.now();
    this.start(base, "hold");
  }

  /** Pointer up, or Space released. A short press turns into a toggled recording. */
  release(): void {
    if (this.swallowRelease) {
      this.swallowRelease = false;
      return;
    }
    if (!this.held) return;
    this.held = false;
    if (!this.state.listening) return;
    if (this.now() - this.pressedAt < HOLD_MS) this.update({ mode: "toggle" });
    else this.stop();
  }

  /** Enter or an assistive technology's click: starts or stops a toggled recording. */
  tap(base: string): void {
    if (this.state.listening) this.stop();
    else this.start(base, "toggle");
  }

  /** Ends a recording, e.g. when the page is hidden; what was said so far stays. */
  stop(): void {
    this.held = false;
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch {
      this.finish(null);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private update(patch: Partial<DictationState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }

  private start(base: string, mode: "hold" | "toggle"): void {
    const recognition = this.create();
    recognition.lang = this.options.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return;
      let spoken = "";
      for (let i = 0; i < event.results.length; i++) spoken += event.results[i]?.[0].transcript ?? "";
      this.spoken = spoken;
      this.update({ text: joined(this.base, spoken) });
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      const error = event.error in ERRORS ? (ERRORS[event.error] ?? null) : "failed";
      if (error) this.update({ error });
    };
    recognition.onend = () => {
      if (this.recognition === recognition) this.finish(this.state.error);
    };
    this.recognition = recognition;
    this.base = base;
    this.spoken = "";
    this.update({ listening: true, mode, text: base, error: null });
    try {
      recognition.start();
    } catch {
      this.finish("failed");
    }
  }

  private finish(error: DictationError | null): void {
    const heard = this.spoken.trim() !== "";
    this.recognition = null;
    this.held = false;
    this.update({ listening: false, mode: null, text: joined(this.base, this.spoken), error });
    if (heard && !error) this.options.onFinish?.(this.state.text);
  }
}

import { describe, expect, it, vi } from "vitest";
import { Dictation, type DictationState, HOLD_MS, type Recognition, recognitionFactory } from "./dictation.ts";

class FakeRecognition implements Recognition {
  lang = "";
  continuous = false;
  interimResults = false;
  started = 0;
  stopped = 0;
  onresult: Recognition["onresult"] = null;
  onerror: Recognition["onerror"] = null;
  onend: Recognition["onend"] = null;
  private results: { isFinal: boolean; 0: { transcript: string } }[] = [];

  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  say(transcript: string, isFinal: boolean) {
    const last = this.results.at(-1);
    if (last && !last.isFinal) this.results.pop();
    this.results.push({ isFinal, 0: { transcript } });
    this.onresult?.({ results: this.results });
  }
  fail(error: string) {
    this.onerror?.({ error });
    this.onend?.();
  }
}

function setup() {
  let clock = 0;
  const recognitions: FakeRecognition[] = [];
  const states: DictationState[] = [];
  const finished: string[] = [];
  const dictation = new Dictation(
    () => {
      const r = new FakeRecognition();
      recognitions.push(r);
      return r;
    },
    { lang: "de-DE", onChange: (s) => states.push(s), onFinish: (text) => finished.push(text), now: () => clock },
  );
  return {
    dictation,
    recognitions,
    states,
    finished,
    advance: (ms: number) => {
      clock += ms;
    },
    last: () => recognitions.at(-1) as FakeRecognition,
  };
}

describe("dictation", () => {
  it("finds the browser's recognition and none in Firefox", () => {
    expect(recognitionFactory({})).toBeNull();
    expect(recognitionFactory({ webkitSpeechRecognition: FakeRecognition })?.()).toBeInstanceOf(FakeRecognition);
    expect(recognitionFactory({ SpeechRecognition: FakeRecognition, webkitSpeechRecognition: 1 })?.()).toBeInstanceOf(FakeRecognition);
  });

  it("records while held and stops on release (push-to-talk)", () => {
    const s = setup();
    s.dictation.press("Wie viel");
    const r = s.last();
    expect(r).toMatchObject({ lang: "de-DE", continuous: true, interimResults: true, started: 1 });
    expect(s.dictation.current).toMatchObject({ listening: true, mode: "hold", text: "Wie viel" });
    r.say("für Lebens", false);
    expect(s.dictation.current.text).toBe("Wie viel für Lebens");
    r.say("für Lebensmittel", true);
    s.advance(HOLD_MS + 50);
    s.dictation.release();
    expect(r.stopped).toBe(1);
    expect(s.dictation.current).toEqual({ listening: false, mode: null, text: "Wie viel für Lebensmittel", error: null });
    expect(s.finished).toEqual(["Wie viel für Lebensmittel"]);
  });

  it("keeps recording after a tap and stops at the next press without a stray release", () => {
    const s = setup();
    s.dictation.press("");
    s.advance(100);
    s.dictation.release();
    expect(s.dictation.current).toMatchObject({ listening: true, mode: "toggle" });
    s.last().say("Miete im Oktober", true);
    s.advance(5_000);
    s.dictation.press("ignored");
    expect(s.dictation.current).toMatchObject({ listening: false, text: "Miete im Oktober" });
    s.advance(1_000);
    s.dictation.release();
    expect(s.recognitions).toHaveLength(1);
    expect(s.dictation.current.listening).toBe(false);
  });

  it("toggles with Enter or an assistive technology's click", () => {
    const s = setup();
    s.dictation.tap("Hallo");
    expect(s.dictation.current).toMatchObject({ listening: true, mode: "toggle" });
    s.dictation.tap("Hallo");
    expect(s.dictation.current.listening).toBe(false);
    expect(s.finished).toEqual([]);
  });

  it("reports a denied microphone and finishes nothing", () => {
    const s = setup();
    s.dictation.tap("");
    s.last().fail("not-allowed");
    expect(s.dictation.current).toEqual({ listening: false, mode: null, text: "", error: "denied" });
    s.dictation.tap("");
    expect(s.dictation.current.error).toBeNull();
    s.last().fail("network");
    expect(s.dictation.current.error).toBe("failed");
    expect(s.finished).toEqual([]);
  });

  it("stops from outside (blur, hidden page) and keeps what was said", () => {
    const s = setup();
    s.dictation.tap("Und");
    s.last().say("im September", false);
    s.dictation.stop();
    expect(s.dictation.current).toMatchObject({ listening: false, text: "Und im September" });
    expect(s.finished).toEqual(["Und im September"]);
  });

  it("survives a recognition that refuses to start", () => {
    const failing = vi.fn(() => {
      const r = new FakeRecognition();
      r.start = () => {
        throw new Error("InvalidStateError");
      };
      return r;
    });
    const states: DictationState[] = [];
    const dictation = new Dictation(failing, { lang: "en-GB", onChange: (s) => states.push(s) });
    dictation.press("x");
    dictation.release();
    expect(dictation.current).toEqual({ listening: false, mode: null, text: "x", error: "failed" });
  });
});

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Shuffle, Mic, RotateCcw, BookOpen, Zap, Check, X, AtSign } from "lucide-react";
import { TOPICS, CUFF_CATS, RESEARCH_CATS } from "./data/topics/index.js";
import { getAllRecordings, putRecording, deleteRecordingFromDb } from "./lib/recordingsDb.js";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const C = {
  bg: "#12151A",
  bgEdge: "#0A0C0F",
  surface: "#1A1F26",
  surfaceAlt: "#20262E",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  text: "#ECE9E2",
  textMuted: "#8D94A0",
  amber: "#E8A33D",
  amberSoft: "rgba(232,163,61,0.16)",
  sage: "#5FA08A",
  sageSoft: "rgba(95,160,138,0.16)",
  red: "#D9635B",
  redSoft: "rgba(217,99,91,0.16)",
};

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap');
`;

// ---------------------------------------------------------------------------
// Audio cue (no external asset — synthesized beep)
// ---------------------------------------------------------------------------
function useSound() {
  const ctxRef = useRef(null);
  const getCtx = () => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new AC();
    }
    return ctxRef.current;
  };

  // Create the AudioContext up front so its one-time hardware init doesn't
  // add a lag to the very first sound the user hears after a page load.
  useEffect(() => {
    const ctx = getCtx();
    const resume = () => {
      if (ctx.state === "suspended") ctx.resume();
    };
    resume();
    window.addEventListener("pointerdown", resume);
    return () => window.removeEventListener("pointerdown", resume);
  }, []);

  // Bell-style cue — used for prep/speak time markers
  const beep = useCallback((count = 1, freq = 880) => {
    try {
      const ctx = getCtx();
      for (let i = 0; i < count; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.type = "sine";
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        const t0 = ctx.currentTime + i * 0.22;
        gain.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      }
    } catch (e) {
      // audio not available in this preview — fail silently
    }
  }, []);

  // Sharp mechanical click — used for each reel tick while spinning
  const tick = useCallback((freq = 700) => {
    try {
      const ctx = getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.55, t0 + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
      osc.start(t0);
      osc.stop(t0 + 0.05);
    } catch (e) {
      // ignore
    }
  }, []);

  // Low continuous whirr under the ticks — the "searching" texture
  const startWhir = useCallback((durationMs) => {
    try {
      const ctx = getCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime;
      const durSec = durationMs / 1000;
      osc.frequency.setValueAtTime(260, t0);
      osc.frequency.exponentialRampToValueAtTime(65, t0 + durSec);
      gain.gain.exponentialRampToValueAtTime(0.32, t0 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
      osc.start(t0);
      osc.stop(t0 + durSec + 0.05);
    } catch (e) {
      // ignore
    }
  }, []);

  return { beep, tick, startWhir };
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function formatDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function recordingFilename(topic) {
  const slug = topic.text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  return `speakloop-${slug || "recording"}.webm`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Speakloop() {
  const [mode, setMode] = useState("cuff"); // 'cuff' | 'research'
  const [category, setCategory] = useState("All");
  const [topic, setTopic] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | prep | research | speaking | done
  const [prepSeconds, setPrepSeconds] = useState(15);
  const [speakSeconds, setSpeakSeconds] = useState(90);
  const [researchMinutes, setResearchMinutes] = useState(5);
  const [timeLeft, setTimeLeft] = useState(0);
  const [totalForPhase, setTotalForPhase] = useState(0);
  const [recentIds, setRecentIds] = useState([]);
  const [recordOn, setRecordOn] = useState(false);
  const [micError, setMicError] = useState(null);
  const [spokeSeconds, setSpokeSeconds] = useState(0);
  const [confirmSwitch, setConfirmSwitch] = useState(null); // { type: 'mode'|'category', value }
  const [spinDisplay, setSpinDisplay] = useState("");
  const [audioUrl, setAudioUrl] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const [view, setView] = useState("app"); // 'app' | 'library'

  const { beep, tick, startWhir } = useSound();
  const intervalRef = useRef(null);
  const mediaRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  const cats = mode === "cuff" ? CUFF_CATS : RESEARCH_CATS;

  useEffect(() => {
    setCategory("All");
    setPhase("idle");
    setTopic(null);
  }, [mode]);

  const pool = TOPICS.filter(
    (t) => t.mode === mode && (category === "All" || t.cat === category)
  );

  const SPIN_DELAYS = [69, 75, 82, 96, 110, 130, 151, 178, 205, 240, 281, 329, 384, 452]; // sums to ~3s of searching

  const runSpinSequence = (choices, onDone) => {
    const total = SPIN_DELAYS.reduce((a, b) => a + b, 0) + 220; // ~3s
    startWhir(total);
    let cum = 0;
    SPIN_DELAYS.forEach((d) => {
      cum += d;
      setTimeout(() => {
        tick(600 + Math.random() * 300);
        const r = choices[Math.floor(Math.random() * choices.length)];
        setSpinDisplay(r.text);
      }, cum);
    });
    setTimeout(() => {
      beep(1, 300);
      onDone();
    }, total);
  };

  const spin = () => {
    let choices = pool.filter((t) => !recentIds.includes(t.id));
    if (choices.length === 0) choices = pool;
    if (choices.length === 0) return;
    setPhase("spinning");
    setSpinDisplay(choices[Math.floor(Math.random() * choices.length)].text);
    runSpinSequence(choices, () => {
      const pick = choices[Math.floor(Math.random() * choices.length)];
      setTopic(pick);
      setRecentIds((prev) => [pick.id, ...prev].slice(0, 5));
      setPhase("topicReady");
    });
  };

  const activeSession = phase !== "idle" && phase !== "done";

  const applyChange = (type, value) => {
    clearTimer();
    if (mediaRef.current) {
      mediaRef.current.getTracks().forEach((tr) => tr.stop());
      mediaRef.current = null;
    }
    setAudioUrl(null);
    setPhase("idle");
    setTopic(null);
    if (type === "mode") setMode(value);
    else setCategory(value);
  };

  const requestChange = (type, value) => {
    if (activeSession) setConfirmSwitch({ type, value });
    else applyChange(type, value);
  };

  const clearTimer = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
  };

  const runCountdown = (seconds, onTick, onDone) => {
    clearTimer();
    setTimeLeft(seconds);
    setTotalForPhase(seconds);
    intervalRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        const next = prev - 1;
        if (onTick) onTick(next);
        if (next <= 0) {
          clearTimer();
          onDone && onDone();
          return 0;
        }
        return next;
      });
    }, 1000);
  };

  const describeMicError = (e) => {
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
      return "Microphone access was denied. Allow it in your browser's site settings to record.";
    }
    if (e && e.name === "NotFoundError") {
      return "No microphone was found. Connect one and try again.";
    }
    return "Couldn't access your microphone. Recording is off for this take.";
  };

  const handleRecordToggle = async (checked) => {
    setRecordOn(checked);
    if (!checked) {
      setMicError(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Just probing for permission here — the real stream is grabbed again when speaking starts.
      stream.getTracks().forEach((tr) => tr.stop());
      setMicError(null);
    } catch (e) {
      setMicError(describeMicError(e));
    }
  };

  const startPrepOrSpeak = () => {
    if (mode === "cuff" && prepSeconds > 0) {
      setPhase("prep");
      runCountdown(prepSeconds, null, () => startSpeaking());
    } else {
      startSpeaking();
    }
  };

  const startResearch = () => {
    setPhase("research");
    runCountdown(researchMinutes * 60, null, () => {
      beep(1, 660);
      setPhase("readyToSpeak");
    });
  };

  const startSpeaking = async () => {
    if (recordOn) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRef.current = stream;
        setMicError(null);
        chunksRef.current = [];
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        mediaRecorderRef.current = mr;
        mr.start();
      } catch (e) {
        setMicError(describeMicError(e));
        mediaRecorderRef.current = null;
      }
    }
    setPhase("speaking");
    runCountdown(
      speakSeconds,
      (next) => {
        if (next === 30) beep(1, 880);
        if (next === 10) beep(2, 880);
      },
      () => {
        beep(1, 440);
        finishSpeaking(speakSeconds);
      }
    );
  };

  const finishSpeaking = (elapsed) => {
    setSpokeSeconds(elapsed);
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        const record = {
          id: `${Date.now()}-${topic.id}-${Math.random().toString(36).slice(2, 8)}`,
          topicText: topic.text,
          cat: topic.cat,
          seconds: elapsed,
          createdAt: Date.now(),
          label: null,
          note: null,
          blob,
        };
        setRecordings((prev) => [{ ...record, url }, ...prev]);
        putRecording(record).catch((e) => console.error("Failed to save recording", e));
        if (mediaRef.current) {
          mediaRef.current.getTracks().forEach((tr) => tr.stop());
          mediaRef.current = null;
        }
        setPhase("review");
      };
      mr.stop();
    } else {
      if (mediaRef.current) {
        mediaRef.current.getTracks().forEach((tr) => tr.stop());
        mediaRef.current = null;
      }
      setPhase("done");
    }
  };

  const stopEarly = () => {
    const elapsed = totalForPhase - timeLeft;
    clearTimer();
    finishSpeaking(elapsed);
  };

  const reset = (sameTopic) => {
    clearTimer();
    setAudioUrl(null);
    setPhase(sameTopic ? "topicReady" : "idle");
    if (!sameTopic) setTopic(null);
  };

  const deleteRecording = (id) => {
    setRecordings((prev) => {
      const rec = prev.find((r) => r.id === id);
      if (rec) URL.revokeObjectURL(rec.url);
      return prev.filter((r) => r.id !== id);
    });
    deleteRecordingFromDb(id).catch((e) => console.error("Failed to delete recording", e));
  };

  const updateRecordingMeta = (id, updates) => {
    setRecordings((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...updates } : r));
      const rec = next.find((r) => r.id === id);
      if (rec) {
        const { url: _url, ...persisted } = rec;
        putRecording(persisted).catch((e) => console.error("Failed to update recording", e));
      }
      return next;
    });
  };

  useEffect(() => () => clearTimer(), []);

  // Load previously saved recordings from IndexedDB on app load.
  useEffect(() => {
    let cancelled = false;
    getAllRecordings()
      .then((stored) => {
        if (cancelled) return;
        const withUrls = stored
          .map((rec) => ({ ...rec, url: URL.createObjectURL(rec.blob) }))
          .sort((a, b) => b.createdAt - a.createdAt);
        setRecordings(withUrls);
      })
      .catch((e) => console.error("Failed to load recordings from IndexedDB", e));
    return () => {
      cancelled = true;
    };
  }, []);

  const accent = mode === "cuff" ? C.amber : C.sage;
  const accentSoft = mode === "cuff" ? C.amberSoft : C.sageSoft;

  const ringPct =
    totalForPhase > 0 ? Math.max(0, Math.min(1, timeLeft / totalForPhase)) : 1;
  const isDanger = phase === "speaking" && timeLeft <= 10 && timeLeft > 0;

  return (
    <div
      style={{
        flex: "1 1 auto",
        minHeight: "100svh",
        width: "100%",
        background: `radial-gradient(circle at 50% -10%, ${C.surface} 0%, ${C.bg} 55%, ${C.bgEdge} 100%)`,
        color: C.text,
        fontFamily: "'Inter', sans-serif",
        padding: "clamp(20px, 6vw, 32px) clamp(14px, 5vw, 20px) 48px",
        display: "flex",
        justifyContent: "center",
        overflowX: "hidden",
        boxSizing: "border-box",
      }}
    >
      <style>{FONTS}</style>
      <div style={{ width: "100%", maxWidth: 560 }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              fontFamily: "'Fraunces', serif",
              fontWeight: 600,
              fontSize: "clamp(26px, 8vw, 34px)",
              letterSpacing: "-0.01em",
            }}
          >
            Speak<span style={{ color: accent }}>loop</span>
          </div>
          <div style={{ color: C.textMuted, fontSize: 14, marginTop: 4 }}>
            Every topic is a stage. Step up.
          </div>
        </div>

        {/* Page nav */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: 8,
            marginBottom: 22,
          }}
        >
          <button
            onClick={() => setView("app")}
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${view === "app" ? C.borderStrong : C.border}`,
              background: view === "app" ? C.surfaceAlt : "transparent",
              color: view === "app" ? C.text : C.textMuted,
            }}
          >
            Practice
          </button>
          <button
            onClick={() => setView("library")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${view === "library" ? C.borderStrong : C.border}`,
              background: view === "library" ? C.surfaceAlt : "transparent",
              color: view === "library" ? C.text : C.textMuted,
            }}
          >
            My Recordings{recordings.length > 0 ? ` (${recordings.length})` : ""}
          </button>
        </div>

        {view === "library" ? (
          <RecordingsLibrary
            recordings={recordings}
            onDelete={deleteRecording}
            onUpdate={updateRecordingMeta}
            accent={accent}
          />
        ) : (
        <>
        {/* Mode toggle */}
        <div
          style={{
            display: "flex",
            background: C.surface,
            border: `1px solid ${C.border}`,
            borderRadius: 14,
            padding: 4,
            marginBottom: 18,
          }}
        >
          {[
            { key: "cuff", label: "Off the Cuff", Icon: Zap },
            { key: "research", label: "Deep Research", Icon: BookOpen },
          ].map(({ key, label, Icon }) => {
            const active = mode === key;
            return (
              <button
                key={key}
                onClick={() => requestChange("mode", key)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "10px 8px",
                  borderRadius: 10,
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "'Inter', sans-serif",
                  fontWeight: 600,
                  fontSize: "clamp(12px, 3.2vw, 14px)",
                  whiteSpace: "nowrap",
                  color: active ? "#14171C" : C.textMuted,
                  background: active
                    ? key === "cuff"
                      ? C.amber
                      : C.sage
                    : "transparent",
                  transition: "all 0.2s ease",
                }}
              >
                <Icon size={16} />
                {label}
              </button>
            );
          })}
        </div>

        {/* Category chips */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            justifyContent: "center",
            marginBottom: 22,
          }}
        >
          {cats.map((c) => {
            const active = category === c;
            return (
              <button
                key={c}
                onClick={() => requestChange("category", c)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: `1px solid ${active ? accent : C.border}`,
                  background: active ? accentSoft : "transparent",
                  color: active ? accent : C.textMuted,
                  transition: "all 0.15s ease",
                }}
              >
                {c}
              </button>
            );
          })}
        </div>

        {/* Main stage card */}
        <div
          style={{
            position: "relative",
            background: C.surface,
            border: `1px solid ${isDanger ? C.red : C.border}`,
            borderRadius: 20,
            padding: "clamp(24px, 6vw, 36px) clamp(16px, 5vw, 28px)",
            textAlign: "center",
            boxSizing: "border-box",
            boxShadow: `0 12px 34px rgba(0,0,0,0.28)${
              phase === "speaking" ? `, 0 0 60px ${isDanger ? C.redSoft : accentSoft}` : ""
            }`,
            transition: "box-shadow 0.4s ease, border-color 0.3s ease",
          }}
        >
          {/* Idle state */}
          {phase === "idle" && (
            <>
              <div style={{ color: C.textMuted, fontSize: 15, marginBottom: 22 }}>
                Hit spin to get your topic.
              </div>
              <SpinButton onClick={spin} accent={accent} />
            </>
          )}

          {/* Spinning */}
          {phase === "spinning" && (
            <>
              <Eyebrow accent={accent}>Spinning</Eyebrow>
              <TopicText small>
                <span style={{ opacity: 0.85, filter: "blur(0.3px)" }}>
                  {spinDisplay}
                </span>
              </TopicText>
              <div
                style={{
                  width: 40,
                  height: 40,
                  margin: "20px auto 0",
                  border: `3px solid ${C.border}`,
                  borderTopColor: accent,
                  borderRadius: "50%",
                  animation: "spin 0.5s linear infinite",
                }}
              />
            </>
          )}

          {/* Topic ready */}
          {phase === "topicReady" && topic && (
            <>
              <Eyebrow accent={accent}>{topic.cat}</Eyebrow>
              <TopicText>{topic.text}</TopicText>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  justifyContent: "center",
                  marginTop: 26,
                  flexWrap: "wrap",
                }}
              >
                {mode === "cuff" ? (
                  <PresetRow
                    label="Prep"
                    value={prepSeconds}
                    options={[0, 15, 30, 60]}
                    unit="s"
                    onChange={setPrepSeconds}
                    accent={accent}
                  />
                ) : (
                  <PresetRow
                    label="Research"
                    value={researchMinutes}
                    options={[1, 5, 10, 15]}
                    unit="m"
                    onChange={setResearchMinutes}
                    accent={accent}
                  />
                )}
                <PresetRow
                  label="Speak"
                  value={speakSeconds}
                  options={[30, 60, 90, 120, 180]}
                  unit="s"
                  onChange={setSpeakSeconds}
                  accent={accent}
                />
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  marginTop: 18,
                  fontSize: 13,
                  color: C.textMuted,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={recordOn}
                  onChange={(e) => handleRecordToggle(e.target.checked)}
                  style={{ accentColor: accent }}
                />
                <Mic size={14} /> Record while I speak
              </label>
              {micError && (
                <div style={{ color: C.red, fontSize: 12, marginTop: 6 }}>
                  {micError}
                </div>
              )}

              <div style={{ marginTop: 24, display: "flex", gap: 10, justifyContent: "center" }}>
                <GhostButton onClick={() => reset(false)}>
                  <Shuffle size={14} /> New topic
                </GhostButton>
                <PrimaryButton
                  accent={accent}
                  onClick={mode === "cuff" ? startPrepOrSpeak : startResearch}
                >
                  {mode === "cuff"
                    ? prepSeconds > 0
                      ? "Start prep"
                      : "Start speaking"
                    : "Start research"}
                </PrimaryButton>
              </div>
            </>
          )}

          {/* Prep countdown */}
          {phase === "prep" && (
            <>
              <Eyebrow accent={accent}>Get ready</Eyebrow>
              <TimerRing pct={timeLeft / totalForPhase} accent={accent}>
                {timeLeft}
              </TimerRing>
              <div style={{ color: C.textMuted, fontSize: 14, margin: "14px 0 20px" }}>
                Order your thoughts. No notes once you start.
              </div>
              <GhostButton onClick={() => { clearTimer(); startSpeaking(); }}>
                Start now
              </GhostButton>
            </>
          )}

          {/* Research phase */}
          {phase === "research" && topic && (
            <>
              <Eyebrow accent={accent}>{topic.cat} · Researching</Eyebrow>
              <TopicText small>{topic.text}</TopicText>
              <TimerRing pct={timeLeft / totalForPhase} accent={accent}>
                {formatTime(timeLeft)}
              </TimerRing>
              <div style={{ color: C.textMuted, fontSize: 14, margin: "14px 0 20px" }}>
                Dig in — search, read, take notes. Close it all before you speak.
              </div>
              <GhostButton onClick={() => { clearTimer(); beep(1, 660); setPhase("readyToSpeak"); }}>
                Ready early
              </GhostButton>
            </>
          )}

          {/* Ready to speak (post-research) */}
          {phase === "readyToSpeak" && topic && (
            <>
              <Eyebrow accent={accent}>{topic.cat} · Ready</Eyebrow>
              <TopicText small>{topic.text}</TopicText>
              <div style={{ color: C.textMuted, fontSize: 14, margin: "14px 0 22px" }}>
                Close your notes. Speak when you're ready.
              </div>
              <PrimaryButton accent={accent} onClick={startSpeaking}>
                Start speaking
              </PrimaryButton>
            </>
          )}

          {/* Speaking */}
          {phase === "speaking" && topic && (
            <>
              <Eyebrow accent={isDanger ? C.red : accent}>
                {topic.cat} · {isDanger ? "Wrap it up" : "You're on"}
              </Eyebrow>
              <TopicText small>{topic.text}</TopicText>
              <TimerRing pct={ringPct} accent={isDanger ? C.red : accent} pulse={isDanger}>
                {formatTime(timeLeft)}
              </TimerRing>
              {recordOn && !micError && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    fontSize: 12,
                    color: C.red,
                    marginTop: 10,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: C.red,
                      display: "inline-block",
                      animation: "pulse 1.2s infinite",
                    }}
                  />
                  Recording
                </div>
              )}
              {recordOn && micError && (
                <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>
                  {micError} Continuing without recording.
                </div>
              )}
              <div style={{ marginTop: 20 }}>
                <GhostButton onClick={stopEarly}>
                  <X size={14} /> Stop
                </GhostButton>
              </div>
            </>
          )}

          {/* Review — listen back before moving on */}
          {phase === "review" && topic && audioUrl && (
            <>
              <Eyebrow accent={accent}>{topic.cat} · Your recording</Eyebrow>
              <TopicText small>{topic.text}</TopicText>
              <div style={{ margin: "22px 0 6px" }}>
                <audio controls src={audioUrl} style={{ width: "100%" }} />
              </div>
              <div style={{ color: C.textMuted, fontSize: 13, margin: "10px 0 22px" }}>
                Spoke for {formatTime(spokeSeconds)}. It's saved under "My Recordings" too.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <GhostLink href={audioUrl} download={recordingFilename(topic)}>
                  Save audio file
                </GhostLink>
                <PrimaryButton accent={accent} onClick={() => setPhase("done")}>
                  Continue
                </PrimaryButton>
              </div>
            </>
          )}

          {/* Done */}
          {phase === "done" && topic && (
            <>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 999,
                  background: accentSoft,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 16px",
                }}
              >
                <Check size={22} color={accent} />
              </div>
              <div
                style={{
                  fontFamily: "'Fraunces', serif",
                  fontSize: 22,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                Nice work.
              </div>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 22 }}>
                You spoke for {formatTime(spokeSeconds)} on "{topic.text}".
              </div>
              {audioUrl && (
                <>
                  <div style={{ margin: "0 0 6px" }}>
                    <audio controls src={audioUrl} style={{ width: "100%" }} />
                  </div>
                  <div style={{ color: C.textMuted, fontSize: 12, marginBottom: 20 }}>
                    You can still listen to or save this — it's also saved under "My Recordings".
                  </div>
                </>
              )}
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                {audioUrl && (
                  <GhostLink href={audioUrl} download={recordingFilename(topic)}>
                    Save audio file
                  </GhostLink>
                )}
                <GhostButton onClick={() => reset(true)}>
                  <RotateCcw size={14} /> Same topic again
                </GhostButton>
                <PrimaryButton accent={accent} onClick={() => { reset(false); spin(); }}>
                  <Shuffle size={14} /> New topic
                </PrimaryButton>
              </div>
            </>
          )}
        </div>

        {/* Recent topics */}
        {recentIds.length > 0 && phase === "idle" && (
          <div style={{ marginTop: 22, textAlign: "center" }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>
              RECENT
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {recentIds.map((id) => {
                const t = TOPICS.find((x) => x.id === id);
                if (!t) return null;
                return (
                  <div
                    key={id}
                    style={{
                      fontSize: 13,
                      color: C.textMuted,
                      background: C.surfaceAlt,
                      border: `1px solid ${C.border}`,
                      borderRadius: 10,
                      padding: "8px 12px",
                    }}
                  >
                    {t.text}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </>
        )}

        {/* Footer */}
        <div
          style={{
            textAlign: "center",
            marginTop: 36,
            paddingTop: 20,
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>
            Practice out loud. Get better in public.
          </div>
          <div style={{ fontSize: 11, color: C.textMuted, opacity: 0.65, marginBottom: 10 }}>
            Founded by Shimarkspeaks
          </div>
          <a
            href="https://www.instagram.com/shimark.speaks/"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: accent,
              fontSize: 12,
              fontWeight: 600,
              textDecoration: "none",
              opacity: 0.9,
            }}
          >
            <AtSign size={14} /> Follow the journey on Instagram
          </a>
        </div>
      </div>

      {/* Leave-warning modal */}
      {confirmSwitch && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(10,12,15,0.72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: 20,
          }}
        >
          <div
            style={{
              background: C.surface,
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 16,
              padding: "26px 24px",
              maxWidth: 320,
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontFamily: "'Fraunces', serif",
                fontSize: 18,
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Leave this topic?
            </div>
            <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 20 }}>
              Switching now cancels what you're doing and takes you back to pick a new topic.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <GhostButton onClick={() => setConfirmSwitch(null)}>Stay</GhostButton>
              <PrimaryButton
                accent={accent}
                onClick={() => {
                  applyChange(confirmSwitch.type, confirmSwitch.value);
                  setConfirmSwitch(null);
                }}
              >
                Yes, switch
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function Eyebrow({ children, accent }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: accent,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

function TopicText({ children, small }) {
  return (
    <div
      style={{
        fontFamily: "'Fraunces', serif",
        fontWeight: 600,
        fontSize: small ? 20 : 26,
        lineHeight: 1.3,
        color: "#ECE9E2",
      }}
    >
      {children}
    </div>
  );
}

function SpinButton({ onClick, accent }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "14px 28px",
        borderRadius: 14,
        border: "none",
        cursor: "pointer",
        background: accent,
        color: "#14171C",
        fontFamily: "'Inter', sans-serif",
        fontWeight: 600,
        fontSize: 16,
      }}
    >
      <Shuffle size={18} /> Spin a topic
    </button>
  );
}

function PrimaryButton({ children, onClick, accent }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 22px",
        borderRadius: 12,
        border: "none",
        cursor: "pointer",
        background: accent,
        color: "#14171C",
        fontFamily: "'Inter', sans-serif",
        fontWeight: 600,
        fontSize: 14,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 20px",
        borderRadius: 12,
        border: `1px solid ${C.borderStrong}`,
        cursor: "pointer",
        background: "transparent",
        color: C.text,
        fontFamily: "'Inter', sans-serif",
        fontWeight: 600,
        fontSize: 14,
      }}
    >
      {children}
    </button>
  );
}

function GhostLink({ children, href, download }) {
  return (
    <a
      href={href}
      download={download}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 20px",
        borderRadius: 12,
        border: `1px solid ${C.borderStrong}`,
        cursor: "pointer",
        background: "transparent",
        color: C.text,
        fontFamily: "'Inter', sans-serif",
        fontWeight: 600,
        fontSize: 14,
        textDecoration: "none",
      }}
    >
      {children}
    </a>
  );
}

function RecordingsLibrary({ recordings, onDelete, onUpdate, accent }) {
  if (recordings.length === 0) {
    return (
      <div
        style={{
          background: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 20,
          padding: "40px 28px",
          textAlign: "center",
          color: C.textMuted,
          fontSize: 14,
        }}
      >
        No recordings yet. Turn on "Record while I speak" during a take and it'll show up here.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", marginBottom: 4 }}>
        Saved on this device — persists across reloads. Download anything you want to keep elsewhere.
      </div>
      {recordings.map((rec) => (
        <RecordingItem key={rec.id} rec={rec} onDelete={onDelete} onUpdate={onUpdate} accent={accent} />
      ))}
    </div>
  );
}

function RecordingItem({ rec, onDelete, onUpdate, accent }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [titleDraft, setTitleDraft] = useState(rec.label || rec.topicText);
  const [noteDraft, setNoteDraft] = useState(rec.note || "");

  const startEdit = () => {
    setTitleDraft(rec.label || rec.topicText);
    setNoteDraft(rec.note || "");
    setConfirmingDelete(false);
    setEditing(true);
  };

  const saveEdit = () => {
    const trimmedTitle = titleDraft.trim();
    onUpdate(rec.id, {
      label: trimmedTitle && trimmedTitle !== rec.topicText ? trimmedTitle : null,
      note: noteDraft.trim() || null,
    });
    setEditing(false);
  };

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${C.border}`,
    background: C.surfaceAlt,
    color: C.text,
    fontFamily: "'Inter', sans-serif",
    fontSize: 13,
  };

  const btnStyle = (color) => ({
    padding: "8px 16px",
    borderRadius: 10,
    border: `1px solid ${C.border}`,
    cursor: "pointer",
    background: "transparent",
    color: color || C.text,
    fontFamily: "'Inter', sans-serif",
    fontWeight: 600,
    fontSize: 13,
  });

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        padding: "18px 20px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: accent }}>
          {rec.cat}
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, flexShrink: 0 }}>
          {formatDate(rec.createdAt)} · {formatTime(rec.seconds)}
        </div>
      </div>

      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          <input
            style={inputStyle}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Title"
            maxLength={120}
          />
          <input
            style={inputStyle}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Add a short note (optional)"
            maxLength={200}
          />
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontFamily: "'Fraunces', serif",
              fontWeight: 600,
              fontSize: 16,
            }}
          >
            {rec.label || rec.topicText}
          </div>
          {rec.note ? (
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>{rec.note}</div>
          ) : null}
        </div>
      )}

      <audio controls src={rec.url} style={{ width: "100%", marginBottom: 12 }} />

      {editing ? (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={() => setEditing(false)} style={btnStyle()}>
            Cancel
          </button>
          <button onClick={saveEdit} style={btnStyle(C.sage)}>
            Save
          </button>
        </div>
      ) : confirmingDelete ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end" }}>
          <span style={{ fontSize: 13, color: C.textMuted }}>Delete this recording?</span>
          <button onClick={() => setConfirmingDelete(false)} style={btnStyle()}>
            Cancel
          </button>
          <button onClick={() => onDelete(rec.id)} style={btnStyle(C.red)}>
            Confirm Delete
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <GhostLink href={rec.url} download={recordingFilename({ text: rec.label || rec.topicText })}>
            Save
          </GhostLink>
          <button onClick={startEdit} style={btnStyle()}>
            Edit
          </button>
          <button onClick={() => setConfirmingDelete(true)} style={btnStyle(C.red)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function PresetRow({ label, value, options, unit, onChange, accent }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        background: C.surfaceAlt,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: 4,
        maxWidth: "100%",
      }}
    >
      <span style={{ fontSize: 11, color: C.textMuted, padding: "0 6px" }}>
        {label}
      </span>
      {options.map((opt) => {
        const active = value === opt;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            style={{
              padding: "5px 9px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
              background: active ? accent : "transparent",
              color: active ? "#14171C" : C.textMuted,
            }}
          >
            {opt}
            {unit}
          </button>
        );
      })}
    </div>
  );
}

function TimerRing({ pct, accent, children, pulse }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(1, pct)));
  return (
    <div
      style={{
        position: "relative",
        width: 132,
        height: 132,
        margin: "8px auto",
        animation: pulse ? "pulse 0.8s infinite" : "none",
      }}
    >
      <svg width="132" height="132" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="66" cy="66" r={r} fill="none" stroke={C.border} strokeWidth="8" />
        <circle
          cx="66"
          cy="66"
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth="8"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 1s linear" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
          fontSize: 26,
          color: C.text,
        }}
      >
        {children}
      </div>
    </div>
  );
}

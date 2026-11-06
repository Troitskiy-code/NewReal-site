"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VOICE_INPUT_MAX_SAMPLES, VOICE_INPUT_MIN_BYTES, VOICE_INPUT_PATH, VOICE_INPUT_SECONDS,
  VOICE_INPUT_SAMPLE_RATE, VOICE_INPUT_WORKLET, type VoiceInputError } from "@/lib/voiceInput";

type Phase = "idle" | "permission" | "recording" | "processing";
type Capture = {
  context: AudioContext;
  request: AbortController;
  stream?: MediaStream;
  node?: AudioWorkletNode;
  timer?: number;
  finishing?: boolean;
};

const subscribe = () => () => {};
function supportsVoiceInput() {
  return window.isSecureContext && typeof AudioContext === "function"
    && typeof AudioWorkletNode === "function" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function releaseMicrophone(capture: Capture) {
  window.clearTimeout(capture.timer);
  capture.node?.disconnect();
  capture.node?.port.close();
  capture.stream?.getTracks().forEach(track => track.stop());
  if (capture.context.state !== "closed") void capture.context.close().catch(() => {});
}

function requestRecordingStop(capture: Capture | null, onTimeout: () => void) {
  if (!capture?.node || capture.finishing) return false;
  capture.finishing = true;
  window.clearTimeout(capture.timer);
  capture.timer = window.setTimeout(onTimeout, 1_500);
  capture.node.port.postMessage("finish");
  return true;
}

export function useVoiceInput({
  enabled, onCaptureChange, onText,
}: {
  enabled: boolean;
  onCaptureChange: (capturing: boolean) => void;
  onText: (text: string) => void;
}) {
  const supported = useSyncExternalStore(subscribe, supportsVoiceInput, () => false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<VoiceInputError | null>(null);
  const current = useRef<Capture | null>(null);
  const onTextRef = useRef(onText);

  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const dispose = useCallback(() => {
    const capture = current.current;
    current.current = null;
    if (!capture) return;
    capture.request.abort();
    releaseMicrophone(capture);
    onCaptureChange(false);
  }, [onCaptureChange]);

  const cancel = useCallback(() => {
    dispose();
    setPhase("idle");
    setError(null);
  }, [dispose]);

  useEffect(() => dispose, [dispose]);
  useEffect(() => { if (!enabled && current.current) cancel(); }, [cancel, enabled]);
  useEffect(() => {
    const onHidden = () => { if (document.hidden && current.current) cancel(); };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", cancel);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", cancel);
    };
  }, [cancel]);

  function fail(capture: Capture, code: VoiceInputError) {
    if (current.current !== capture) return;
    dispose();
    setPhase("idle");
    setError(code);
  }

  async function transcribe(capture: Capture, pcm: ArrayBuffer) {
    if (current.current !== capture) return;
    releaseMicrophone(capture);
    onCaptureChange(false);
    if (pcm.byteLength < VOICE_INPUT_MIN_BYTES) return fail(capture, "empty");
    setPhase("processing");
    try {
      const response = await fetch(VOICE_INPUT_PATH, {
        method: "POST", body: pcm, headers: { "Content-Type": "application/octet-stream" },
        signal: capture.request.signal, credentials: "same-origin",
      });
      const result = await response.json();
      if (current.current !== capture) return;
      if (!response.ok || typeof result.text !== "string") {
        const code = result.code;
        return fail(capture, code === "empty" || code === "rateLimit" || code === "capture" ? code : "unavailable");
      }
      current.current = null;
      setPhase("idle");
      onTextRef.current(result.text);
    } catch {
      fail(capture, "unavailable");
    }
  }

  function stop(capture: Capture | null = current.current) {
    if (capture && requestRecordingStop(capture, () => fail(capture, "capture"))) setPhase("processing");
  }

  async function start() {
    if (!enabled || !supported || current.current) return;
    setError(null);
    let capture: Capture;
    try {
      capture = { context: new AudioContext(), request: new AbortController() };
    } catch {
      setError("capture");
      return;
    }
    current.current = capture;
    setPhase("permission");
    onCaptureChange(true);
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      }).then(stream => {
        if (current.current === capture) capture.stream = stream;
        else stream.getTracks().forEach(track => track.stop());
        return stream;
      });
      const [stream] = await Promise.all([
        streamPromise, capture.context.resume(), capture.context.audioWorklet.addModule(VOICE_INPUT_WORKLET),
      ]);
      if (current.current !== capture) return;
      if (capture.context.sampleRate < VOICE_INPUT_SAMPLE_RATE) return fail(capture, "capture");
      const node = new AudioWorkletNode(capture.context, "newverse-voice-input", {
        channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1],
        processorOptions: { maxSamples: VOICE_INPUT_MAX_SAMPLES, targetRate: VOICE_INPUT_SAMPLE_RATE },
      });
      capture.node = node;
      node.port.onmessage = event => {
        if (event.data instanceof ArrayBuffer) void transcribe(capture, event.data);
        else fail(capture, "capture");
      };
      node.onprocessorerror = () => fail(capture, "capture");
      for (const track of stream.getTracks()) track.onended = () => fail(capture, "capture");
      capture.context.createMediaStreamSource(stream).connect(node).connect(capture.context.destination);
      capture.timer = window.setTimeout(() => stop(capture), (VOICE_INPUT_SECONDS + 1) * 1_000);
      setPhase("recording");
    } catch (cause) {
      const code = cause instanceof DOMException && cause.name === "NotAllowedError" ? "permission" : "capture";
      fail(capture, code);
    }
  }

  return { supported, phase, error, start, stop, cancel };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { MicrophoneIcon, MicrophoneSlashIcon } from "@phosphor-icons/react";

type RecognitionResult = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionResult) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type RecognitionConstructor = new () => Recognition;

function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Props = {
  disabled?: boolean;
  onTranscript: (text: string) => void;
};

/** Browser speech-to-text feeding the existing chat pipeline. Chrome and Safari only. */
export function VoiceButton({ disabled, onTranscript }: Props) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);

  useEffect(() => {
    setSupported(getRecognitionConstructor() !== null);
    return () => recognitionRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const Ctor = getRecognitionConstructor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) onTranscript(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, onTranscript]);

  // Feature-detected: Firefox has no SpeechRecognition, so offer no dead button.
  if (!supported) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      shape="square"
      aria-label={listening ? "Stop dictation" : "Dictate a message"}
      icon={
        listening ? (
          <MicrophoneSlashIcon size={18} />
        ) : (
          <MicrophoneIcon size={18} />
        )
      }
      onClick={toggle}
      disabled={disabled}
      className="mb-0.5"
    />
  );
}

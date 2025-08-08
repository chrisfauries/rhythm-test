import React, { useState, useEffect, useRef } from "react";

// --- TypeScript Type Definitions for the Web Speech API ---
// These interfaces are not part of the standard DOM library and must be defined manually.

interface SpeechRecognitionResult {
  isFinal: boolean;
  [key: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResult[];
  // Add other properties of the event if needed
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognitionStatic {
  new (): SpeechRecognition;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
}

// Extend the global Window interface
declare global {
  interface Window {
    SpeechRecognition: SpeechRecognitionStatic;
    webkitSpeechRecognition: SpeechRecognitionStatic;
  }
}

// --- Props Interface ---
interface Props {
  transcript: string;
  setTranscript: React.Dispatch<React.SetStateAction<string>>;
  isListening: boolean;
}

// --- Speech Recognition Component ---
const SpeechRecognitionComponent: React.FC<Props> = ({
  transcript,
  setTranscript,
  isListening,
}) => {
  // --- State Management ---
  // const [isListening, setIsListening] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  // --- Ref for the SpeechRecognition instance ---
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // --- Effect for Initializing and Cleaning Up the API ---
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Speech Recognition is not supported by this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    // recognition.onstart = () => setIsListening(true);
    // recognition.onend = () => setIsListening(false);
    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "not-allowed") {
        setError(
          "Microphone access was denied. Please allow microphone access in your browser settings."
        );
      } else {
        setError(`Speech recognition error: ${event.error}`);
      }
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const newTranscript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join("");
      setTranscript(newTranscript);
    };

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [setTranscript]); // Added setTranscript to dependency array as a good practice

  useEffect(() => {
    if (!recognitionRef.current) return;
    if (isListening) {
          setTranscript("");
      setError("");
      recognitionRef.current.start();
    } else {
        recognitionRef.current.stop();
    }
  }, [isListening]);

  // --- UI Event Handler ---
  const handleToggleListening = () => {};

  return (
    <div className="w-full max-w-md mx-auto p-6 md:p-8 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl space-y-6">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white">
          Speech to Text
        </h1>
      </div>

      {/* Transcript Display */}
      <div className="border border-gray-200 dark:border-gray-700 p-4 rounded-lg bg-gray-50 dark:bg-gray-700/50 min-h-[120px] flex items-center justify-center">
        <p
          className={`text-lg ${
            transcript
              ? "text-gray-800 dark:text-gray-200"
              : "text-gray-400 dark:text-gray-500"
          }`}
        >
          {transcript || "Your transcript will appear here..."}
        </p>
      </div>

      {error && <p className="text-red-500 text-center text-sm">{error}</p>}
    </div>
  );
};

export default SpeechRecognitionComponent;

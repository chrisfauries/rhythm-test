import "./App.css";
import Metronome from "./Metronome";
import Notation from "./Notation";
import { useState, useCallback, useRef, useEffect } from "react";
import SpeechRecognition from "./SpeechRecognition";
import MeydaClapDetector from "./MeydaDetector";
import HandDetector, { HandAction } from "./HandDetector";
import { quartersAndEighths } from "./data/examples/quarters-and-eigths";
import { quartersEasy } from "./data/examples/quarters-easy";

const getCountOffText = (beat: number) => {
  switch (beat) {
    case -4:
      return "One";
    case -3:
      return "Two";
    case -2:
      return "Ready";
    case -1:
      return "Go!";
    default:
      return "";
  }
};

interface NoteTiming {
  beat: number;
  time: number;
}

function App() {
  const [beat, setBeat] = useState(-5);
  const beatRef = useRef<number>(-5);
  const incrementBeat = useCallback(() => {
    let hasCalled = false;
    setBeat((x) => {
      !hasCalled && x + 1 >= 0 && updateTiming(x + 1);
      hasCalled = true;
      beatRef.current = x + 1;
      return x + 1;
    });
  }, []);

  const resetBeat = useCallback(() => {
    setBeat(-5);
    beatRef.current = -5;
  }, []);

  const [transcript, setTranscript] = useState<string>("");
  const resetTranscript = useCallback(() => {
    setTranscript("");
  }, []);

  const [isStarted, setIsStarted] = useState<boolean>(false);

  const actualNoteTimings = useRef<Array<NoteTiming>>([]);
  const clappedTimings = useRef<Array<NoteTiming>>([]);
  const handPositionTimings = useRef<Array<HandAction>>([]);

  const registerClappedTiming = useCallback(() => {
    console.log("registering clapped timing", beatRef.current);
    if (beatRef.current < 0) return;
    const now = Math.round(((Date.now() / 1000) % 1000) * 100) / 100;
    clappedTimings.current.push({ beat: beatRef.current, time: now });
  }, []);

  useEffect(() => {
    if (!isStarted) {
      console.log(`Acutal note timings:`, actualNoteTimings.current);
      actualNoteTimings.current = [];
      console.log(`clapped note timings:`, clappedTimings.current);
      clappedTimings.current = [];
    }
  }, [isStarted]);

  const updateTiming = (beat: number) => {
    const now = Math.round(((Date.now() / 1000) % 1000) * 100) / 100;
    actualNoteTimings.current.push({ beat: beat, time: now });
  };

  return (
    <div className="App">
      <div className="flex justify-center mt-8">
        <Notation beat={beat} notesToRender={quartersEasy} />
      </div>

      <button
        className="w-full py-4 px-4 rounded-xl text-xl font-semibold text-white transition-all duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-opacity-50
                        bg-blue-500 hover:bg-blue-600 focus:ring-blue-400"
        onClick={() => {
          setIsStarted((x) => !x);
        }}
      >
        {isStarted ? "Stop" : "Start"}
      </button>

      {beat < 0 && <h2 className="bg-gray-100 dark:bg-gray-900 text-6xl text-white pt-16">{getCountOffText(beat)}</h2>}

      <div className="flex justify-around items-center space-x-4 bg-gray-100 dark:bg-gray-900 min-h-screen">
        <Metronome
          incrementBeat={incrementBeat}
          resetBeat={resetBeat}
          isPlaying={isStarted}
        />
        <SpeechRecognition
          transcript={transcript}
          setTranscript={setTranscript}
          isListening={isStarted}
        />
        <MeydaClapDetector
          isListening={isStarted}
          registerClappedTiming={registerClappedTiming}
        />
        <HandDetector handPositions={handPositionTimings.current} />
      </div>
    </div>
  );
}

export default App;

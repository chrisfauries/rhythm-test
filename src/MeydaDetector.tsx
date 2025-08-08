import React, { useState, useEffect, useRef } from 'react';
import Meyda from 'meyda';
import { MeydaAnalyzer } from 'meyda/dist/esm/meyda-wa';

// --- Meyda-based Clap Detection Thresholds ---
const BASE_RMS_THRESHOLD = 0.03;
const BASE_SPECTRAL_FLUX_THRESHOLD = 3.5; 
// MODIFIED: Lowered to allow fuller, lower-pitched claps.
const SPECTRAL_CENTROID_LOWER_BOUND = 40; 
const SPECTRAL_CENTROID_UPPER_BOUND = 140; 


// --- Adaptive Logic & Rhythm Timing ---
// MODIFIED: Increased again to prevent the echo of loud claps from double-triggering.
const MIN_TIME_BETWEEN_CLAPS_MS = 150; 
const CLAP_RESET_TIME_MS = 800;
const AGC_RECOVERY_TIME_MS = 400; 
// Ratio for adapting spectral flux.
const ADAPTIVE_FLUX_THRESHOLD_RATIO = 0.6; 
// Ratio for adapting RMS to overcome microphone AGC.
const ADAPTIVE_RMS_THRESHOLD_RATIO = 0.7;


// The adaptive logic now targets both RMS and spectral flux.
interface MeydaApiRefs {
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  meydaAnalyzer: MeydaAnalyzer | null;
  lastClapTime: number;
  clapResetTimeout: NodeJS.Timeout | null;
  agcRecoveryTimeout: NodeJS.Timeout | null;
  adaptiveSpectralFluxThreshold: number;
  adaptiveRmsThreshold: number;
}

interface Props {
  isListening: boolean;
  registerClappedTiming: () => void;
}

// --- Main App Component ---
const MeydaClapDetector: React.FC<Props> = ({
  isListening,
  registerClappedTiming,
}) => {
  const [statusText, setStatusText] = useState("Idle");
  const [clapCount, setClapCount] = useState(0);
  const [feedbackClass, setFeedbackClass] = useState("");

  const audioApi = useRef<MeydaApiRefs>({
    context: null,
    source: null,
    meydaAnalyzer: null,
    lastClapTime: 0,
    clapResetTimeout: null,
    agcRecoveryTimeout: null,
    adaptiveSpectralFluxThreshold: BASE_SPECTRAL_FLUX_THRESHOLD,
    adaptiveRmsThreshold: BASE_RMS_THRESHOLD,
  });

  // Effect for handling the "clap" custom event for UI feedback
  useEffect(() => {
    const handleClap = () => {
      triggerFeedback();
      setClapCount((prevCount) => prevCount + 1);

      if (audioApi.current.clapResetTimeout) {
        clearTimeout(audioApi.current.clapResetTimeout);
      }
      audioApi.current.clapResetTimeout = setTimeout(() => {
        setClapCount(0);
      }, CLAP_RESET_TIME_MS);
    };

    window.addEventListener("clap", handleClap);
    return () => {
      window.removeEventListener("clap", handleClap);
      if (audioApi.current.clapResetTimeout) {
        clearTimeout(audioApi.current.clapResetTimeout);
      }
    };
  }, []);

  // Main effect for starting and stopping the Meyda analyzer
  useEffect(() => {
    const startAnalyzer = async () => {
      try {
        // Reset adaptive thresholds on start
        audioApi.current.adaptiveSpectralFluxThreshold = BASE_SPECTRAL_FLUX_THRESHOLD;
        audioApi.current.adaptiveRmsThreshold = BASE_RMS_THRESHOLD;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const context = new window.AudioContext();
        if (context.state === "suspended") await context.resume();
        const source = context.createMediaStreamSource(stream);

        audioApi.current.context = context;
        audioApi.current.source = source;

        const meydaAnalyzer = Meyda.createMeydaAnalyzer({
          audioContext: context,
          source: source,
          bufferSize: 1024, // Standard buffer size
          featureExtractors: ["rms", "spectralFlux", "spectralCentroid"],
          callback: (features: any) => {
            if (!isListening) return;

            const { rms, spectralFlux, spectralCentroid } = features;
            const currentTime = Date.now();

            // --- REFINED: Core Clap Detection Logic ---
            const isClap =
              spectralFlux > audioApi.current.adaptiveSpectralFluxThreshold &&
              rms > audioApi.current.adaptiveRmsThreshold && // Uses adaptive RMS now
              spectralCentroid > SPECTRAL_CENTROID_LOWER_BOUND &&
              spectralCentroid < SPECTRAL_CENTROID_UPPER_BOUND &&
              currentTime - audioApi.current.lastClapTime > MIN_TIME_BETWEEN_CLAPS_MS;

            if (isClap) {
              console.log(`Clap! RMS: ${rms.toFixed(3)}, Flux: ${spectralFlux.toFixed(2)}, Centroid: ${spectralCentroid.toFixed(2)}`);
              
              audioApi.current.lastClapTime = currentTime;
              registerClappedTiming();
              window.dispatchEvent(new CustomEvent("clap"));

              // Temporarily lower BOTH thresholds after a clap.
              audioApi.current.adaptiveSpectralFluxThreshold = BASE_SPECTRAL_FLUX_THRESHOLD * ADAPTIVE_FLUX_THRESHOLD_RATIO;
              audioApi.current.adaptiveRmsThreshold = BASE_RMS_THRESHOLD * ADAPTIVE_RMS_THRESHOLD_RATIO;
              
              if (audioApi.current.agcRecoveryTimeout) {
                  clearTimeout(audioApi.current.agcRecoveryTimeout);
              }

              // This timeout now resets BOTH thresholds.
              audioApi.current.agcRecoveryTimeout = setTimeout(() => {
                  audioApi.current.adaptiveSpectralFluxThreshold = BASE_SPECTRAL_FLUX_THRESHOLD;
                  audioApi.current.adaptiveRmsThreshold = BASE_RMS_THRESHOLD;
              }, AGC_RECOVERY_TIME_MS);
            }
          },
        });

        audioApi.current.meydaAnalyzer = meydaAnalyzer;
        meydaAnalyzer.start();
        setStatusText("Listening");

      } catch (err) {
        console.error("Error starting Meyda analyzer:", err);
        setStatusText("Mic access denied");
      }
    };

    const stopAnalyzer = () => {
      if(audioApi.current.agcRecoveryTimeout){
        clearTimeout(audioApi.current.agcRecoveryTimeout);
      }
      if (audioApi.current.meydaAnalyzer) {
        audioApi.current.meydaAnalyzer.stop();
      }
      if (audioApi.current.source) {
        audioApi.current.source.disconnect();
      }
      if (audioApi.current.context && audioApi.current.context.state !== "closed") {
        audioApi.current.context.close();
      }
       setStatusText("Idle");
    };

    if (isListening) {
      startAnalyzer();
    } else {
      stopAnalyzer();
    }

    // Cleanup function
    return stopAnalyzer;
  }, [isListening, registerClappedTiming]);

  const triggerFeedback = () => {
    setStatusText("Clap!");
    setFeedbackClass("feedback-clap");

    setTimeout(() => {
      setFeedbackClass("");
      if (isListening) {
        setStatusText("Listening");
      }
    }, 300);
  };

  return (
    <div className="bg-gray-900 text-white flex items-center justify-center font-sans">
      <div className="w-full max-w-md mx-auto p-8 rounded-2xl bg-gray-800 shadow-2xl text-center">
        <h1 className="text-4xl font-bold mb-2">Clap Detector</h1>
  
        <div
          id="feedback-circle"
          className={`w-48 h-48 bg-gray-700 rounded-full mx-auto my-6 flex flex-col items-center justify-center transition-all duration-100 ease-in-out ${feedbackClass}`}
        >
          <span id="status-text" className="text-2xl font-medium text-gray-300">
            {statusText}
          </span>
          {clapCount > 0 && (
            <span className="text-5xl font-bold text-white mt-2">
              {clapCount}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 h-4">
            {isListening ? "Microphone is active." : ""}
        </p>
      </div>

      <style>{`
          .feedback-clap {
            background-color: #FBBF24 !important; /* Tailwind amber-400 */
            transform: scale(1.1);
            box-shadow: 0 0 40px #FBBF24;
          }
          body {
            font-family: 'Inter', sans-serif;
          }
        `}</style>
    </div>
  );
};

export default MeydaClapDetector;

// import React, { useState, useEffect, useRef } from "react";

// // --- Clap Detection Thresholds ---
// const BASE_AMPLITUDE_THRESHOLD = 180;
// // The RMS energy threshold. This scale is different from the previous average.
// // A good starting point is between 15 and 25.
// const RMS_ENERGY_THRESHOLD = 15;

// // --- Adaptive Logic & Overlap Constants ---
// const AGC_RECOVERY_TIME_MS = 1500;
// const ADAPTIVE_THRESHOLD_RATIO = 0.7;
// const SCRIPT_PROCESSOR_BUFFER_SIZE = 1024;
// const OVERLAP_BUFFER_SIZE = 256;

// // --- Rhythm timing ---
// const MIN_TIME_BETWEEN_CLAPS_MS = 50;
// const CLAP_RESET_TIME_MS = 500;

// interface AudioApiRefs {
//   context: AudioContext | null;
//   analyser: AnalyserNode | null;
//   source: MediaStreamAudioSourceNode | null;
//   scriptProcessor: ScriptProcessorNode | null;
//   lastClapTime: number;
//   clapResetTimeout: NodeJS.Timeout | null;
//   historyBuffer: Uint8Array;
//   adaptiveThreshold: number;
//   agcRecoveryTimeout: NodeJS.Timeout | null;
// }

// interface Props {
//   isListening: boolean;
//   registerClappedTiming: () => void;

// }

// // --- Main App Component ---
// const ClapDetector: React.FC<Props> = ({
//   isListening,
//   registerClappedTiming,

// }) => {
//   // const [isListening, setIsListening] = useState(false);
//   const [statusText, setStatusText] = useState("Idle");
//   const [clapCount, setClapCount] = useState(0);
//   const [feedbackClass, setFeedbackClass] = useState("");

//   const audioApi = useRef<AudioApiRefs>({
//     context: null,
//     analyser: null,
//     source: null,
//     scriptProcessor: null,
//     lastClapTime: 0,
//     clapResetTimeout: null,
//     historyBuffer: new Uint8Array(OVERLAP_BUFFER_SIZE),
//     adaptiveThreshold: BASE_AMPLITUDE_THRESHOLD,
//     agcRecoveryTimeout: null,
//   });

//   useEffect(() => {
//     const handleClap = () => {
//       triggerFeedback();
//       setClapCount((prevCount) => prevCount + 1);

//       if (audioApi.current.clapResetTimeout) {
//         clearTimeout(audioApi.current.clapResetTimeout);
//       }
//       audioApi.current.clapResetTimeout = setTimeout(() => {
//         setClapCount(0);
//       }, CLAP_RESET_TIME_MS);
//     };

//     window.addEventListener("clap", handleClap);
//     return () => {
//       window.removeEventListener("clap", handleClap);
//       if (audioApi.current.clapResetTimeout) {
//         clearTimeout(audioApi.current.clapResetTimeout);
//       }
//     };
//   }, []);

//   useEffect(() => {
//     const startAnalyzer = async () => {
//       try {
//         audioApi.current.adaptiveThreshold = BASE_AMPLITUDE_THRESHOLD;

//         const stream = await navigator.mediaDevices.getUserMedia({
//           audio: true,
//           video: false,
//         });

//         const context = new window.AudioContext();
//         if (context.state === "suspended") await context.resume();
//         audioApi.current.context = context;

//         const source = context.createMediaStreamSource(stream);
//         const analyser = context.createAnalyser();
//         analyser.fftSize = SCRIPT_PROCESSOR_BUFFER_SIZE * 2;

//         const scriptProcessor = context.createScriptProcessor(
//           SCRIPT_PROCESSOR_BUFFER_SIZE,
//           1,
//           1
//         );

//         audioApi.current.source = source;
//         audioApi.current.analyser = analyser;
//         audioApi.current.scriptProcessor = scriptProcessor;

//         scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
//           if (!isListening) return;

//           const newData = new Uint8Array(analyser.frequencyBinCount);
//           analyser.getByteTimeDomainData(newData);

//           const combinedData = new Uint8Array(
//             newData.length + OVERLAP_BUFFER_SIZE
//           );
//           combinedData.set(audioApi.current.historyBuffer, 0);
//           combinedData.set(newData, OVERLAP_BUFFER_SIZE);

//           audioApi.current.historyBuffer.set(
//             newData.slice(-OVERLAP_BUFFER_SIZE)
//           );

//           // --- CORRECTED ENERGY CALCULATION (RMS) ---
//           let sumOfSquares = 0;
//           let peakInstantaneous = 0;
//           for (let i = 0; i < combinedData.length; i++) {
//             const deviation = combinedData[i] - 128; // Deviation can be signed
//             sumOfSquares += deviation * deviation; // Square the deviation

//             const absDeviation = Math.abs(deviation);
//             if (absDeviation > peakInstantaneous)
//               peakInstantaneous = absDeviation;
//           }

//           const peakByte = 128 + peakInstantaneous;
//           const rmsEnergy = Math.sqrt(sumOfSquares / combinedData.length); // Take the square root of the average

//           const currentTime = Date.now();

//           if (peakByte > 150 || rmsEnergy > 10) {
//             console.log(
//               `Peak: ${peakByte}, RMS Energy: ${rmsEnergy.toFixed(2)}`
//             );
//           }

//           if (
//             peakByte > audioApi.current.adaptiveThreshold &&
//             rmsEnergy > RMS_ENERGY_THRESHOLD &&
//             currentTime - audioApi.current.lastClapTime >
//               MIN_TIME_BETWEEN_CLAPS_MS
//           ) {
//             console.log(
//               `Clap registered!, Peak: ${peakByte}, RMS Energy: ${rmsEnergy.toFixed(
//                 2
//               )}`
//             );
//             registerClappedTiming();
//             audioApi.current.lastClapTime = currentTime;
//             window.dispatchEvent(new CustomEvent("clap"));

//             audioApi.current.adaptiveThreshold =
//               BASE_AMPLITUDE_THRESHOLD * ADAPTIVE_THRESHOLD_RATIO;

//             if (audioApi.current.agcRecoveryTimeout) {
//               clearTimeout(audioApi.current.agcRecoveryTimeout);
//             }
//             audioApi.current.agcRecoveryTimeout = setTimeout(() => {
//               console.log("resetting agc threshold");
//               audioApi.current.adaptiveThreshold = BASE_AMPLITUDE_THRESHOLD;
//             }, AGC_RECOVERY_TIME_MS);
//           }
//         };

//         source.connect(analyser);
//         analyser.connect(scriptProcessor);
//         scriptProcessor.connect(context.destination);
//       } catch (err) {
//         console.error("Error starting audio:", err);
//         setStatusText("Mic access denied");
//         // setIsListening(false);
//       }
//     };

//     const stopAnalyzer = () => {
//       if (audioApi.current.agcRecoveryTimeout) {
//         clearTimeout(audioApi.current.agcRecoveryTimeout);
//       }
//       if (audioApi.current.scriptProcessor) {
//         audioApi.current.scriptProcessor.disconnect();
//         audioApi.current.scriptProcessor.onaudioprocess = null;
//       }
//       if (audioApi.current.source) audioApi.current.source.disconnect();
//       if (audioApi.current.context) audioApi.current.context.close();

//       Object.assign(audioApi.current, {
//         context: null,
//         analyser: null,
//         source: null,
//         scriptProcessor: null,
//         agcRecoveryTimeout: null,
//       });
//     };

//     if (isListening) {
//       startAnalyzer();
//     }

//     return stopAnalyzer;
//   }, [isListening]);

//   const triggerFeedback = () => {
//     setStatusText("Clap!");
//     setFeedbackClass("feedback-clap");

//     setTimeout(() => {
//       setFeedbackClass("");
//       if (isListening) {
//         setStatusText("Listening");
//       }
//     }, 300);
//   };

//   const handleToggleListening = () => {
//     const nextIsListening = !isListening;
//     // setIsListening(nextIsListening);

//     if (nextIsListening) {
//       setStatusText("Listening");
//       setClapCount(0);
//     } else {
//       setStatusText("Idle");
//     }
//   };

//   return (
//     <div className="bg-gray-900 text-white flex items-center justify-center font-sans">
//       <div className="w-full max-w-md mx-auto p-8 rounded-2xl bg-gray-800 shadow-2xl text-center">
//         <h1 className="text-4xl font-bold mb-2">Clap Detector</h1>
//         <p className="text-gray-400 mb-6">
//           Detects rhythmic claps using the Web Audio API.
//         </p>

//         <div
//           id="feedback-circle"
//           className={`w-48 h-48 bg-gray-700 rounded-full mx-auto my-6 flex flex-col items-center justify-center transition-all duration-100 ease-in-out ${feedbackClass}`}
//         >
//           <span id="status-text" className="text-2xl font-medium text-gray-300">
//             {statusText}
//           </span>
//           {clapCount > 0 && (
//             <span className="text-5xl font-bold text-white mt-2">
//               {clapCount}
//             </span>
//           )}
//         </div>

//         {/* <div id="message" className="text-xl h-10 mb-6 text-gray-400">
//                     {isListening ? `Listening for claps...` : `Click 'Start' to begin`}
//                 </div> */}

//         {/* <button 
//                     id="start-button" 
//                     onClick={handleToggleListening}
//                     className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg text-lg transition-transform transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-blue-500"
//                 >
//                     {isListening ? 'Stop Listening' : 'Start Listening'}
//                 </button> */}
//       </div>

//       <style>{`
//                 .feedback-clap {
//                     background-color: #FBBF24 !important; /* Tailwind amber-400 */
//                     transform: scale(1.1);
//                     box-shadow: 0 0 40px #FBBF24;
//                 }
//                 body {
//                     font-family: 'Inter', sans-serif;
//                 }
//             `}</style>
//     </div>
//   );
// };

// export default ClapDetector;

export {};
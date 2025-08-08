import React, { useState, useEffect, useRef } from 'react';
import * as Tone from 'tone';

// Helper component for Beat visualization
const BeatIndicator = ({ beat, isPlaying }: { beat: boolean; isPlaying: boolean }) => {
    const baseClasses = "w-8 h-8 md:w-10 md:h-10 rounded-full transition-all duration-100";
    const activeClasses = "bg-blue-500 scale-110 shadow-lg";
    const inactiveClasses = "bg-gray-300 dark:bg-gray-600";
    const mutedClasses = "bg-gray-200 dark:bg-gray-700";

    return (
        <div className={`${baseClasses} ${isPlaying && beat ? activeClasses : (isPlaying ? inactiveClasses : mutedClasses)}`}></div>
    );
};

interface Props {
  incrementBeat: () => void;
  resetBeat: () => void;
  isPlaying: boolean;
}


// Main Metronome App Component
const Metronome: React.FC<Props> = ({ incrementBeat, resetBeat, isPlaying }) => { 
    // State for the metronome's status and settings
    const [tempo, setTempo] = useState(72);
    const [currentBeat, setCurrentBeat] = useState(0); // 0 = stopped, 1-4 for beats

    // Refs to hold Tone.js objects. useRef is used to persist these objects across re-renders without causing them.
    const loopRef = useRef<Tone.Loop<Tone.LoopOptions> | null>(null);
    const synthRef = useRef<Tone.Synth<Tone.SynthOptions> | null>(null);

    // Effect to initialize the synthesizer. This runs only once when the component mounts.
    useEffect(() => {
        // Using MembraneSynth for a classic metronome "tick" sound.
        synthRef.current = 
        new Tone.Synth({
            
        oscillator: {
            type: "sine", // A simple, clean waveform
        },
        envelope: {
            attack: 0.001, // Start the sound immediately
            decay: 0.03,    // A very short decay to create the "tick"
            sustain: 0,    // No sustained tone
            release: 0.1,  // A short release
        },
    }).toDestination();
        
        // Set initial BPM value for the transport
        Tone.Transport.bpm.value = tempo;

        // Cleanup on unmount
        return () => {
            if (synthRef.current) {
                synthRef.current.dispose();
            }
        };
    }, []); // Empty dependency array ensures this runs only once

    // This effect handles the core logic of starting and stopping the metronome loop.
    // It runs whenever the `isPlaying` state changes.
    useEffect(() => {
        // If the metronome should be playing...
        if (isPlaying) {
            // Create a new Tone.Loop if one doesn't already exist.
            loopRef.current = new Tone.Loop(time => {
                // This callback is executed on every beat.
                // 'time' is the exact time the event is scheduled to occur.
                
                // Trigger the synth sound. 'C2' is the pitch, '8n' is the duration.
                synthRef.current?.triggerAttackRelease('A5', '32n', time);

                // Use Tone.Draw.schedule to synchronize visual updates with the audio thread.
                // This ensures the visual beat indicator is perfectly in time with the sound.
                Tone.Draw.schedule(() => {
                    setCurrentBeat(prev => (prev % 4) + 1);
                    incrementBeat();
                }, time);

            }, '4n').start(0); // '4n' means every quarter note. .start(0) starts the loop immediately.

            // Start the Tone.js Transport, which is the master clock.
            Tone.Transport.start();
        } else {
            // If the metronome should stop...
            // Stop the transport, which also stops the loop.
            Tone.Transport.stop();
            // Cancel any scheduled events to be safe.
            Tone.Transport.cancel();
            // Dispose of the loop to clean up resources.
            if (loopRef.current) {
                loopRef.current.dispose();
            }
            // Reset the visual beat counter.
            setCurrentBeat(0);
            resetBeat();
        }

        // Cleanup function for this effect.
        return () => {
            if (loopRef.current) {
                loopRef.current.dispose();
            }
            Tone.Transport.stop();
            Tone.Transport.cancel();
        };
    }, [isPlaying]);

    // This effect updates the tempo (BPM) of the Tone.js Transport
    // whenever the `tempo` state changes.
    useEffect(() => {
        Tone.Transport.bpm.value = tempo;
    }, [tempo]);

    // Handler for the Start/Stop button.
    const handleStartStop = async () => {
        // Tone.js requires a user interaction to start the audio context.
        // This ensures audio will play when the user expects it.
        if (Tone.context.state !== 'running') {
            await Tone.start();
        }
        // Toggle the playing state.
        // setIsPlaying(!isPlaying);
    };

    // Handler for the tempo slider input.
    const handleTempoChange = (e: any) => {
        setTempo(parseInt(e.target.value, 10));
    };

    return (
        <div className="bg-gray-100 dark:bg-gray-900 flex items-center justify-center font-sans text-gray-800 dark:text-gray-200 min-w-[500px]">
            <div className="w-full max-w-md mx-auto p-6 md:p-8 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl space-y-8">
                
                {/* Header */}
                <div className="text-center">
                    <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white">Metronome</h1>
                </div>

                {/* Beat Visualizer */}
                <div className="flex justify-center items-center space-x-4">
                    {[1, 2, 3, 4].map(beat => (
                        <BeatIndicator key={beat} beat={currentBeat === beat} isPlaying={isPlaying} />
                    ))}
                </div>

                {/* Tempo Display */}
                <div className="text-center">
                    <span className="text-6xl md:text-7xl font-bold text-blue-600 dark:text-blue-400 tracking-tighter">
                        {tempo}
                    </span>
                    <span className="text-xl font-medium text-gray-500 dark:text-gray-400 ml-2">BPM</span>
                </div>

                {/* Tempo Slider */}
                <div className="space-y-3">
                    <label htmlFor="tempo" className="sr-only">Tempo</label>
                    <input
                        type="range"
                        id="tempo"
                        min="50"
                        max="200"
                        value={tempo}
                        onChange={handleTempoChange}
                        className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer range-lg"
                    />
                </div>

                {/* Control Button */}
                <div>
                    {/* <button
                        onClick={handleStartStop}
                        className={`w-full py-4 px-4 rounded-xl text-xl font-semibold text-white transition-all duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-opacity-50
                        ${isPlaying ? 'bg-red-500 hover:bg-red-600 focus:ring-red-400' : 'bg-blue-500 hover:bg-blue-600 focus:ring-blue-400'}`}
                    >
                        {isPlaying ? 'Stop' : 'Start'}
                    </button> */}
                </div>
            </div>
        </div>
    );
}

export default Metronome;
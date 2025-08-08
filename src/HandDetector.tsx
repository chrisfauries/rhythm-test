import React, { useEffect, useRef, useState } from 'react';
import { Hands, HAND_CONNECTIONS, Results } from '@mediapipe/hands';
import { drawConnectors, drawLandmarks } from '@mediapipe/drawing_utils';

export interface HandAction {
  time: number;
  action: 'apart' | 'clapping' | 'together' | 'separating' | 'none';
}

interface Props {
  handPositions: HandAction[];
}

const CLAP_THRESHOLD = 0.12;
const APART_THRESHOLD = 0.35;
const DISTANCE_TOLERANCE = 0.02;

const getDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
};

const HandTracker: React.FC<Props> = ({ handPositions }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [numHands, setNumHands] = useState(0);
  const [currentAction, setCurrentAction] = useState<HandAction>({
    time: Date.now(),
    action: 'none',
  });

  const lastHandPosition = useRef<HandAction>({
    time: Date.now(),
    action: 'none',
  });
  const prevNumHands = useRef<number>(0);
  const lastDistance = useRef<number | null>(null);

  useEffect(() => {
    const setup = async () => {
      const videoElement = videoRef.current!;
      const canvasElement = canvasRef.current!;
      const canvasCtx = canvasElement.getContext('2d')!;

      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoElement.srcObject = stream;

      videoElement.onloadedmetadata = async () => {
        try {
          await videoElement.play();
        } catch (err) {
          console.error('Error playing video:', err);
          return;
        }

        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;

        const hands = new Hands({
          locateFile: (file) =>
            `${process.env.PUBLIC_URL}/mediapipe/hands/${file}`,
        });

        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.5,
        });

        hands.onResults((results: Results) => {
          canvasCtx.save();
          canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
          canvasCtx.drawImage(
            results.image,
            0,
            0,
            canvasElement.width,
            canvasElement.height
          );

          const handLandmarks = results.multiHandLandmarks || [];
          const newNumHands = handLandmarks.length;
          setNumHands(newNumHands);

          for (const landmarks of handLandmarks) {
            drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
              color: '#00FF00',
              lineWidth: 2,
            });
            drawLandmarks(canvasCtx, landmarks, {
              color: '#FF0000',
              lineWidth: 1,
            });
          }

          const now = Date.now();
          const prevAction = lastHandPosition.current.action;
          let newAction: HandAction = { time: now, action: prevAction };

          if (newNumHands === 0) {
            newAction.action = 'none';
            lastDistance.current = null;
          } else if (newNumHands === 2) {
            const [hand1, hand2] = handLandmarks;
            const palm1 = hand1[9];
            const palm2 = hand2[9];
            const distance = getDistance(palm1, palm2);

            if (distance < CLAP_THRESHOLD) {
              newAction.action = 'together';
            } else if (lastDistance.current !== null) {
              const change = distance - lastDistance.current;

              if (change < -DISTANCE_TOLERANCE) {
                newAction.action = 'clapping';
              } else if (change > DISTANCE_TOLERANCE) {
                newAction.action = 'separating';
              } else if (distance > APART_THRESHOLD) {
                newAction.action = 'apart';
              } else {
                newAction.action = prevAction;
              }
            } else {
              if (distance > APART_THRESHOLD) {
                newAction.action = 'apart';
              } else {
                newAction.action = prevAction;
              }
            }

            lastDistance.current = distance;
          } else if (newNumHands === 1) {
            if (
              prevNumHands.current === 2 &&
              prevAction === 'clapping'
            ) {
              newAction.action = 'together';
            } else if (
              prevNumHands.current === 2 &&
              prevAction === 'apart'
            ) {
              newAction.action = 'none';
            } else {
              // Keep current action
              newAction.action = prevAction;
            }
          }

          if (newAction.action !== prevAction) {
            lastHandPosition.current = newAction;
            handPositions.push(newAction);
            setCurrentAction(newAction);
          }

          prevNumHands.current = newNumHands;
          canvasCtx.restore();
        });

        const cameraLoop = async () => {
          if (
            videoElement.readyState >= 2 &&
            videoElement.videoWidth > 0 &&
            videoElement.videoHeight > 0
          ) {
            await hands.send({ image: videoElement });
          }
          requestAnimationFrame(cameraLoop);
        };

        cameraLoop();
      };
    };

    setup();
  }, [handPositions]);

  return (
        <div className="bg-gray-900 text-white flex items-center justify-center font-sans min-w-[700px]">
      <div className="w-full max-w-md mx-auto p-8 rounded-2xl bg-gray-800 shadow-2xl text-center min-w-[700px]">
      <video
        ref={videoRef}
        style={{ visibility: 'hidden', position: 'absolute', top: 0, left: 0 }}
        playsInline
        muted
      />
      <canvas ref={canvasRef} style={{ width: '640px', height: '480px' }} />
      <p style={{ fontSize: '1.5rem' }}>Hands Detected: {numHands}</p>
      <p style={{ fontSize: '1.25rem' }}>
        Current Action: <strong>{currentAction.action}</strong>
      </p>
    </div>
    </div>
  );
};

export default HandTracker;

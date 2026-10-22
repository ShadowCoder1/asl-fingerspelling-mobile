/* camera.js: turns on the webcam and hands back a playing <video> element.
 *
 * You almost never need to edit this file. */

/**
 * Ask the browser for camera access and start streaming into a <video>.
 *
 * @param {{width:number, height:number}} size  requested resolution (a hint, *        the browser may give you something close but not exact)
 * @returns {Promise<HTMLVideoElement>} a video element that is already playing
 * @throws {Error} with a human-readable .message explaining what to tell the
 *         participant (denied permission, no camera, camera already in use...)
 */
export async function startCamera(size = { width: 640, height: 480 }) {
  if (!window.isSecureContext) {
    throw new Error(
      "Browsers only allow camera access over HTTPS. Open this page through " +
      "https://... or http://localhost, not as a file:// path."
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "This browser does not support webcam capture. Please use a recent " +
      "version of Chrome, Edge, Firefox, or Safari."
    );
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width:  { ideal: size.width },
        height: { ideal: size.height },
        facingMode: "user",
      },
    });
  } catch (err) {
    throw new Error(explainCameraError(err));
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;   // stops iOS from going fullscreen
  video.muted = true;
  video.srcObject = stream;

  // Wait until we actually know the frame size, otherwise the first few
  // MediaPipe calls get a 0x0 image and throw.
  await new Promise((resolve) => {
    if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
    video.onloadeddata = () => resolve();
  });
  await video.play();

  return video;
}

/** Stop the camera and turn off the recording light. */
export function stopCamera(video) {
  video?.srcObject?.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
}

/** Turn a raw getUserMedia error into something a participant can act on. */
function explainCameraError(err) {
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied. Click the camera icon in your " +
             "browser's address bar, choose Allow, then reload this page.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No webcam was found. Please connect a camera and reload.";
    case "NotReadableError":
      return "Your camera is already being used by another program. Close " +
             "Zoom, Teams, Photo Booth, or any other video app and reload.";
    default:
      return `Could not start the camera (${err?.name || "unknown error"}: ` +
             `${err?.message || ""}).`;
  }
}

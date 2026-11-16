export const START_TIMEOUT_MS = 5000;
export const FADE_SECONDS = 0.04;

// Observe late rejection too, and release a resource that finishes after its caller gave up.
export function bounded(work, milliseconds = START_TIMEOUT_MS, release = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(Error('Audio processing timed out. Try again or choose Lightweight.'));
    }, milliseconds);
    Promise.resolve(work).then(
      (value) => {
        if (settled) {
          release(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
export const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

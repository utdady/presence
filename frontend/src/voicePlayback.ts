/** One voice bubble plays at a time across hub + Nearby. */

type StopFn = () => void

let activeStop: StopFn | null = null

export function claimVoicePlayback(stop: StopFn): void {
  if (activeStop && activeStop !== stop) {
    try {
      activeStop()
    } catch {
      /* ignore */
    }
  }
  activeStop = stop
}

export function releaseVoicePlayback(stop: StopFn): void {
  if (activeStop === stop) activeStop = null
}

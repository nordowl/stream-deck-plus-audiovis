import streamDeck from "@elgato/streamdeck"
import { DemoAudioSource } from "./demo-source"
import { WasapiAudioSource } from "./wasapi-source"
import { renderVisualizerFrame, THEME_NAMES } from "../renderer/visualizer-renderer"

const logger = streamDeck.logger.createScope("AudioEngine")

/**
 * Total number of frequency bins across all 4 dial positions.
 * Kept low — cubic interpolation in the renderer makes even 8 points
 * per dial look like a smooth organic wave.
 */
const TOTAL_BINS = 20

/**
 * Number of control points rendered per dial position.
 */
const BARS_PER_DIAL = 5

/**
 * Target frame rate for the visualizer.
 */
const TARGET_FPS = 20
const FRAME_INTERVAL = Math.round(1000 / TARGET_FPS)

/**
 * Change detection: only send a frame when bins moved by at least this amount.
 * This prevents flooding the Stream Deck host with identical images
 * and is the primary defense against host-side RAM accumulation.
 * Value of 0.015 ≈ 1.5 pixel movement on a 96px-tall strip.
 */
const DIRTY_THRESHOLD = 0.015

/**
 * Smoothing factor for temporal interpolation.
 * Trap Nation style = heavy damping, waveform moves like thick liquid
 * but still responsive enough to show bass transients.
 *
 * SMOOTH_ATTACK: how much of a new peak is absorbed per frame.
 *   Higher = faster rise = more responsive to beats.
 * SMOOTH_DECAY: multiplier on falling values per frame.
 *   Higher (closer to 1) = values linger longer = smoother.
 */
const SMOOTH_ATTACK = 0.75
const SMOOTH_DECAY = 0.75

/**
 * Auto-gain: tracks recent peak level and normalizes output so quiet
 * audio still produces visible bars. Kept gentle so the natural
 * mountain shape of the spectrum is preserved (bass shouldn't clip flat).
 */
const AUTO_GAIN_ATTACK = 0.03 // How fast auto-gain rises to a new peak
const AUTO_GAIN_DECAY = 0.001 // How fast auto-gain drops when audio gets quieter
const AUTO_GAIN_MIN_PEAK = 0.08 // Minimum peak to avoid division by near-zero
const AUTO_GAIN_MAX_BOOST = 1.5 // Maximum auto-gain multiplier (reduced to prevent bass clipping)

/**
 * Spectral (cross-bin) smoothing passes. Applies a 3-tap moving average
 * to blur out jagged steps. Keep low (2) so bass variation isn't flattened
 * — log mapping already provides smooth distribution.
 */
const SPECTRAL_SMOOTH_PASSES = 1

/**
 * Represents a registered dial action that receives visualizer frames.
 */
interface RegisteredAction {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action: any // Stream Deck action reference with setFeedback
    column: number // Dial position 0-3
    /** Last-sent bin values for this dial, used for dirty detection */
    lastSent: Float32Array
    /** Last-sent edge values */
    lastLeftEdge: number
    lastRightEdge: number
}

/**
 * Central audio processing and rendering engine.
 * Coordinates between audio sources and dial actions.
 */
export class AudioEngine {
    private actions = new Map<string, RegisteredAction>()
    private intervalId: ReturnType<typeof setTimeout> | null = null
    private demoSource: DemoAudioSource
    private wasapiSource: WasapiAudioSource
    private useWasapi = false
    private smoothedBins: Float32Array
    private spectralTemp: Float32Array // Pre-allocated buffer for spectral smoothing
    private dialSlice: Float32Array // Pre-allocated buffer for per-dial bin slice
    private lastFrameTime = 0
    private gain = 1.0
    private themeIndex = 0
    private autoGainPeak = AUTO_GAIN_MIN_PEAK

    constructor() {
        this.demoSource = new DemoAudioSource()
        this.wasapiSource = new WasapiAudioSource()
        this.smoothedBins = new Float32Array(TOTAL_BINS)
        this.spectralTemp = new Float32Array(TOTAL_BINS)
        this.dialSlice = new Float32Array(BARS_PER_DIAL)
    }

    /**
     * Get the current color theme name.
     */
    get currentTheme(): string {
        return THEME_NAMES[this.themeIndex] ?? "neon"
    }

    /**
     * Get the current gain value.
     */
    get currentGain(): number {
        return this.gain
    }

    /**
     * Register a dial action to receive visualizer updates.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAction(actionId: string, action: any, column: number): void {
        this.actions.set(actionId, {
            action,
            column,
            lastSent: new Float32Array(BARS_PER_DIAL),
            lastLeftEdge: -1,
            lastRightEdge: -1,
        })
        logger.info(`Registered action ${actionId} at column ${column}`)

        if (!this.intervalId) {
            this.startLoop()
        }
    }

    /**
     * Unregister a dial action.
     */
    unregisterAction(actionId: string): void {
        this.actions.delete(actionId)
        logger.info(`Unregistered action ${actionId}`)

        if (this.actions.size === 0) {
            this.stopLoop()
        }
    }

    /**
     * Adjust the gain/sensitivity.
     */
    adjustGain(delta: number): void {
        this.gain = Math.max(0.2, Math.min(3.0, this.gain + delta))
        logger.debug(`Gain adjusted to ${this.gain.toFixed(2)}`)
    }

    /**
     * Cycle to the next color theme.
     */
    nextTheme(): void {
        this.themeIndex = (this.themeIndex + 1) % THEME_NAMES.length
        logger.info(`Theme changed to ${this.currentTheme}`)
    }

    /**
     * Start the render loop.
     * Attempts to start WASAPI capture; falls back to demo mode.
     */
    private startLoop(): void {
        // Try to start real audio capture
        if (this.wasapiSource.isAvailable()) {
            this.useWasapi = this.wasapiSource.start()
            if (this.useWasapi) {
                logger.info("Using WASAPI loopback audio capture")
            } else {
                logger.warn("WASAPI capture failed to start, using demo mode")
            }
        } else {
            logger.info("WASAPI binary not found, using demo mode")
        }

        logger.info(`Starting render loop at ${TARGET_FPS} fps`)
        this.lastFrameTime = Date.now()
        this.scheduleTick()
    }

    /**
     * Stop the render loop.
     */
    private stopLoop(): void {
        if (this.intervalId) {
            clearTimeout(this.intervalId)
            this.intervalId = null
            logger.info("Stopped render loop")
        }
    }

    /**
     * Schedule the next tick. Uses setTimeout instead of setInterval so we
     * can adaptively skip frames when nothing changed.
     */
    private scheduleTick(): void {
        this.intervalId = setTimeout(() => this.tick(), FRAME_INTERVAL)
    }

    /**
     * Single frame tick: capture audio, process, render, distribute.
     */
    private tick(): void {
        const now = Date.now()
        const deltaTime = Math.min((now - this.lastFrameTime) / 1000, 0.1)
        this.lastFrameTime = now

        // Get raw frequency data from the audio source
        let rawBins: Float32Array
        if (this.useWasapi) {
            rawBins = this.wasapiSource.getFrequencyData(TOTAL_BINS)
        } else {
            rawBins = this.demoSource.getFrequencyData(TOTAL_BINS, deltaTime)
        }

        // Auto-gain: track peak level and normalize
        let framePeak = 0
        for (let i = 0; i < TOTAL_BINS; i++) {
            if (rawBins[i] > framePeak) framePeak = rawBins[i]
        }

        // Smoothly track the peak level
        if (framePeak > this.autoGainPeak) {
            this.autoGainPeak += (framePeak - this.autoGainPeak) * AUTO_GAIN_ATTACK
        } else {
            this.autoGainPeak -= (this.autoGainPeak - Math.max(framePeak, AUTO_GAIN_MIN_PEAK)) * AUTO_GAIN_DECAY
        }
        this.autoGainPeak = Math.max(this.autoGainPeak, AUTO_GAIN_MIN_PEAK)

        // Compute auto-gain boost (capped)
        const autoBoost = Math.min(AUTO_GAIN_MAX_BOOST, 1.0 / this.autoGainPeak)

        // Apply combined gain (user gain * auto-gain)
        for (let i = 0; i < TOTAL_BINS; i++) {
            rawBins[i] = Math.min(1, rawBins[i] * this.gain * autoBoost)
        }

        // Spectral smoothing: blur adjacent bins together to eliminate
        // staircase artifacts from limited FFT resolution.
        for (let pass = 0; pass < SPECTRAL_SMOOTH_PASSES; pass++) {
            this.spectralTemp.set(rawBins)
            for (let i = 1; i < TOTAL_BINS - 1; i++) {
                rawBins[i] =
                    this.spectralTemp[i - 1] * 0.25 + this.spectralTemp[i] * 0.5 + this.spectralTemp[i + 1] * 0.25
            }
        }

        // Apply temporal smoothing (attack/decay)
        for (let i = 0; i < TOTAL_BINS; i++) {
            if (rawBins[i] > this.smoothedBins[i]) {
                // Attack: rise quickly
                this.smoothedBins[i] += (rawBins[i] - this.smoothedBins[i]) * SMOOTH_ATTACK
            } else {
                // Decay: fall smoothly
                this.smoothedBins[i] *= SMOOTH_DECAY
                if (this.smoothedBins[i] < 0.01) this.smoothedBins[i] = 0
            }
        }

        // Render and distribute to each registered action (only if changed)
        for (const [, reg] of this.actions) {
            try {
                const startBin = reg.column * BARS_PER_DIAL
                // Copy into pre-allocated slice buffer instead of .slice()
                for (let b = 0; b < BARS_PER_DIAL; b++) {
                    this.dialSlice[b] = this.smoothedBins[startBin + b]
                }

                // Get edge values from neighboring dials for seamless blending.
                // Use the AVERAGE of the two bins straddling the boundary so both
                // adjacent dials render the exact same height at their shared edge.
                // Outermost edges drop to 0 so the waveform starts/ends at the bottom.
                const leftEdge =
                    reg.column > 0 ? (this.smoothedBins[startBin - 1] + this.smoothedBins[startBin]) * 0.5 : 0
                const rightEdge =
                    reg.column < 3
                        ? (this.smoothedBins[startBin + BARS_PER_DIAL - 1] +
                              this.smoothedBins[startBin + BARS_PER_DIAL]) *
                          0.5
                        : 0

                // === Dirty detection ===
                // Only render & send if bins or edges changed enough to be visible.
                // This is the primary defense against host-side RAM accumulation —
                // during silence we send 0 images/sec instead of 20.
                let dirty = false
                for (let b = 0; b < BARS_PER_DIAL; b++) {
                    if (Math.abs(this.dialSlice[b] - reg.lastSent[b]) > DIRTY_THRESHOLD) {
                        dirty = true
                        break
                    }
                }
                if (!dirty) {
                    if (
                        Math.abs(leftEdge - reg.lastLeftEdge) > DIRTY_THRESHOLD ||
                        Math.abs(rightEdge - reg.lastRightEdge) > DIRTY_THRESHOLD
                    ) {
                        dirty = true
                    }
                }

                if (!dirty) continue // Skip — the visual hasn't changed enough

                // Update last-sent state
                reg.lastSent.set(this.dialSlice)
                reg.lastLeftEdge = leftEdge
                reg.lastRightEdge = rightEdge

                const frame = renderVisualizerFrame(
                    this.dialSlice,
                    this.currentTheme,
                    BARS_PER_DIAL,
                    leftEdge,
                    rightEdge,
                )

                reg.action.setFeedback({ canvas: frame })
            } catch (err) {
                logger.error(`Failed to update action: ${err}`)
            }
        }

        // Schedule next tick
        this.scheduleTick()
    }

    /**
     * Clean up resources.
     */
    dispose(): void {
        this.stopLoop()
        this.wasapiSource.stop()
        this.actions.clear()
    }
}

/**
 * Singleton instance of the audio engine, shared by all visualizer actions.
 */
export const audioEngine = new AudioEngine()

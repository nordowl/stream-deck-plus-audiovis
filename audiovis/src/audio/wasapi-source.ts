/**
 * WASAPI loopback audio capture for Windows.
 *
 * Spawns a companion native binary (wasapi-capture.exe) that captures system
 * audio output via WASAPI loopback and streams raw PCM float32 samples to stdout.
 *
 * The Node.js side reads the stream, performs FFT, and produces frequency bins.
 *
 * Build the companion binary:
 *   cl /EHsc /O2 wasapi-capture.cpp /link ole32.lib
 *
 * Or with MinGW:
 *   g++ -O2 -o wasapi-capture.exe wasapi-capture.cpp -lole32 -loleaut32
 */

import { ChildProcess, spawn } from "node:child_process"
import { resolve, dirname } from "node:path"
import { existsSync } from "node:fs"
import streamDeck from "@elgato/streamdeck"

const logger = streamDeck.logger.createScope("WasapiSource")

/**
 * Number of FFT bins (must be power of 2).
 * 2048 gives 23.4 Hz/bin resolution at 48kHz — excellent bass detail.
 * Combined with 50% overlapping windows, latency stays low (~21ms)
 * while frequency resolution is 8× better than 256.
 */
const FFT_SIZE = 2048
const HALF_FFT = FFT_SIZE / 2

/**
 * Hop size for overlapping windows (50% overlap).
 * FFT is recomputed every HOP_SIZE new samples, using the latest
 * FFT_SIZE samples as a sliding window. This decouples frequency
 * resolution from time resolution:
 *   - Frequency resolution = sampleRate / FFT_SIZE = 23.4 Hz
 *   - Time resolution = HOP_SIZE / sampleRate = 21.3ms
 */
const HOP_SIZE = FFT_SIZE >> 1 // 1024 samples = ~21ms at 48kHz

/**
 * Max frequency to visualize in Hz. Extended to 5kHz to show more of the spectrum
 * and create a Trap Nation-style shape that rises from bass, peaks in the mids,
 * and tapers off in the highs.
 */
const MAX_FREQ_HZ = 5000

/**
 * Goertzel target frequencies for bass detail.
 * Log-spaced more evenly to capture distinct bass regions rather than
 * clustering 5 probes between 30-50Hz where they all read the same value.
 */
const BASS_FREQS = [30, 45, 65, 90, 125, 175, 250, 350, 500]

/**
 * Crossover frequency: below this, use Goertzel data. Above, use FFT.
 */
const BASS_CROSSOVER_HZ = 550

/**
 * Sample rate is typically 48000 Hz on most Windows systems.
 * We'll read the actual rate from the WASAPI format, but default to this.
 */
let sampleRate = 48000

// ============================================================
// Pre-computed tables (built once at module load, zero runtime alloc)
// ============================================================

/** Pre-computed Hann window coefficients */
const hannCoeffs = new Float32Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) {
    hannCoeffs[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)))
}

/** Pre-computed bit-reversal permutation table */
const bitRev = new Uint16Array(FFT_SIZE)
{
    let j = 0
    bitRev[0] = 0
    for (let i = 1; i < FFT_SIZE; i++) {
        let bit = FFT_SIZE >> 1
        while (j & bit) {
            j ^= bit
            bit >>= 1
        }
        j ^= bit
        bitRev[i] = j
    }
}

/**
 * Pre-computed twiddle factors for each FFT stage.
 * Avoids all sin/cos calls during the FFT butterfly.
 */
const twiddleReal: Float32Array[] = []
const twiddleImag: Float32Array[] = []
{
    for (let len = 2; len <= FFT_SIZE; len <<= 1) {
        const halfLen = len >> 1
        const rArr = new Float32Array(halfLen)
        const iArr = new Float32Array(halfLen)
        for (let k = 0; k < halfLen; k++) {
            const angle = (-2 * Math.PI * k) / len
            rArr[k] = Math.cos(angle)
            iArr[k] = Math.sin(angle)
        }
        twiddleReal.push(rArr)
        twiddleImag.push(iArr)
    }
}

// Pre-allocated FFT working buffers
const fftReal = new Float32Array(FFT_SIZE)
const fftImag = new Float32Array(FFT_SIZE)

/**
 * Pre-computed Goertzel coefficients for each bass frequency.
 * coeff = 2 * cos(2 * PI * targetFreq / sampleRate)
 * Recomputed if sampleRate changes.
 */
let goertzelCoeffs = new Float64Array(BASS_FREQS.length)
function recomputeGoertzelCoeffs(): void {
    for (let i = 0; i < BASS_FREQS.length; i++) {
        goertzelCoeffs[i] = 2 * Math.cos((2 * Math.PI * BASS_FREQS[i]) / sampleRate)
    }
}
recomputeGoertzelCoeffs()

/** Pre-allocated array for Goertzel magnitudes */
const bassMagnitudes = new Float64Array(BASS_FREQS.length)

/**
 * In-place radix-2 FFT using pre-computed bit-reversal and twiddle factors.
 * Zero allocations, zero trig calls.
 */
function fftInPlace(): void {
    // Bit-reversal permutation
    for (let i = 0; i < FFT_SIZE; i++) {
        const j = bitRev[i]
        if (i < j) {
            const tr = fftReal[i]
            fftReal[i] = fftReal[j]
            fftReal[j] = tr
            const ti = fftImag[i]
            fftImag[i] = fftImag[j]
            fftImag[j] = ti
        }
    }

    // Butterfly stages
    let stageIdx = 0
    for (let len = 2; len <= FFT_SIZE; len <<= 1) {
        const halfLen = len >> 1
        const wR = twiddleReal[stageIdx]
        const wI = twiddleImag[stageIdx]

        for (let i = 0; i < FFT_SIZE; i += len) {
            for (let k = 0; k < halfLen; k++) {
                const evenIdx = i + k
                const oddIdx = i + k + halfLen

                const tReal = wR[k] * fftReal[oddIdx] - wI[k] * fftImag[oddIdx]
                const tImag = wR[k] * fftImag[oddIdx] + wI[k] * fftReal[oddIdx]

                fftReal[oddIdx] = fftReal[evenIdx] - tReal
                fftImag[oddIdx] = fftImag[evenIdx] - tImag
                fftReal[evenIdx] += tReal
                fftImag[evenIdx] += tImag
            }
        }
        stageIdx++
    }
}

/**
 * WASAPI loopback audio source that captures system audio on Windows.
 */
export class WasapiAudioSource {
    private process: ChildProcess | null = null
    private sampleBuffer = new Float32Array(FFT_SIZE)
    private writePos = 0
    private hopCount = 0 // samples since last FFT computation
    private magnitudes = new Float32Array(HALF_FFT)
    private running = false
    private exePath: string
    private _outputBuf: Float32Array | null = null

    constructor() {
        // Look for the companion binary in the plugin's bin directory
        const pluginDir = resolve(dirname(process.argv[1] ?? "."), "..")
        this.exePath = resolve(pluginDir, "bin", "wasapi-capture.exe")
    }

    /**
     * Check if the companion binary exists.
     */
    isAvailable(): boolean {
        return existsSync(this.exePath)
    }

    /**
     * Start capturing system audio.
     */
    start(): boolean {
        if (this.running) return true

        if (!this.isAvailable()) {
            logger.warn(`WASAPI capture binary not found at ${this.exePath}`)
            return false
        }

        try {
            this.process = spawn(this.exePath, [], {
                stdio: ["pipe", "pipe", "pipe"],
            })

            this.process.stdout?.on("data", (chunk: Buffer) => {
                this.processAudioChunk(chunk)
            })

            this.process.stderr?.on("data", (chunk: Buffer) => {
                logger.debug(`WASAPI stderr: ${chunk.toString()}`)
            })

            this.process.on("error", (err) => {
                logger.error(`WASAPI capture error: ${err.message}`)
                this.running = false
            })

            this.process.on("exit", (code) => {
                logger.info(`WASAPI capture exited with code ${code}`)
                this.running = false
            })

            this.running = true
            logger.info("WASAPI audio capture started")
            return true
        } catch (err) {
            logger.error(`Failed to start WASAPI capture: ${err}`)
            return false
        }
    }

    /**
     * Stop capturing.
     */
    stop(): void {
        if (this.process) {
            this.process.kill()
            this.process = null
        }
        this.running = false
    }

    /**
     * Process incoming raw PCM float32 audio data.
     * Uses a ring buffer with hop-based triggering for overlapping FFT windows.
     * The FFT fires every HOP_SIZE new samples, always reading the latest
     * FFT_SIZE samples — giving high frequency resolution with low latency.
     */
    private processAudioChunk(chunk: Buffer): void {
        const floatCount = Math.floor(chunk.length / 4)
        for (let i = 0; i < floatCount; i++) {
            this.sampleBuffer[this.writePos] = chunk.readFloatLE(i * 4)
            this.writePos = (this.writePos + 1) % FFT_SIZE
            this.hopCount++
            if (this.hopCount >= HOP_SIZE) {
                this.hopCount = 0
                this.computeFFT()
            }
        }
    }

    /**
     * Compute FFT on the current ring buffer and update magnitudes.
     * Reads FFT_SIZE samples starting from writePos (oldest) wrapping around.
     * Also runs Goertzel filters for targeted bass frequencies.
     */
    private computeFFT(): void {
        const start = this.writePos
        const firstLen = FFT_SIZE - start

        // Copy from ring buffer with Hann window applied (two segments, no modulo)
        for (let i = 0; i < firstLen; i++) {
            fftReal[i] = this.sampleBuffer[start + i] * hannCoeffs[i]
        }
        for (let i = 0; i < start; i++) {
            fftReal[firstLen + i] = this.sampleBuffer[i] * hannCoeffs[firstLen + i]
        }
        fftImag.fill(0)

        // Perform FFT (zero-alloc, pre-computed twiddles)
        fftInPlace()

        // Compute magnitude spectrum (first half only = positive frequencies)
        for (let i = 0; i < HALF_FFT; i++) {
            this.magnitudes[i] = Math.sqrt(fftReal[i] * fftReal[i] + fftImag[i] * fftImag[i]) / HALF_FFT
        }

        // Goertzel filters for bass frequencies on unwindowed samples
        // Read from ring buffer in two segments (same order as FFT)
        for (let f = 0; f < BASS_FREQS.length; f++) {
            const coeff = goertzelCoeffs[f]
            let s0 = 0
            let s1 = 0
            let s2 = 0

            // Segment 1: start..FFT_SIZE
            for (let i = 0; i < firstLen; i++) {
                s0 = this.sampleBuffer[start + i] + coeff * s1 - s2
                s2 = s1
                s1 = s0
            }
            // Segment 2: 0..start
            for (let i = 0; i < start; i++) {
                s0 = this.sampleBuffer[i] + coeff * s1 - s2
                s2 = s1
                s1 = s0
            }

            // Magnitude = sqrt(s1^2 + s2^2 - coeff*s1*s2) / N
            const mag = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / FFT_SIZE
            bassMagnitudes[f] = mag
        }
    }

    /**
     * Get current frequency bin data, mapped to the requested number of bins.
     * Uses logarithmic frequency mapping. Below BASS_CROSSOVER_HZ, data comes
     * from Goertzel filters (10 independent bass probes). Above, from FFT.
     *
     * @param numBins Number of output bins
     * @returns Normalized frequency data (0-1)
     */
    getFrequencyData(numBins: number): Float32Array {
        if (!this._outputBuf || this._outputBuf.length !== numBins) {
            this._outputBuf = new Float32Array(numBins)
        }
        const output = this._outputBuf
        output.fill(0)

        if (!this.running) return output

        const hzPerBin = sampleRate / FFT_SIZE

        const minFreq = 20
        const maxFreq = MAX_FREQ_HZ
        const logMin = Math.log(minFreq)
        const logMax = Math.log(maxFreq)

        for (let i = 0; i < numBins; i++) {
            const freqLo = Math.exp(logMin + (logMax - logMin) * (i / numBins))
            const freqHi = Math.exp(logMin + (logMax - logMin) * ((i + 1) / numBins))
            const freqCenter = (freqLo + freqHi) * 0.5

            let rawMag = 0

            if (freqCenter < BASS_CROSSOVER_HZ) {
                // Bass region: interpolate between nearest Goertzel probes
                let below = 0
                let above = BASS_FREQS.length - 1

                for (let g = 0; g < BASS_FREQS.length; g++) {
                    if (BASS_FREQS[g] <= freqCenter) below = g
                    if (BASS_FREQS[g] >= freqCenter && above === BASS_FREQS.length - 1) above = g
                }

                if (below === above) {
                    rawMag = bassMagnitudes[below]
                } else {
                    const range = BASS_FREQS[above] - BASS_FREQS[below]
                    const t = range > 0 ? (freqCenter - BASS_FREQS[below]) / range : 0
                    rawMag = bassMagnitudes[below] * (1 - t) + bassMagnitudes[above] * t
                }
            } else {
                // Mid/high region: use FFT with fractional bin interpolation
                const binLo = freqLo / hzPerBin
                const binHi = freqHi / hzPerBin
                const maxBin = Math.min(HALF_FFT, Math.ceil(MAX_FREQ_HZ / hzPerBin))

                let sum = 0
                let weight = 0

                const bStart = Math.floor(binLo)
                const bEnd = Math.min(Math.ceil(binHi), maxBin)

                for (let b = bStart; b < bEnd; b++) {
                    const overlapLo = Math.max(b, binLo)
                    const overlapHi = Math.min(b + 1, binHi)
                    const w = Math.max(0, overlapHi - overlapLo)

                    if (w > 0 && b >= 0 && b < HALF_FFT) {
                        sum += this.magnitudes[b] * w
                        weight += w
                    }
                }

                rawMag = weight > 0 ? sum / weight : 0
            }

            // Frequency-dependent gain: compensate for the natural energy distribution
            // in music where bass dominates and highs are weak.
            // This creates the Trap Nation "mountain" shape instead of a flat bass wall.
            //   20-80Hz:    ×2   (sub-bass — strong in music, scale down)
            //   80-300Hz:   ×4   (bass/low-mid — moderate scaling)
            //   300-1000Hz: ×8   (mid — needs boost to be visible)
            //   1000-5000Hz: ×16 (high-mid — very weak, needs big boost)
            const logFreq = Math.log2(freqCenter / 20) // 0 at 20Hz, ~8 at 5kHz
            const freqGain = 2 * Math.pow(2, logFreq * 0.38) // smooth exponential curve

            output[i] = rawMag * freqGain
        }

        return output
    }
}

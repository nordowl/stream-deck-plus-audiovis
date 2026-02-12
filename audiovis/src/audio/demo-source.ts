/**
 * Demo audio source that generates smooth, realistic-looking frequency data
 * without any actual audio capture. Used as default/fallback.
 */
export class DemoAudioSource {
    private phase = 0
    private beatPhase = 0
    private lastBeat = 0
    private beatDecay = 0
    private outputBuf: Float32Array | null = null

    /**
     * Advance time and generate frequency bin data.
     * Reuses a pre-allocated output buffer to avoid per-frame allocations.
     *
     * @param numBins Total number of frequency bins to generate
     * @param deltaTime Time step in seconds
     * @returns Float32Array of normalized amplitude values (0-1) — shared, valid until next call
     */
    getFrequencyData(numBins: number, deltaTime: number): Float32Array {
        if (!this.outputBuf || this.outputBuf.length !== numBins) {
            this.outputBuf = new Float32Array(numBins)
        }
        const bins = this.outputBuf

        this.phase += deltaTime
        this.beatPhase += deltaTime

        const t = this.phase

        // Generate beat pulses at semi-random intervals
        const beatInterval = 0.5 + 0.3 * Math.sin(t * 0.17)
        if (this.beatPhase - this.lastBeat > beatInterval) {
            this.lastBeat = this.beatPhase
            this.beatDecay = 0.6 + 0.4 * Math.random()
        }

        // Exponential beat decay
        const timeSinceBeat = this.beatPhase - this.lastBeat
        const beatIntensity = this.beatDecay * Math.exp(-timeSinceBeat * 5)

        for (let i = 0; i < numBins; i++) {
            const normalizedBin = i / numBins

            // Mountain shape: peaks in the low-mid range, tapers on both ends.
            // This mimics real music spectrum after perceptual weighting.
            // Peak around bin 0.2-0.4 (bass/low-mid), gentle falloff to highs.
            const mountain = Math.exp(-Math.pow((normalizedBin - 0.25) * 2.5, 2)) * 0.6 + 0.15

            // Multiple overlapping sine waves for organic undulation
            let val = 0
            val += 0.18 * Math.sin(t * 1.7 + i * 0.15)
            val += 0.14 * Math.sin(t * 2.3 + i * 0.1)
            val += 0.1 * Math.sin(t * 0.7 + i * 0.18)
            val += 0.08 * Math.sin(t * 3.1 + i * 0.25)
            val += 0.05 * Math.sin(t * 4.7 + i * 0.08)

            // Apply mountain envelope to create Trap Nation shape
            val = (val + 0.5) * mountain

            // Beat impact: bass-heavy pulse that creates the signature "bounce"
            const beatWeight = Math.exp(-normalizedBin * 3.0) * 0.7 + 0.1
            val += beatIntensity * beatWeight * 0.4

            // Slight movement in the highs
            if (normalizedBin > 0.6) {
                val += 0.08 * Math.sin(t * 8.3 + i * 2.1) * (1 - normalizedBin)
            }

            bins[i] = Math.max(0, Math.min(1, val))
        }

        return bins
    }
}

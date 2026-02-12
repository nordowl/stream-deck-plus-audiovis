import { encodePNGToDataURI } from "./png-encoder"

/**
 * Width and height of a single dial's touch strip area.
 */
export const STRIP_WIDTH = 200
export const STRIP_HEIGHT = 100

/**
 * Color stop for gradient interpolation.
 */
interface ColorStop {
    pos: number
    r: number
    g: number
    b: number
}

/**
 * Available color themes for the visualizer.
 */
export const THEMES: Record<string, ColorStop[]> = {
    neon: [
        { pos: 0.0, r: 0, g: 255, b: 220 },
        { pos: 0.35, r: 0, g: 120, b: 255 },
        { pos: 0.65, r: 140, g: 0, b: 255 },
        { pos: 1.0, r: 255, g: 0, b: 140 },
    ],
    classic: [
        { pos: 0.0, r: 0, g: 200, b: 0 },
        { pos: 0.5, r: 220, g: 220, b: 0 },
        { pos: 0.8, r: 255, g: 120, b: 0 },
        { pos: 1.0, r: 255, g: 20, b: 0 },
    ],
    ocean: [
        { pos: 0.0, r: 0, g: 40, b: 120 },
        { pos: 0.4, r: 0, g: 120, b: 255 },
        { pos: 0.75, r: 0, g: 210, b: 255 },
        { pos: 1.0, r: 180, g: 255, b: 255 },
    ],
    fire: [
        { pos: 0.0, r: 120, g: 0, b: 0 },
        { pos: 0.35, r: 220, g: 40, b: 0 },
        { pos: 0.65, r: 255, g: 160, b: 0 },
        { pos: 1.0, r: 255, g: 255, b: 80 },
    ],
    purple: [
        { pos: 0.0, r: 40, g: 0, b: 80 },
        { pos: 0.35, r: 100, g: 0, b: 200 },
        { pos: 0.65, r: 200, g: 50, b: 255 },
        { pos: 1.0, r: 255, g: 150, b: 255 },
    ],
}

export const THEME_NAMES = Object.keys(THEMES)

// ============================================================
// Pre-allocated buffers — reused every frame to avoid GC churn
// ============================================================
const pixelBuffer = new Uint8Array(STRIP_WIDTH * STRIP_HEIGHT * 4)
const curveHeights = new Float32Array(STRIP_WIDTH)

/** Max control points = numBars + 2 anchors */
const MAX_POINTS = 130
const cpX = new Float64Array(MAX_POINTS)
const cpY = new Float64Array(MAX_POINTS)
const cpSlopes = new Float64Array(MAX_POINTS)
const cpTangents = new Float64Array(MAX_POINTS)

// ============================================================
// Cached gradient LUTs (one per theme, built on first use)
// ============================================================
const lutCache = new Map<string, Uint8Array>()

function getGradientLUT(themeName: string, stops: ColorStop[]): Uint8Array {
    let lut = lutCache.get(themeName)
    if (lut) return lut

    lut = new Uint8Array(STRIP_HEIGHT * 3)
    for (let y = 0; y < STRIP_HEIGHT; y++) {
        const t = y / (STRIP_HEIGHT - 1)
        const [r, g, b] = sampleGradient(stops, t)
        lut[y * 3] = r
        lut[y * 3 + 1] = g
        lut[y * 3 + 2] = b
    }
    lutCache.set(themeName, lut)
    return lut
}

/**
 * Interpolate between gradient color stops at a given normalized position.
 */
function sampleGradient(stops: ColorStop[], t: number): [number, number, number] {
    t = Math.max(0, Math.min(1, t))

    let lower = stops[0]
    let upper = stops[stops.length - 1]

    for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i].pos && t <= stops[i + 1].pos) {
            lower = stops[i]
            upper = stops[i + 1]
            break
        }
    }

    const range = upper.pos - lower.pos
    const frac = range === 0 ? 0 : (t - lower.pos) / range

    return [
        Math.round(lower.r + (upper.r - lower.r) * frac),
        Math.round(lower.g + (upper.g - lower.g) * frac),
        Math.round(lower.b + (upper.b - lower.b) * frac),
    ]
}

/**
 * Pre-compute monotone cubic tangents for the current control points.
 * Called once per frame instead of per-pixel.
 */
function precomputeTangents(n: number): void {
    // Slopes
    for (let k = 0; k < n - 1; k++) {
        cpSlopes[k] = (cpY[k + 1] - cpY[k]) / (cpX[k + 1] - cpX[k])
    }
    // Tangents with monotone constraint
    cpTangents[0] = cpSlopes[0]
    cpTangents[n - 1] = cpSlopes[n - 2]
    for (let k = 1; k < n - 1; k++) {
        if (cpSlopes[k - 1] * cpSlopes[k] <= 0) {
            cpTangents[k] = 0
        } else {
            cpTangents[k] = (cpSlopes[k - 1] + cpSlopes[k]) / 2
        }
    }
}

/**
 * Evaluate the pre-computed cubic spline at x.
 * Requires precomputeTangents() to have been called first.
 */
function evalCurve(n: number, x: number): number {
    if (n === 0) return 0
    if (x <= cpX[0]) return cpY[0]
    if (x >= cpX[n - 1]) return cpY[n - 1]

    // Binary search for segment (faster than linear for 34+ points)
    let lo = 0
    let hi = n - 2
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cpX[mid + 1] < x) lo = mid + 1
        else hi = mid
    }
    const i = lo

    const h = cpX[i + 1] - cpX[i]
    if (h === 0) return cpY[i]
    const t = (x - cpX[i]) / h
    const t2 = t * t
    const t3 = t2 * t

    return (
        (2 * t3 - 3 * t2 + 1) * cpY[i] +
        (t3 - 2 * t2 + t) * h * cpTangents[i] +
        (-2 * t3 + 3 * t2) * cpY[i + 1] +
        (t3 - t2) * h * cpTangents[i + 1]
    )
}

/**
 * Render a smooth filled waveform visualizer (Trap Nation style, flat, not mirrored).
 *
 * @param bins Array of normalized frequency bin values (0-1)
 * @param themeName Name of the color theme to use
 * @param numBars Number of data points
 * @param leftEdge Amplitude of the last bin on the dial to the left (0 if first dial)
 * @param rightEdge Amplitude of the first bin on the dial to the right (0 if last dial)
 * @returns Data URI string: "data:image/png;base64,..."
 */
export function renderVisualizerFrame(
    bins: Float32Array,
    themeName: string = "neon",
    numBars: number = 16,
    leftEdge: number = 0,
    rightEdge: number = 0,
): string {
    const theme = THEMES[themeName] ?? THEMES["neon"]
    const gradientLUT = getGradientLUT(themeName, theme)

    // Clear pixel buffer (black transparent)
    pixelBuffer.fill(0)

    // Build control points in pre-allocated arrays
    let nPoints = 0

    // Left edge: use neighbor's last bin value instead of 0
    cpX[nPoints] = 0
    cpY[nPoints] = Math.max(0, Math.min(1, leftEdge))
    nPoints++

    for (let i = 0; i < numBars; i++) {
        cpX[nPoints] = ((i + 0.5) / numBars) * (STRIP_WIDTH - 1)
        cpY[nPoints] = Math.max(0, Math.min(1, bins[i]))
        nPoints++
    }

    // Right edge: use neighbor's first bin value instead of 0
    cpX[nPoints] = STRIP_WIDTH - 1
    cpY[nPoints] = Math.max(0, Math.min(1, rightEdge))
    nPoints++

    // Pre-compute tangents once for all pixels
    precomputeTangents(nPoints)

    // Evaluate curve heights
    const maxH = STRIP_HEIGHT - 4
    for (let x = 0; x < STRIP_WIDTH; x++) {
        const amp = Math.max(0, Math.min(1, evalCurve(nPoints, x)))
        curveHeights[x] = amp * maxH
    }

    // Render: fill below the curve with gradient, add glow at the edge
    for (let x = 0; x < STRIP_WIDTH; x++) {
        const curveH = curveHeights[x]
        const curvePixelH = (curveH + 0.5) | 0 // fast round
        if (curvePixelH <= 0) continue

        const topY = STRIP_HEIGHT - curvePixelH

        // Fill from bottom to curve
        for (let y = STRIP_HEIGHT - 1; y >= topY && y >= 0; y--) {
            const distFromBottom = STRIP_HEIGHT - 1 - y
            const lutIdx = (((distFromBottom * 99) / 99 + 0.5) | 0) * 3 // normalized height -> LUT

            const r = gradientLUT[lutIdx]
            const g = gradientLUT[lutIdx + 1]
            const b = gradientLUT[lutIdx + 2]

            const bottomFade = distFromBottom < 3 ? (distFromBottom + 1) * 0.25 : 1.0

            const idx = (y * STRIP_WIDTH + x) * 4
            pixelBuffer[idx] = (r * bottomFade + 0.5) | 0
            pixelBuffer[idx + 1] = (g * bottomFade + 0.5) | 0
            pixelBuffer[idx + 2] = (b * bottomFade + 0.5) | 0
            pixelBuffer[idx + 3] = 255
        }

        // Bright glow edge at the top of the curve (3px)
        const normH = ((curveH / 99) * 99 + 0.5) | 0
        const glowLutIdx = normH * 3
        const gr = gradientLUT[glowLutIdx]
        const gg = gradientLUT[glowLutIdx + 1]
        const gb = gradientLUT[glowLutIdx + 2]

        for (let g_row = 0; g_row < 3; g_row++) {
            const gy = topY + g_row
            if (gy < 0 || gy >= STRIP_HEIGHT) continue

            const brightness = g_row === 0 ? 1.6 : g_row === 1 ? 1.3 : 1.1
            const idx = (gy * STRIP_WIDTH + x) * 4
            pixelBuffer[idx] = Math.min(255, (gr * brightness + 0.5) | 0)
            pixelBuffer[idx + 1] = Math.min(255, (gg * brightness + 0.5) | 0)
            pixelBuffer[idx + 2] = Math.min(255, (gb * brightness + 0.5) | 0)
            pixelBuffer[idx + 3] = 255
        }
    }

    // Encode as compressed PNG and return data URI (inline base64, no intermediate strings)
    return encodePNGToDataURI(STRIP_WIDTH, STRIP_HEIGHT, pixelBuffer)
}

import {
    action,
    DialRotateEvent,
    SingletonAction,
    TouchTapEvent,
    WillAppearEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck"
import streamDeck from "@elgato/streamdeck"
import { audioEngine } from "../audio/audio-engine"

const logger = streamDeck.logger.createScope("AudioVisualizer")

/**
 * Settings persisted for each visualizer action instance.
 */
type VisualizerSettings = {
    gain?: number
    theme?: string
}

/**
 * Audio Visualizer action for Stream Deck + dials.
 *
 * Each instance renders a portion of the frequency spectrum on its dial's
 * touch strip area. Place on all 4 dials (left to right) to create a
 * full-width audio visualizer across the entire touch strip.
 *
 * - Dial 1 (column 0): Bass frequencies
 * - Dial 2 (column 1): Low-mid frequencies
 * - Dial 3 (column 2): Mid-high frequencies
 * - Dial 4 (column 3): Treble frequencies
 *
 * Controls:
 * - Rotate dial: Adjust gain/sensitivity
 * - Touch: Cycle color theme
 */
@action({ UUID: "com.nordowl.audiovis.visualizer" })
export class AudioVisualizerAction extends SingletonAction<VisualizerSettings> {
    /**
     * Called when the action becomes visible on a dial.
     * Registers with the audio engine to start receiving visualizer frames.
     */
    override onWillAppear(ev: WillAppearEvent<VisualizerSettings>): void {
        if (!ev.action.isDial()) return

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const column = (ev.payload as any).coordinates?.column ?? 0
        const actionId = ev.action.id

        logger.info(`Visualizer appeared: id=${actionId}, column=${column}`)

        // Restore settings
        const { settings } = ev.payload
        if (settings.gain != null) {
            audioEngine.adjustGain(settings.gain - audioEngine.currentGain)
        }

        // Set the custom layout
        ev.action.setFeedbackLayout("layouts/visualizer-layout.json")

        // Set trigger descriptions
        ev.action.setTriggerDescription({
            rotate: "Adjust gain",
            touch: "Change theme",
        })

        // Register with engine
        audioEngine.registerAction(actionId, ev.action, column)
    }

    /**
     * Called when the action disappears from a dial.
     * Unregisters from the audio engine.
     */
    override onWillDisappear(ev: WillDisappearEvent<VisualizerSettings>): void {
        const actionId = ev.action.id
        audioEngine.unregisterAction(actionId)
        logger.info(`Visualizer disappeared: id=${actionId}`)
    }

    /**
     * Handle dial rotation to adjust gain/sensitivity.
     */
    override async onDialRotate(ev: DialRotateEvent<VisualizerSettings>): Promise<void> {
        const delta = ev.payload.ticks * 0.05
        audioEngine.adjustGain(delta)

        // Persist gain setting
        const settings = ev.payload.settings
        settings.gain = audioEngine.currentGain
        await ev.action.setSettings(settings)
    }

    /**
     * Handle touch tap to cycle color themes.
     */
    override async onTouchTap(ev: TouchTapEvent<VisualizerSettings>): Promise<void> {
        audioEngine.nextTheme()

        // Persist theme setting
        const settings = ev.payload.settings
        settings.theme = audioEngine.currentTheme
        await ev.action.setSettings(settings)
    }
}

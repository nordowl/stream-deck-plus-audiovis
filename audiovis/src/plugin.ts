import streamDeck from "@elgato/streamdeck"

import { AudioVisualizerAction } from "./actions/audio-visualizer"

// Enable trace logging for development
streamDeck.logger.setLevel("trace")

// Register the audio visualizer action.
// Users assign this single action to 1-4 dials on the Stream Deck +.
// Each instance auto-detects its column position and renders the
// corresponding frequency range of the visualizer.
streamDeck.actions.registerAction(new AudioVisualizerAction())

// Connect to the Stream Deck.
streamDeck.connect()

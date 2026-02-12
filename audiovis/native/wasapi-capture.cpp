/**
 * WASAPI Loopback Audio Capture
 *
 * Captures system audio output via Windows WASAPI loopback mode
 * and writes raw float32 PCM samples to stdout for the Node.js
 * Stream Deck plugin to consume.
 *
 * Build with MSVC (Visual Studio Developer Command Prompt):
 *   cl /EHsc /O2 wasapi-capture.cpp /link ole32.lib
 *
 * Build with MinGW:
 *   g++ -O2 -o wasapi-capture.exe wasapi-capture.cpp -lole32 -loleaut32 -lksuser
 *
 * The output binary should be placed in:
 *   com.nordowl.audiovis.sdPlugin/bin/wasapi-capture.exe
 */

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// WASAPI GUID definitions
const CLSID CLSID_MMDeviceEnumerator = __uuidof(MMDeviceEnumerator);
const IID IID_IMMDeviceEnumerator = __uuidof(IMMDeviceEnumerator);
const IID IID_IAudioClient = __uuidof(IAudioClient);
const IID IID_IAudioCaptureClient = __uuidof(IAudioCaptureClient);

#define SAFE_RELEASE(p) if (p) { (p)->Release(); (p) = nullptr; }
#define CHECK_HR(hr, msg) if (FAILED(hr)) { fprintf(stderr, "Error: %s (0x%08x)\n", msg, hr); goto cleanup; }

int main() {
    // Set stdout to binary mode
    _setmode(_fileno(stdout), _O_BINARY);

    HRESULT hr;
    IMMDeviceEnumerator* pEnumerator = nullptr;
    IMMDevice* pDevice = nullptr;
    IAudioClient* pAudioClient = nullptr;
    IAudioCaptureClient* pCaptureClient = nullptr;
    WAVEFORMATEX* pwfx = nullptr;
    UINT32 bufferFrameCount;
    UINT32 packetLength;
    BYTE* pData;
    UINT32 numFramesAvailable;
    DWORD flags;

    // Initialize COM
    hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    CHECK_HR(hr, "CoInitializeEx");

    // Create device enumerator
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr,
                         CLSCTX_ALL, IID_IMMDeviceEnumerator,
                         (void**)&pEnumerator);
    CHECK_HR(hr, "CoCreateInstance MMDeviceEnumerator");

    // Get default audio output device (render device for loopback)
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    CHECK_HR(hr, "GetDefaultAudioEndpoint");

    // Activate audio client
    hr = pDevice->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr, (void**)&pAudioClient);
    CHECK_HR(hr, "Activate IAudioClient");

    // Get mix format
    hr = pAudioClient->GetMixFormat(&pwfx);
    CHECK_HR(hr, "GetMixFormat");

    // Log format info to stderr
    fprintf(stderr, "Format: %d channels, %d Hz, %d bits\n",
            pwfx->nChannels, pwfx->nSamplesPerSec, pwfx->wBitsPerSample);

    // Initialize audio client in loopback mode
    // AUDCLNT_STREAMFLAGS_LOOPBACK captures the render stream
    hr = pAudioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        10000000,  // 1 second buffer (in 100ns units)
        0,
        pwfx,
        nullptr
    );
    CHECK_HR(hr, "Initialize AudioClient");

    // Get buffer size
    hr = pAudioClient->GetBufferSize(&bufferFrameCount);
    CHECK_HR(hr, "GetBufferSize");

    // Get capture client
    hr = pAudioClient->GetService(IID_IAudioCaptureClient, (void**)&pCaptureClient);
    CHECK_HR(hr, "GetService IAudioCaptureClient");

    // Start capturing
    hr = pAudioClient->Start();
    CHECK_HR(hr, "Start");

    fprintf(stderr, "Capturing audio (loopback)...\n");

    // Capture loop
    while (true) {
        // Sleep for half the buffer duration
        Sleep(10);

        // Get next packet
        hr = pCaptureClient->GetNextPacketSize(&packetLength);
        if (FAILED(hr)) break;

        while (packetLength > 0) {
            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // Write silence (zeros)
                float zero = 0.0f;
                for (UINT32 i = 0; i < numFramesAvailable; i++) {
                    fwrite(&zero, sizeof(float), 1, stdout);
                }
            } else {
                // pData contains interleaved float32 samples
                // We output mono by averaging channels, or just the first channel
                UINT32 channels = pwfx->nChannels;
                float* floatData = (float*)pData;

                for (UINT32 i = 0; i < numFramesAvailable; i++) {
                    // Average all channels to mono
                    float mono = 0.0f;
                    for (UINT32 ch = 0; ch < channels; ch++) {
                        mono += floatData[i * channels + ch];
                    }
                    mono /= (float)channels;
                    fwrite(&mono, sizeof(float), 1, stdout);
                }
            }
            fflush(stdout);

            hr = pCaptureClient->ReleaseBuffer(numFramesAvailable);
            if (FAILED(hr)) break;

            hr = pCaptureClient->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) break;
        }
    }

cleanup:
    if (pAudioClient) pAudioClient->Stop();
    SAFE_RELEASE(pCaptureClient);
    SAFE_RELEASE(pAudioClient);
    SAFE_RELEASE(pDevice);
    SAFE_RELEASE(pEnumerator);
    if (pwfx) CoTaskMemFree(pwfx);
    CoUninitialize();

    return 0;
}
